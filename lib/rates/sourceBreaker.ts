import {
  BREAKER_BACKOFF_MULTIPLIER,
  BREAKER_BASE_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_FAILURE_WINDOW_MS,
  BREAKER_HALF_OPEN_FAILURES_BEFORE_REOPEN,
  BREAKER_HALF_OPEN_MAX_PROBES,
  BREAKER_MAX_COOLDOWN_MS,
  BREAKER_PROBE_TIMEOUT_MS,
  BREAKER_STATE_TTL_MS,
} from "@/constants/rates";
import type {
  SourceBreakerGateDecision,
  SourceBreakerRow,
  SourceFailureKind,
} from "@/types/rates";

/**
 * Issue #167: pure per-source circuit-breaker policy for reviewed live-rate
 * sources. Everything here is deterministic time-and-value math with no I/O,
 * so transitions are fully unit-testable and identical on every instance.
 *
 * Policy invariants:
 * - Only transport/service failures (network, HTTP, persistence outage) open
 *   the breaker. Invalid-evidence failures (schema-validated quote payload
 *   rejection) never open it: repeated invalid evidence means a broken
 *   publisher, not an unavailable one, and suppressing it behind a cooldown
 *   would hide a persistent evidence-quality problem.
 * - Opening and reopening use a bounded exponential cooldown so a flapping
 *   source cannot hammer the endpoint forever.
 * - HALF_OPEN admits at most one concurrent recovery probe, enforced by an
 *   atomic durable claim; a probe result always produces a deterministic
 *   next state.
 */

export type ClassifiedEngineFailure = Readonly<{
  kind: SourceFailureKind;
  reason: string;
}>;

/**
 * Separates transport/service failures from invalid-evidence failures.
 * Normalization is schema-validated, so a thrown `RateNormalizationError`
 * means the endpoint returned evidence that cannot become an observation.
 * Persistence failures are transport-class: they suppress the source while
 * the store is unavailable, but never corrupt evidence.
 */
export function classifyEngineFailure(
  phase: "QUOTE" | "NORMALIZATION" | "PERSISTENCE",
  code: string,
): ClassifiedEngineFailure {
  if (phase === "NORMALIZATION") {
    return Object.freeze({
      kind: "INVALID_EVIDENCE",
      reason: `invalid_evidence:${code}`,
    });
  }
  return Object.freeze({
    kind: "TRANSPORT_OR_SERVICE",
    reason: `${phase.toLowerCase()}_failure:${code}`,
  });
}

const EMPTY_BREAKER_ROW: SourceBreakerRow = Object.freeze({
  state: "CLOSED",
  consecutiveTransportFailures: 0,
  consecutiveOpens: 0,
  recentInvalidEvidenceFailures: 0,
  openAt: null,
  cooldownUntil: null,
  recoveryProbeToken: null,
  recoveryProbeDeadline: null,
  recoveryProbesActive: 0,
  windowStartAt: new Date(0),
  lastFailureAt: null,
  lastSuccessAt: null,
});

/**
 * A durable row that has observed no failure or success for the state TTL is
 * treated as CLOSED again. This makes restarts safe: a stale OPEN row from a
 * long-gone incident cannot suppress a healthy source forever, and the reset
 * is derived from durable timestamps rather than process memory.
 */
export function effectiveState(
  row: SourceBreakerRow | null,
  now: Date,
): SourceBreakerRow {
  if (!row) return EMPTY_BREAKER_ROW;
  if (row.state === "CLOSED") return row;
  const lastEventAt = latestDate([row.lastFailureAt, row.lastSuccessAt, row.openAt]);
  if (now.getTime() - lastEventAt.getTime() >= BREAKER_STATE_TTL_MS) {
    return Object.freeze({ ...row, state: "CLOSED" });
  }
  return row;
}

/**
 * Decides whether the engine may attempt this source right now. An OPEN
 * breaker whose cooldown has elapsed signals a recovery-probe attempt: the
 * caller must still win the atomic single-probe claim before any network
 * work, so losing the race is a safe suppression for that run.
 */
