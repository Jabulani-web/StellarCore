import type {
  SourceBreakerRow,
  SourceBreakerStore,
  SourceIdentityKey,
} from "@/types/rates";

/**
 * Issue #167: durable per-source circuit-breaker state.
 *
 * Concurrency model — all transitions are serialized through guarded writes
 * so two scheduler instances cannot both grant the single recovery probe or
 * both open the breaker from the same row:
 * - `claimRecoveryProbe` is a single UPDATE whose WHERE clause admits the
 *   write only when the durable state still admits a probe (OPEN, cooldown
 *   elapsed, no live claim). Exactly one racing UPDATE matches; the loser
 *   updates zero rows and this run stays suppressed.
 * - `applyTransition` re-checks the expected durable state in its WHERE
 *   clause, so a transition computed from a stale read is discarded rather
 *   than clobbering a fresher state written by another worker.
 *
 * The engine treats any store error as CLOSED (fail-open) so a breaker-store
 * outage degrades to today's behavior: every source is attempted, and the
 * run summary keeps recording failures as before.
 */

export function createInMemorySourceBreakerStore(): SourceBreakerStore {
  const rows = new Map<string, SourceBreakerRow>();
  const keyOf = (identity: SourceIdentityKey) =>
    `${identity.anchorSlug}\u0000${identity.corridorSlug}`;

  return Object.freeze({
    async find(identity) {
      return rows.get(keyOf(identity)) ?? null;
    },
    async claimRecoveryProbe(identity, input) {
      const current = rows.get(keyOf(identity)) ?? null;
      if (current === null || current.state !== "OPEN") return false;
      if (
        current.cooldownUntil === null ||
        current.cooldownUntil.getTime() > input.now.getTime()
      ) {
        return false;
      }
      if (current.recoveryProbesActive > 0) return false;
      rows.set(keyOf(identity), {
        ...current,
        state: "HALF_OPEN",
        recoveryProbeToken: input.token,
        recoveryProbeDeadline: input.deadline,
        recoveryProbesActive: 1,
      });
      return true;
    },
    async applyTransition(identity, { row, next }) {
      const key = keyOf(identity);
      const stored = rows.get(key) ?? null;
      const expectedToken = row === null ? null : row.recoveryProbeToken;
      if (
        (stored === null && row !== null) ||
        (stored !== null && row === null) ||
        (stored !== null &&
          row !== null &&
          stored.recoveryProbeToken !== expectedToken)
      ) {
        return;
      }
      rows.set(key, next);
    },
  });
}

export function rowFromPersistence(
  persisted: {
    state: string;
    consecutiveTransportFailures: number;
    consecutiveOpens: number;
    recentInvalidEvidenceFailures: number;
    openAt: Date | null;
    cooldownUntil: Date | null;
    recoveryProbeToken: string | null;
    recoveryProbeDeadline: Date | null;
    recoveryProbesActive: number;
    windowStartAt: Date;
    lastFailureAt: Date | null;
    lastSuccessAt: Date | null;
  },
): SourceBreakerRow {
  return {
    state: persisted.state as SourceBreakerRow["state"],
    consecutiveTransportFailures: persisted.consecutiveTransportFailures,
    consecutiveOpens: persisted.consecutiveOpens,
    recentInvalidEvidenceFailures: persisted.recentInvalidEvidenceFailures,
    openAt: persisted.openAt,
    cooldownUntil: persisted.cooldownUntil,
    recoveryProbeToken: persisted.recoveryProbeToken,
    recoveryProbeDeadline: persisted.recoveryProbeDeadline,
    recoveryProbesActive: persisted.recoveryProbesActive,
    windowStartAt: persisted.windowStartAt,
    lastFailureAt: persisted.lastFailureAt,
    lastSuccessAt: persisted.lastSuccessAt,
  };
}

/**
 * The production store. Dynamically imports the Prisma client so importing
 * this module never opens a database connection at import time.
 */
export const PRISMA_SOURCE_BREAKER_STORE: SourceBreakerStore = Object.freeze({
  async find(identity) {
    const { db } = await import("@/lib/dbClient");
    const row = await db.sourceBreaker.findUnique({
      where: {
        anchorSlug_corridorSlug: {
          anchorSlug: identity.anchorSlug,
          corridorSlug: identity.corridorSlug,
        },
      },
    });
    return row ? rowFromPersistence(row) : null;
  },
  async claimRecoveryProbe(identity, input) {
    const { db } = await import("@/lib/dbClient");
    const updated = await db.sourceBreaker.updateMany({
      where: {
        anchorSlug: identity.anchorSlug,
        corridorSlug: identity.corridorSlug,
        state: "OPEN",
        cooldownUntil: { lte: input.now },
        recoveryProbesActive: 0,
      },
      data: {
        state: "HALF_OPEN",
        recoveryProbeToken: input.token,
        recoveryProbeDeadline: input.deadline,
        recoveryProbesActive: { increment: 1 },
      },
    });
    return updated.count === 1;
  },
  async applyTransition(identity, { row, next }) {
    const { db } = await import("@/lib/dbClient");
    const data = {
      state: next.state,
      consecutiveTransportFailures: next.consecutiveTransportFailures,
      consecutiveOpens: next.consecutiveOpens,
      recentInvalidEvidenceFailures: next.recentInvalidEvidenceFailures,
      openAt: next.openAt,
      cooldownUntil: next.cooldownUntil,
      recoveryProbeToken: next.recoveryProbeToken,
      recoveryProbeDeadline: next.recoveryProbeDeadline,
      recoveryProbesActive: next.recoveryProbesActive,
      windowStartAt: next.windowStartAt,
      lastFailureAt: next.lastFailureAt,
      lastSuccessAt: next.lastSuccessAt,
    };
    if (row === null) {
      await db.sourceBreaker.create({
        data: {
          anchorSlug: identity.anchorSlug,
          corridorSlug: identity.corridorSlug,
          ...data,
        },
      });
      return;
    }
    await db.sourceBreaker.updateMany({
      where: {
        anchorSlug: identity.anchorSlug,
        corridorSlug: identity.corridorSlug,
        recoveryProbeToken: row.recoveryProbeToken,
      },
      data,
    });
  },
});
