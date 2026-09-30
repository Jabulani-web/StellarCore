import assert from "node:assert/strict";
import test from "node:test";

import { runRateEngine } from "@/lib/rates/rateEngine";
import { createInMemorySourceBreakerStore } from "@/lib/rates/sourceBreakerStore";
import type {
  RateCandidate,
  RateSnapshotRepository,
  SourceBreakerRow,
} from "@/types/rates";
import type { Sep38IndicativePrice } from "@/types/sep38";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const USD = "iso4217:USD" as const;
const NOW = new Date("2026-09-30T12:00:00.000Z");

function candidate(anchorSlug: string): RateCandidate {
  return Object.freeze({
    anchorSlug,
    corridor: Object.freeze({
      slug: "usdc-us-usd-us",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "US",
    }),
    request: Object.freeze({ sellAsset: USDC, buyAsset: USD, sellAmount: "100", context: "sep31" }),
  });
}

function quote(overrides: Partial<Sep38IndicativePrice> = {}): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1",
    price: "1",
    sellAmount: "100",
    buyAmount: "100",
    fee: Object.freeze({ total: "0", asset: USD, details: Object.freeze([]) }),
    ...overrides,
  });
}

function repository(): RateSnapshotRepository {
  let count = 0;
  return {
    findAnchorBySlug: async (slug) => ({ id: slug }),
    findCorridorBySlug: async (slug) => ({ id: slug }),
    hasAssociation: async () => true,
    createSnapshot: async (input) => ({ id: `snapshot-${++count}`, ...input }),
  };
}

test("an open breaker skips the source before any network attempt and persists no observation", async () => {
  const breaker = createInMemorySourceBreakerStore();
  const identity = { anchorSlug: "zeam", corridorSlug: "usdc-us-usd-us" };
  // Seed three durable transport failures so the breaker is OPEN.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runRateEngine([candidate("zeam")], {
      quote: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      repository: repository(),
      breaker,
      now: () => NOW,
    });
  }

  let quoteCalls = 0;
  let persisted = 0;
  const store = repository();
  const result = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      quoteCalls += 1;
      return quote();
    },
    repository: {
      ...store,
      createSnapshot: async (input) => {
        persisted += 1;
        return store.createSnapshot(input);
      },
    },
    breaker,
    now: () => NOW,
  });

  assert.equal(quoteCalls, 0, "the endpoint must not be contacted while OPEN");
  assert.equal(persisted, 0, "no observation may be persisted while OPEN");
  assert.equal(result.totalAttempted, 0);
  assert.equal(result.succeeded, 0);
  assert.deepEqual(result.skippedSources, [{
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-usd-us",
    reason: "BREAKER_OPEN",
  }]);
  assert.equal(result.breakerEvents.length, 0);
  const row = (await breaker.find(identity)) as SourceBreakerRow;
  assert.equal(row.state, "OPEN");
});

test("a successful recovery probe deterministically restores normal operation across runs", async () => {
  const breaker = createInMemorySourceBreakerStore();
  const identity = { anchorSlug: "zeam", corridorSlug: "usdc-us-usd-us" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runRateEngine([candidate("zeam")], {
      quote: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      repository: repository(),
      breaker,
      now: () => NOW,
    });
  }

  // After the cooldown elapses, the next run is admitted as the recovery probe.
  const afterCooldown = new Date(NOW.getTime() + 10 * 60_000 + 1_000);
  let quoteCalls = 0;
  const probeRun = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      quoteCalls += 1;
      return quote();
    },
    repository: repository(),
    breaker,
    now: () => afterCooldown,
  });

  assert.equal(quoteCalls, 1, "exactly one probe reaches the endpoint");
  assert.equal(probeRun.succeeded, 1);
  assert.deepEqual(
    probeRun.breakerEvents.map(({ kind }) => kind),
    ["RECOVERY_PROBE_GRANTED", "RECOVERED"],
  );

  // Normal operation continues deterministically on the following run.
  const nextRun = await runRateEngine([candidate("zeam")], {
    quote: async () => quote(),
    repository: repository(),
    breaker,
    now: () => new Date(afterCooldown.getTime() + 120_000),
  });
  assert.equal(nextRun.succeeded, 1);
  assert.equal(nextRun.breakerEvents.length, 0);
  const row = (await breaker.find(identity)) as SourceBreakerRow;
  assert.equal(row.state, "CLOSED");
});

test("a failed probe reopens the breaker with escalated cooldown instead of fanning out", async () => {
  const breaker = createInMemorySourceBreakerStore();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runRateEngine([candidate("zeam")], {
      quote: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      repository: repository(),
      breaker,
      now: () => NOW,
    });
  }

  const afterCooldown = new Date(NOW.getTime() + 10 * 60_000 + 1_000);
  const probeRun = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    repository: repository(),
    breaker,
    now: () => afterCooldown,
  });
  assert.equal(probeRun.succeeded, 0);
  assert.equal(probeRun.failed, 1);
  assert.deepEqual(
    probeRun.breakerEvents.map(({ kind }) => kind),
    ["RECOVERY_PROBE_GRANTED", "REOPENED"],
  );

  // The second failure inside half-open reopens with the escalated cooldown.
  const row = (await breaker.find({ anchorSlug: "zeam", corridorSlug: "usdc-us-usd-us" })) as SourceBreakerRow;
  assert.equal(row.state, "OPEN");
  assert.equal(row.consecutiveOpens, 2);
  assert.equal(
    row.cooldownUntil?.getTime(),
    afterCooldown.getTime() + 20 * 60_000,
  );

  // While that new cooldown runs, the source is skipped without network work.
  const suppressedRun = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      throw new Error("must not be called");
    },
    repository: repository(),
    breaker,
    now: () => new Date(afterCooldown.getTime() + 60_000),
  });
  assert.equal(suppressedRun.totalAttempted, 0);
  assert.equal(suppressedRun.skippedSources[0]?.reason, "BREAKER_OPEN");
});