export function gateSource(
  row: SourceBreakerRow | null,
  now: Date,
): SourceBreakerGateDecision {
  const state = effectiveState(row, now).state;

  if (state === "CLOSED") {
    return Object.freeze({ allowed: true });
  }

  if (state === "OPEN") {
    const cooldownUntil = row?.cooldownUntil ?? null;
    if (cooldownUntil === null || cooldownUntil.getTime() > now.getTime()) {
      return Object.freeze({
        allowed: false,
        suppressed: Object.freeze({
          state: "OPEN",
          reason: "BREAKER_OPEN",
          cooldownRemainingMs: cooldownUntil === null
            ? null
            : Math.max(0, cooldownUntil.getTime() - now.getTime()),
        }),
      });
    }
    return Object.freeze({
      allowed: true,
      recoveryProbe: Object.freeze({
        deadline: new Date(now.getTime() + BREAKER_PROBE_TIMEOUT_MS),
      }),
    });
  }

  // HALF_OPEN: a probe is already in flight. While its claim is live, no
  // further probe may fan out; an expired probe is expired exactly once and
  // the cooldown restarts instead of issuing another immediate probe.
  if (isRecoveryProbeLive(row, now)) {
    return Object.freeze({
      allowed: false,
      suppressed: Object.freeze({
        state: "HALF_OPEN",
        reason: "RECOVERY_PROBE_LIMIT",
        cooldownRemainingMs: null,
      }),
    });
  }
  return Object.freeze({
    allowed: false,
    suppressed: Object.freeze({
      state: "HALF_OPEN",
      reason: "PROBE_TIMEOUT",
      cooldownRemainingMs: null,
    }),
  });
}

/**
 * The atomic single-probe claim as a pure decision: returns the HALF_OPEN
 * row to persist when the claim may be granted, or null when the durable
 * state does not admit a probe. The store applies this inside a guarded
 * write so concurrent instances cannot fan out probes.
 */
export function claimRecoveryProbe(
  row: SourceBreakerRow | null,
  input: Readonly<{ token: string; now: Date; deadline: Date }>,
): SourceBreakerRow | null {
  const current = effectiveState(row, input.now);
  if (current.state !== "OPEN") return null;
  const cooldownUntil = current.cooldownUntil;
  if (cooldownUntil === null || cooldownUntil.getTime() > input.now.getTime()) {
    return null;
  }
  if (current.recoveryProbesActive >= BREAKER_HALF_OPEN_MAX_PROBES) return null;
  return Object.freeze({
    ...current,
    state: "HALF_OPEN",
    recoveryProbeToken: input.token,
    recoveryProbeDeadline: input.deadline,
    recoveryProbesActive: current.recoveryProbesActive + 1,
  });
}

/** True while a HALF_OPEN probe claim is still inside its deadline. */
export function isRecoveryProbeLive(
  row: SourceBreakerRow | null,
  now: Date,
): boolean {
  if (!row || row.state !== "HALF_OPEN") return false;
  return (
    row.recoveryProbesActive > 0 &&
    row.recoveryProbeDeadline !== null &&
    row.recoveryProbeDeadline.getTime() > now.getTime()
  );
}

/**
 * The transition for a probe whose result never arrived (crashed worker,
 * lost claim): the breaker returns to OPEN with the next cooldown step so
 * recovery stays bounded without another immediate fan-out.
 */
export function expireRecoveryProbe(
  row: SourceBreakerRow,
  now: Date,
): { next: SourceBreakerRow; event: "RECOVERY_PROBE_TIMEOUT" } {
  const reopened = openRow(row, now);
  return {
    next: reopened,
    event: "RECOVERY_PROBE_TIMEOUT",
  };
}

/**
 * Records one classified engine failure and returns the next durable row
 * plus any transition event. Pure: the caller persists `next` atomically.
 */
export function applyFailure(
  row: SourceBreakerRow | null,
  failure: ClassifiedEngineFailure,
  now: Date,
): { next: SourceBreakerRow; event: "OPENED" | "REOPENED" | null } {
  const current = effectiveState(row, now);
  const windowStartAt = windowStartFor(current, now);

  if (failure.kind === "INVALID_EVIDENCE") {
    // Invalid evidence counts toward transparent diagnostics but never opens
    // the breaker, so breaker state can never upgrade bad evidence into good.
    return {
      next: Object.freeze({
        ...current,
        recentInvalidEvidenceFailures: current.recentInvalidEvidenceFailures + 1,
        windowStartAt,
        lastFailureAt: now,
      }),
      event: null,
    };
  }

  if (current.state === "HALF_OPEN") {
    // The probe starts a clean slate: prior failure counts were flushed when
    // the breaker opened, so half-open failures count from zero.
    const failures = current.consecutiveTransportFailures + 1;
    if (failures >= BREAKER_HALF_OPEN_FAILURES_BEFORE_REOPEN) {
      return {
        next: openRow(
          Object.freeze({ ...current, consecutiveTransportFailures: failures }),
          now,
        ),
        event: "REOPENED",
      };
    }
    return {
      next: Object.freeze({
        ...current,
        consecutiveTransportFailures: failures,
        lastFailureAt: now,
      }),
      event: null,
    };
  }

  if (current.state === "OPEN") {
    // Only reachable through rare cross-instance timing; keep counters
    // accurate without restarting a cooldown that is already running.
    return {
      next: Object.freeze({
        ...current,
        consecutiveTransportFailures: current.consecutiveTransportFailures + 1,
        lastFailureAt: now,
      }),
      event: null,
    };
  }

  const failures = consecutiveFailuresFor(current, now) + 1;
  if (failures >= BREAKER_FAILURE_THRESHOLD) {
    return {
      next: openRow(
        Object.freeze({ ...current, consecutiveTransportFailures: failures }),
        now,
      ),
      event: "OPENED",
    };
  }
  return {
    next: Object.freeze({
      ...current,
      consecutiveTransportFailures: failures,
      windowStartAt,
      lastFailureAt: now,
    }),
    event: null,
  };
}

