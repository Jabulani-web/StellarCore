import type { RateCandidate, RateEngineResult } from "@/types/rates";
import type { Sep38AssetIdentifier } from "@/types/sep38";

export type ReviewedLiveRateSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  sellAsset: Sep38AssetIdentifier;
  buyAsset: Sep38AssetIdentifier;
  sellAmount: string;
  buyDeliveryMethod?: string;
  countryCode?: string;
  context: "sep6" | "sep31";
}>;

export type PreparedLiveRateCandidate = RateCandidate & Readonly<{
  quoteServer: string;
}>;

export type SafeLiveRateRunSummary = Readonly<{
  totalCandidates: number;
  totalAttempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  snapshotsPersisted: number;
  snapshots: readonly Readonly<{
    id: string;
    anchorSlug: string;
    corridorSlug: string;
    rate: string;
    capturedAt: string;
  }>[];
  failures: RateEngineResult["failures"];
  skippedSources: RateEngineResult["skippedSources"];
  /** Issue #167: durable breaker transitions and suppressions for this run. */
  breakerEvents: RateEngineResult["breakerEvents"];
}>;