test("invalid-evidence failures never trip the breaker and never become observations", async () => {
  const breaker = createInMemorySourceBreakerStore();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await runRateEngine([candidate("zeam")], {
      quote: async () => quote({ price: "0" }),
      repository: repository(),
      breaker,
      now: () => new Date(NOW.getTime() + attempt * 60_000),
    });
    assert.equal(result.failed, 1);
    assert.equal(result.snapshotsPersisted, 0);
    assert.equal(result.breakerEvents.length, 0);
  }
  const row = (await breaker.find({ anchorSlug: "zeam", corridorSlug: "usdc-us-usd-us" })) as SourceBreakerRow;
  assert.equal(row.state, "CLOSED");
  assert.equal(row.recentInvalidEvidenceFailures, 5);
});

test("breaker state survives a fresh store connection (restart durability)", async () => {
  // Seed with one store instance, then simulate a restart by using a second
  // instance over the same durable rows.
  const durable = createInMemorySourceBreakerStore();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runRateEngine([candidate("zeam")], {
      quote: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      repository: repository(),
      breaker: durable,
      now: () => NOW,
    });
  }
  const identity = { anchorSlug: "zeam", corridorSlug: "usdc-us-usd-us" };
  const seeded = (await durable.find(identity)) as SourceBreakerRow;

  const restarted = createInMemorySourceBreakerStore();
  await restarted.applyTransition(identity, { row: null, next: seeded });

  const result = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      throw new Error("must not be called");
    },
    repository: repository(),
    breaker: restarted,
    now: () => NOW,
  });
  assert.equal(result.totalAttempted, 0);
  assert.equal(result.skippedSources[0]?.reason, "BREAKER_OPEN");
});

test("a second run after a probe claim is suppressed while the probe is live (single-probe contract)", async () => {
  const breaker = createInMemorySourceBreakerStore();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runRateEngine([candidate("zeam")], {
      quote: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      repository: repository(),
      breaker,
      now: () => NOW,
    });
  }

  const afterCooldown = new Date(NOW.getTime() + 10 * 60_000 + 1_000);
  const first = await runRateEngine([candidate("zeam")], {
    quote: async () => quote(),
    repository: repository(),
    breaker,
    now: () => afterCooldown,
  });
  assert.equal(first.totalAttempted, 1);

  // A store serving a HALF_OPEN row with someone else's live claim emulates a
  // second instance that lost the probe race: it must stay suppressed.
  const staleViewStore = {
    find: async () => ({
      state: "HALF_OPEN" as const,
      consecutiveTransportFailures: 0,
      consecutiveOpens: 1,
      recentInvalidEvidenceFailures: 0,
      openAt: NOW,
      cooldownUntil: afterCooldown,
      recoveryProbeToken: "someone-else",
      recoveryProbeDeadline: new Date(afterCooldown.getTime() + 30_000),
      recoveryProbesActive: 1,
      windowStartAt: NOW,
      lastFailureAt: NOW,
      lastSuccessAt: null,
    }),
    claimRecoveryProbe: async () => false,
    applyTransition: async () => {},
  };
  const second = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      throw new Error("must not be called");
    },
    repository: repository(),
    breaker: staleViewStore,
    now: () => new Date(afterCooldown.getTime() + 1_000),
  });
  assert.equal(second.totalAttempted, 0);
  assert.equal(second.skippedSources[0]?.reason, "RECOVERY_PROBE_LIMIT");
});

test("runs without a breaker behave exactly as before (fail-open contract)", async () => {
  let quoteCalls = 0;
  const result = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      quoteCalls += 1;
      return quote();
    },
    repository: repository(),
    now: () => NOW,
  });
  assert.equal(quoteCalls, 1);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.breakerEvents, []);
});

test("a breaker-store outage fails open and the run keeps reporting engine failures", async () => {
  let quoteCalls = 0;
  const failingStore = {
    find: async () => {
      throw new Error("store unavailable");
    },
    claimRecoveryProbe: async () => {
      throw new Error("store unavailable");
    },
    applyTransition: async () => {
      throw new Error("store unavailable");
    },
  };
  const result = await runRateEngine([candidate("zeam")], {
    quote: async () => {
      quoteCalls += 1;
      throw new Error("connect ECONNREFUSED");
    },
    repository: repository(),
    breaker: failingStore,
    now: () => NOW,
  });
  assert.equal(quoteCalls, 1, "fail-open keeps the pre-breaker behavior");
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0]?.code, "QUOTE_FAILURE");
});
