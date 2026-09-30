import assert from "node:assert/strict";
import test from "node:test";

import {
  snapshotReviewedLiveRates,
  type SnapshotReviewedLiveRatesDependencies,
} from "@/lib/rates/snapshotRun";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

test("failed configuration audit short-circuits before live candidate preparation", async () => {
  let buildCalls = 0;
  let executeCalls = 0;
  const dependencies: SnapshotReviewedLiveRatesDependencies = {
    assertConfiguration: () => {
      throw new Error("safe configuration failure");
    },
    buildCandidates: async () => {
      buildCalls += 1;
      return [];
    },
    executeCandidates: async () => {
      executeCalls += 1;
      return summary();
    },
  };

  await assert.rejects(snapshotReviewedLiveRates(dependencies), /safe configuration failure/);
  assert.equal(buildCalls, 0);
  assert.equal(executeCalls, 0);
});

test("valid configuration preserves reviewed snapshot execution flow", async () => {
  const events: string[] = [];
  const expected = summary();
  const result = await snapshotReviewedLiveRates({
    assertConfiguration: () => events.push("audit"),
    buildCandidates: async () => {
      events.push("prepare");
      return [];
    },
    executeCandidates: async (candidates) => {
      events.push(`execute:${candidates.length}`);
      return expected;
    },
  });

  assert.deepEqual(events, ["audit", "prepare", "execute:0"]);
  assert.equal(result, expected);
});

function summary(): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 0,
    totalAttempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 0,
    snapshots: Object.freeze([]),
    failures: Object.freeze([]),
    skippedSources: Object.freeze([]),
    breakerEvents: Object.freeze([]),
  });
}
