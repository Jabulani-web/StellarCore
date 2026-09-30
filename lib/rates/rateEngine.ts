import { randomUUID } from "node:crypto";

import { normalizeIndicativeRate, RateNormalizationError } from "@/lib/rates/normalize";
import {
  applyFailure,
  applySuccess,
  classifyEngineFailure,
  expireRecoveryProbe,
  gateSource,
} from "@/lib/rates/sourceBreaker";
import { persistRateSnapshot } from "@/lib/rates/snapshot";
import type {
  RateCandidate,
  RateEngineBreakerEvent,
  RateEngineFailure,
  RateEngineResult,
  RateEngineSkippedSource,
  RateQuoteProvider,
  RateSnapshotRepository,
  SourceBreakerRow,
  SourceBreakerStore,
  SourceIdentityKey,
} from "@/types/rates";

export async function runRateEngine(
  candidates: readonly RateCandidate[],
  dependencies: Readonly<{
    quote: RateQuoteProvider;
    repository: RateSnapshotRepository;
    now?: () => Date;
    /**
     * Issue #167: durable per-source circuit-breaker store. Optional so the
     * engine stays testable; production wiring always supplies one.
     */
    breaker?: SourceBreakerStore;
  }>,
): Promise<RateEngineResult> {
  const seen = new Set<string>();
  const snapshots: RateEngineResult["snapshots"][number][] = [];
  const failures: RateEngineFailure[] = [];
  const skippedSources: RateEngineSkippedSource[] = [];
  const breakerEvents: RateEngineBreakerEvent[] = [];
  let totalAttempted = 0;

  for (const candidate of candidates) {
    const key = `${candidate.anchorSlug}\0${candidate.corridor.slug}`;
    if (seen.has(key)) {
      skippedSources.push(Object.freeze({
        anchorSlug: candidate.anchorSlug,
        corridorSlug: candidate.corridor.slug,
        reason: "DUPLICATE_CANDIDATE",
      }));
      continue;
    }
    seen.add(key);

    const identity: SourceIdentityKey = Object.freeze({
      anchorSlug: candidate.anchorSlug,
      corridorSlug: candidate.corridor.slug,
    });
    const gate = await gateCandidate(dependencies, identity, breakerEvents);
    if (!gate.allowed) {
      // A breaker-suppressed source is skipped without any network attempt
      // and without persisting an observation; the skip is surfaced as
      // breaker state, never as a fresh rate observation.
      skippedSources.push(Object.freeze({
        anchorSlug: candidate.anchorSlug,
        corridorSlug: candidate.corridor.slug,
        reason: gate.reason,
      }));
      continue;
    }
    totalAttempted += 1;

    let quote;
    try {
      quote = await dependencies.quote(candidate);
    } catch {
      failures.push(engineFailure(candidate, "QUOTE", "QUOTE_FAILURE"));
      await recordFailure(dependencies, identity, gate.row, "QUOTE", "QUOTE_FAILURE", breakerEvents);
      continue;
    }

    let observation;
    try {
      observation = normalizeIndicativeRate({
        anchorSlug: candidate.anchorSlug,
        corridor: candidate.corridor,
        quote,
        capturedAt: dependencies.now?.() ?? new Date(),
      });
    } catch (error) {
      const code = error instanceof RateNormalizationError
        ? error.code
        : "NORMALIZATION_FAILURE";
      failures.push(engineFailure(candidate, "NORMALIZATION", code));
      await recordFailure(dependencies, identity, gate.row, "NORMALIZATION", code, breakerEvents);
      continue;
    }

    const persisted = await persistRateSnapshot(observation, dependencies.repository);
    if (!persisted.ok) {
      failures.push(engineFailure(candidate, "PERSISTENCE", persisted.code));
      await recordFailure(dependencies, identity, gate.row, "PERSISTENCE", persisted.code, breakerEvents);
      continue;
    }
    await recordSuccess(dependencies, identity, gate.row, breakerEvents);
    snapshots.push(persisted.snapshot);
  }

  return Object.freeze({
    totalCandidates: candidates.length,
    totalAttempted,
    succeeded: snapshots.length,
    failed: failures.length,
    skipped: skippedSources.length,
    snapshotsPersisted: snapshots.length,
    snapshots: Object.freeze(snapshots),
    failures: Object.freeze(failures),
    skippedSources: Object.freeze(skippedSources),
    breakerEvents: Object.freeze(breakerEvents),
  });
}

type GateOutcome =
  | Readonly<{ allowed: true; row: Awaited<ReturnType<SourceBreakerStore["find"]>> }>
  | Readonly<{ allowed: false; reason: "BREAKER_OPEN" | "RECOVERY_PROBE_LIMIT" | "PROBE_TIMEOUT" }>;

/**
 * Consults the durable breaker before any network work. Fail-open: if the
 * breaker store is unavailable, the source is attempted exactly as before
 * the breaker existed, so evidence collection never regresses.
 */
