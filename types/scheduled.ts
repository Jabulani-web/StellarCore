import type { RateEngineBreakerEvent, RateEngineFailure } from "@/types/rates";

export type ScheduledRateFailure = RateEngineFailure | Readonly<{
  phase: "PREPARATION";
  code: "LIVE_RATE_PREPARATION_FAILURE";
}>;

export type ScheduledReputationFailure = Readonly<{
  anchorSlug: string;
  code: string;
}>;

export type ScheduledRefreshResult = Readonly<{
  ok: boolean;
  startedAt: string;
  completedAt: string;
  rates: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    failures: readonly ScheduledRateFailure[];
    /** Issue #167: breaker transitions and suppressions, audit-only evidence. */
    breakerEvents: readonly RateEngineBreakerEvent[];
  }>;
  reputation: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    failures: readonly ScheduledReputationFailure[];
  }>;
}>;
