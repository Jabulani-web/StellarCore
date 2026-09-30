import type { CorridorRegistryEntry } from "@/types/corridor";
import type {
  Sep38IndicativePrice,
  Sep38IndicativePriceRequest,
} from "@/types/sep38";

export type NormalizedRateObservation = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date;
}>;

export type RateFreshnessState = "fresh" | "stale" | "future" | "invalid";

export type RateFreshness = Readonly<{
  state: RateFreshnessState;
  ageMs: number | null;
}>;

export type MedianSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  capturedAt: Date | string;
}>;

export type MedianExclusionReason =
  | "stale"
  | "future_timestamp"
  | "invalid_timestamp"
  | "invalid_rate";

export type MedianSourceResult = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  capturedAt: Date | string;
  included: boolean;
  exclusionReason?: MedianExclusionReason;
}>;

export type MedianResult = Readonly<{
  state: "healthy" | "insufficient_fresh_sources";
  median: string | null;
  freshSourceCount: number;
  sources: readonly MedianSourceResult[];
}>;

export type PersistedRateSnapshot = Readonly<{
  id: string;
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date;
}>;

export type RateSnapshotPersistenceCode =
  | "ANCHOR_NOT_FOUND"
  | "CORRIDOR_NOT_FOUND"
  | "ASSOCIATION_NOT_FOUND"
  | "PERSISTENCE_FAILURE";

export type RateSnapshotPersistenceResult =
  | Readonly<{ ok: true; snapshot: PersistedRateSnapshot }>
  | Readonly<{ ok: false; code: RateSnapshotPersistenceCode }>;

export type RateSnapshotRepository = Readonly<{
  findAnchorBySlug: (slug: string) => Promise<Readonly<{ id: string }> | null>;
  findCorridorBySlug: (slug: string) => Promise<Readonly<{ id: string }> | null>;
  hasAssociation: (anchorId: string, corridorId: string) => Promise<boolean>;
  createSnapshot: (input: Readonly<{
    anchorId: string;
    corridorId: string;
    rate: string;
    sourceAmount: string;
    destinationAmount: string;
    fee: string;
    capturedAt: Date;
  }>) => Promise<Readonly<{
    id: string;
    rate: { toString(): string } | string;
    sourceAmount: { toString(): string } | string;
    destinationAmount: { toString(): string } | string;
    fee: { toString(): string } | string;
    capturedAt: Date;
  }>>;
}>;

export type RateCandidate = Readonly<{
  anchorSlug: string;
  corridor: CorridorRegistryEntry;
  request: Sep38IndicativePriceRequest;
}>;

export type RateQuoteProvider = (
  candidate: RateCandidate,
) => Promise<Sep38IndicativePrice>;

export type RateEngineFailure = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  phase: "QUOTE" | "NORMALIZATION" | "PERSISTENCE";
  code: string;
}>;

export type RateEngineSkippedSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  /** Issue #167: breaker suppressions are skips, not fresh observations. */
  reason:
    | "DUPLICATE_CANDIDATE"
    | "BREAKER_OPEN"
    | "RECOVERY_PROBE_LIMIT"
    | "PROBE_TIMEOUT";
}>;

/**
 * Issue #167: durable per-source circuit-breaker state. The breaker is keyed
 * to the reviewed source identity (anchor + corridor), stored durably so it
 * survives restarts, and consulted before any network work is attempted.
 */
export type SourceBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type SourceFailureKind = "TRANSPORT_OR_SERVICE" | "INVALID_EVIDENCE";

export type SourceBreakerSnapshot = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  state: SourceBreakerState;
  consecutiveTransportFailures: number;
  recentInvalidEvidenceFailures: number;
  openAt: Date | null;
  cooldownUntil: Date | null;
  recoveryProbeDeadline: Date | null;
  recoveryProbesActive: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
}>;

export type SourceBreakerGateDecision = Readonly<{
  allowed: boolean;
  /** Present when allowed because the OPEN breaker may admit a recovery
   * probe; the caller must still win the atomic single-probe claim. */
  recoveryProbe?: Readonly<{
    deadline: Date;
  }>;
  /** Present when not allowed; a safe, credential-free explanation. */
  suppressed?: Readonly<{
    state: SourceBreakerState;
    reason: "BREAKER_OPEN" | "RECOVERY_PROBE_LIMIT" | "PROBE_TIMEOUT";
    cooldownRemainingMs: number | null;
  }>;
}>;

export type SourceBreakerStore = Readonly<{
  /** Atomically read the current durable row, or null when none exists. */
  find: (identity: SourceIdentityKey) => Promise<SourceBreakerRow | null>;
  /**
   * Atomically claim the single recovery probe slot for an OPEN source.
   * Resolves false when another worker already holds a live probe claim.
   */
  claimRecoveryProbe: (
    identity: SourceIdentityKey,
    input: Readonly<{ token: string; now: Date; deadline: Date }>,
  ) => Promise<boolean>;
  /** Atomically persist a transition computed from the row read above. */
  applyTransition: (
    identity: SourceIdentityKey,
    input: Readonly<{ row: SourceBreakerRow | null; next: SourceBreakerRow }>,
  ) => Promise<void>;
}>;

export type SourceIdentityKey = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
}>;

export type SourceBreakerRow = Readonly<{
  state: SourceBreakerState;
  consecutiveTransportFailures: number;
  /** Openings since the last success; drives bounded exponential backoff. */
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
}>;

export type RateEngineResult = Readonly<{
  totalCandidates: number;
  totalAttempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  snapshotsPersisted: number;
  snapshots: readonly PersistedRateSnapshot[];
  failures: readonly RateEngineFailure[];
  skippedSources: readonly RateEngineSkippedSource[];
  /** Issue #167: durable per-source breaker outcomes for this run. */
  breakerEvents: readonly RateEngineBreakerEvent[];
}>;

/**
 * Evidence of a breaker transition or suppression during one engine run.
 * These are audit facts, not fresh rate observations: they never feed the
 * median or any rate read model.
 */
export type RateEngineBreakerEvent = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  kind:
    | "OPENED"
    | "REOPENED"
    | "RECOVERY_PROBE_GRANTED"
    | "RECOVERY_PROBE_TIMEOUT"
    | "RECOVERED";
  state: SourceBreakerState;
  cooldownUntil: string | null;
  reason?: string;
}>;