async function gateCandidate(
  dependencies: Readonly<{
    now?: () => Date;
    breaker?: SourceBreakerStore;
  }>,
  identity: SourceIdentityKey,
  events: RateEngineBreakerEvent[],
): Promise<GateOutcome> {
  const breaker = dependencies.breaker;
  const now = dependencies.now?.() ?? new Date();
  if (!breaker) return Object.freeze({ allowed: true, row: null });

  try {
    const row = await breaker.find(identity);
    const gate = gateSource(row, now);

    if (gate.allowed) {
      if (!gate.recoveryProbe) return Object.freeze({ allowed: true, row });

      // OPEN with an elapsed cooldown: try to win the single recovery-probe
      // claim atomically. Losing the race is a safe suppression for this run.
      const token = randomUUID();
      const deadline = gate.recoveryProbe.deadline;
      const claimed = await breaker.claimRecoveryProbe(identity, { token, now, deadline });
      if (!claimed) {
        return Object.freeze({ allowed: false, reason: "RECOVERY_PROBE_LIMIT" });
      }
      events.push(Object.freeze({
        anchorSlug: identity.anchorSlug,
        corridorSlug: identity.corridorSlug,
        kind: "RECOVERY_PROBE_GRANTED",
        state: "HALF_OPEN",
        cooldownUntil: null,
      }));
      const claimedRow: SourceBreakerRow = {
        state: "HALF_OPEN",
        consecutiveTransportFailures: row?.consecutiveTransportFailures ?? 0,
        consecutiveOpens: row?.consecutiveOpens ?? 0,
        recentInvalidEvidenceFailures: row?.recentInvalidEvidenceFailures ?? 0,
        openAt: row?.openAt ?? null,
        cooldownUntil: row?.cooldownUntil ?? null,
        recoveryProbeToken: token,
        recoveryProbeDeadline: deadline,
        recoveryProbesActive: 1,
        windowStartAt: row?.windowStartAt ?? now,
        lastFailureAt: row?.lastFailureAt ?? null,
        lastSuccessAt: row?.lastSuccessAt ?? null,
      };
      return Object.freeze({ allowed: true, row: claimedRow });
    }

    const suppressed = gate.suppressed!;
    if (suppressed.reason === "PROBE_TIMEOUT") {
      // Expire the dead probe exactly once so the breaker returns to OPEN
      // with the next cooldown step instead of staying HALF_OPEN forever.
      const expired = expireRecoveryProbe(row!, now);
      await breaker.applyTransition(identity, { row, next: expired.next });
      events.push(Object.freeze({
        anchorSlug: identity.anchorSlug,
        corridorSlug: identity.corridorSlug,
        kind: expired.event,
        state: expired.next.state,
        cooldownUntil: expired.next.cooldownUntil?.toISOString() ?? null,
        reason: "recovery_probe_deadline_elapsed",
      }));
    }
    return Object.freeze({ allowed: false, reason: suppressed.reason });
  } catch {
    return Object.freeze({ allowed: true, row: null });
  }
}

async function recordFailure(
  dependencies: Readonly<{ now?: () => Date; breaker?: SourceBreakerStore }>,
  identity: SourceIdentityKey,
  row: Awaited<ReturnType<SourceBreakerStore["find"]>>,
  phase: "QUOTE" | "NORMALIZATION" | "PERSISTENCE",
  code: string,
  events: RateEngineBreakerEvent[],
): Promise<void> {
  const breaker = dependencies.breaker;
  if (!breaker) return;
  try {
    const now = dependencies.now?.() ?? new Date();
    const classified = classifyEngineFailure(phase, code);
    const outcome = applyFailure(row, classified, now);
    await breaker.applyTransition(identity, { row, next: outcome.next });
    if (outcome.event !== null) {
      events.push(Object.freeze({
        anchorSlug: identity.anchorSlug,
        corridorSlug: identity.corridorSlug,
        kind: outcome.event,
        state: outcome.next.state,
        cooldownUntil: outcome.next.cooldownUntil?.toISOString() ?? null,
        reason: classified.reason,
      }));
    }
  } catch {
    // Fail-open: a breaker-store outage must not mask the recorded engine
    // failure or abort the remaining sources.
  }
}

async function recordSuccess(
  dependencies: Readonly<{ now?: () => Date; breaker?: SourceBreakerStore }>,
  identity: SourceIdentityKey,
  row: Awaited<ReturnType<SourceBreakerStore["find"]>>,
  events: RateEngineBreakerEvent[],
): Promise<void> {
  const breaker = dependencies.breaker;
  if (!breaker) return;
  try {
    const now = dependencies.now?.() ?? new Date();
    const outcome = applySuccess(row, now);
    await breaker.applyTransition(identity, { row, next: outcome.next });
    if (outcome.event !== null) {
      events.push(Object.freeze({
        anchorSlug: identity.anchorSlug,
        corridorSlug: identity.corridorSlug,
        kind: outcome.event,
        state: outcome.next.state,
        cooldownUntil: null,
      }));
    }
  } catch {
    // Fail-open, mirroring recordFailure.
  }
}

function engineFailure(
  candidate: RateCandidate,
  phase: RateEngineFailure["phase"],
  code: string,
): RateEngineFailure {
  return Object.freeze({
    anchorSlug: candidate.anchorSlug,
    corridorSlug: candidate.corridor.slug,
    phase,
    code,
  });
}