/**
 * Records a success. In HALF_OPEN that is a successful recovery probe and
 * deterministically restores CLOSED operation; otherwise it clears the
 * consecutive-failure counters and any suppression state.
 */
export function applySuccess(
  row: SourceBreakerRow | null,
  now: Date,
): { next: SourceBreakerRow; event: "RECOVERED" | null } {
  const current = effectiveState(row, now);
  if (current.state === "HALF_OPEN") {
    return {
      next: Object.freeze({
        ...EMPTY_BREAKER_ROW,
        windowStartAt: now,
        lastSuccessAt: now,
      }),
      event: "RECOVERED",
    };
  }
  return {
    next: Object.freeze({
      ...EMPTY_BREAKER_ROW,
      windowStartAt: current.windowStartAt,
      lastSuccessAt: now,
    }),
    event: null,
  };
}

/**
 * The bounded exponential cooldown: base × multiplier^(opens-1), capped at
 * the configured maximum. `consecutiveOpens` counts openings since the last
 * success, so backoff escalates across reopen cycles and resets on recovery.
 */
export function cooldownFor(consecutiveOpens: number): number {
  const exponent = Math.max(0, consecutiveOpens - 1);
  const raw = BREAKER_BASE_COOLDOWN_MS * BREAKER_BACKOFF_MULTIPLIER ** exponent;
  return Math.min(raw, BREAKER_MAX_COOLDOWN_MS);
}

function openRow(current: SourceBreakerRow, now: Date): SourceBreakerRow {
  const consecutiveOpens = current.consecutiveOpens + 1;
  return Object.freeze({
    state: "OPEN",
    // The threshold that opened the breaker is captured by consecutiveOpens;
    // half-open probe failures must count from zero, not inherit it.
    consecutiveTransportFailures: 0,
    consecutiveOpens,
    recentInvalidEvidenceFailures: current.recentInvalidEvidenceFailures,
    openAt: now,
    cooldownUntil: new Date(now.getTime() + cooldownFor(consecutiveOpens)),
    recoveryProbeToken: null,
    recoveryProbeDeadline: null,
    recoveryProbesActive: 0,
    windowStartAt: current.windowStartAt,
    lastFailureAt: now,
    lastSuccessAt: current.lastSuccessAt,
  });
}

/**
 * Failure counting is windowed: consecutive transport failures inside the
 * sliding window accumulate toward the threshold; a failure outside the
 * window restarts both the count and the window so ancient incidents cannot
 * open a breaker.
 */
function windowStartFor(current: SourceBreakerRow, now: Date): Date {
  const windowStart = now.getTime() - BREAKER_FAILURE_WINDOW_MS;
  const lastFailure = current.lastFailureAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (lastFailure < windowStart) return now;
  return current.windowStartAt.getTime() < windowStart ? now : current.windowStartAt;
}

/**
 * A failure outside the window restarts the consecutive count together with
 * the window, keeping the two in lockstep.
 */
function consecutiveFailuresFor(current: SourceBreakerRow, now: Date): number {
  const windowStart = now.getTime() - BREAKER_FAILURE_WINDOW_MS;
  const lastFailure = current.lastFailureAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return lastFailure < windowStart ? 0 : current.consecutiveTransportFailures;
}

function latestDate(dates: readonly (Date | null)[]): Date {
  return dates.reduce<Date>(
    (latest, value) => (value !== null && value.getTime() > latest.getTime() ? value : latest),
    new Date(0),
  );
}
