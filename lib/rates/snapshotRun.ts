import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
} from "@/lib/rates/liveRateSource";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { PRISMA_RATE_SNAPSHOT_REPOSITORY } from "@/lib/rates/snapshot";
import { PRISMA_SOURCE_BREAKER_STORE } from "@/lib/rates/sourceBreakerStore";
import type {
  PreparedLiveRateCandidate,
  SafeLiveRateRunSummary,
} from "@/types/liveRateSource";

export type SnapshotReviewedLiveRatesDependencies = Readonly<{
  assertConfiguration: () => void;
  buildCandidates: () => Promise<readonly PreparedLiveRateCandidate[]>;
  executeCandidates: (
    candidates: readonly PreparedLiveRateCandidate[],
  ) => Promise<SafeLiveRateRunSummary>;
}>;

/**
 * Runs the reviewed production rate-source boundary once. This is intentionally
 * shared by the CLI and the authenticated scheduler so they cannot drift.
 */
export async function snapshotReviewedLiveRates(
  dependencies: SnapshotReviewedLiveRatesDependencies = DEFAULT_DEPENDENCIES,
): Promise<SafeLiveRateRunSummary> {
  dependencies.assertConfiguration();
  return dependencies.executeCandidates(await dependencies.buildCandidates());
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  assertConfiguration: assertCurrentStellarCoreConfiguration,
  buildCandidates: buildReviewedLiveRateCandidates,
  executeCandidates: async (candidates) => formatLiveRateRunSummary(
    await runRateEngine(candidates, {
      quote: fetchReviewedIndicativeRate,
      repository: PRISMA_RATE_SNAPSHOT_REPOSITORY,
      breaker: PRISMA_SOURCE_BREAKER_STORE,
    }),
  ),
}) satisfies SnapshotReviewedLiveRatesDependencies;
