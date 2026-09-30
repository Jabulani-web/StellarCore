import assert from "node:assert/strict";
import test from "node:test";

import {
  runScheduledRefresh,
  type ScheduledRefreshDependencies,
} from "@/lib/scheduled/refresh";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

const STARTED_AT = new Date("2026-08-31T16:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-31T16:00:01.000Z");

test("scheduled refresh ingests rates before evaluating reputation and returns a bounded success result", async () => {
  const order: string[] = [];
  const result = await runScheduledRefresh(dependencies({
    snapshotRates: async () => {
      order.push("rates");
      return rateSummary();
    },
    evaluateReputation: async ({ evaluatedAt }) => {
      order.push(`reputation:${evaluatedAt.toISOString()}`);
      return reputationSummary();
    },
  }));

  assert.deepEqual(order, ["rates", "reputation:2026-08-31T16:00:00.000Z"]);
  assert.deepEqual(result, {
    ok: true,
    startedAt: STARTED_AT.toISOString(),
    completedAt: COMPLETED_AT.toISOString(),
    rates: { attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [], breakerEvents: [] },
    reputation: { attempted: 3, succeeded: 3, failed: 0, failures: [] },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("a rate source partial failure is reported while reputation still evaluates persisted evidence", async () => {
  let evaluated = false;
  const result = await runScheduledRefresh(dependencies({
    snapshotRates: async () => rateSummary({
      succeeded: 0,
      failed: 1,
      snapshotsPersisted: 0,
      failures: [{ anchorSlug: "zeam", corridorSlug: "usdc-us-brl-br", phase: "QUOTE", code: "QUOTE_FAILURE" }],
      breakerEvents: [],
    }),
    evaluateReputation: async () => {
      evaluated = true;
      return reputationSummary();
    },
  }));

  assert.equal(evaluated, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rates.failures, [{
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    phase: "QUOTE",
    code: "QUOTE_FAILURE",
  }]);
});

test("a rate preparation failure is safely serialized and does not prevent reputation evaluation", async () => {
  let evaluated = false;
  const result = await runScheduledRefresh(dependencies({
    snapshotRates: async () => {
      throw new Error("DATABASE_URL=should-not-leak");
    },
    evaluateReputation: async () => {
      evaluated = true;
      return reputationSummary({
        attempted: 3,
        succeeded: 2,
        failed: 1,
        failures: [{ anchorSlug: "moneygram", code: "EVIDENCE_READ_FAILURE" }],
      });
    },
  }));

  assert.equal(evaluated, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rates, {
    attempted: 0,
    succeeded: 0,
    failed: 1,
    skipped: 0,
    failures: [{ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" }],
    breakerEvents: [],
  });
  assert.equal(JSON.stringify(result).includes("should-not-leak"), false);
});

test("a fatal reputation orchestration failure reaches the HTTP boundary rather than being misreported", async () => {
  await assert.rejects(
    runScheduledRefresh(dependencies({
      snapshotRates: async () => rateSummary(),
      evaluateReputation: async () => {
        throw new Error("database unavailable");
      },
    })),
  );
});

test("sequential duplicate invocations remain independent without duplicate work inside either run", async () => {
  let rateRuns = 0;
  let reputationRuns = 0;
  const deps = dependencies({
    snapshotRates: async () => {
      rateRuns += 1;
      return rateSummary();
    },
    evaluateReputation: async () => {
      reputationRuns += 1;
      return reputationSummary();
    },
  });

  await runScheduledRefresh(deps);
  await runScheduledRefresh(deps);
  assert.equal(rateRuns, 2);
  assert.equal(reputationRuns, 2);
});

function dependencies(overrides: Partial<ScheduledRefreshDependencies>): ScheduledRefreshDependencies {
  let clockCalls = 0;
  return Object.freeze({
    snapshotRates: async () => rateSummary(),
    evaluateReputation: async () => reputationSummary(),
    now: () => (clockCalls++ % 2 === 0 ? STARTED_AT : COMPLETED_AT),
    ...overrides,
  });
}

function rateSummary(overrides: Partial<SafeLiveRateRunSummary> = {}): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 1,
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 1,
    snapshots: [],
    failures: [],
    skippedSources: [],
    breakerEvents: [],
    ...overrides,
  });
}

function reputationSummary(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    attempted: 3,
    succeeded: 3,
    failed: 0,
    failures: [],
    ...overrides,
  }) as Awaited<ReturnType<ScheduledRefreshDependencies["evaluateReputation"]>>;
}
