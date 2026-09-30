import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_DATABASE_BREAKER_INTEGRATION === "1";

test(
  "durable source-breaker rows survive independent store instances and serialize probe claims",
  { skip: !DATABASE_INTEGRATION_ENABLED },
  async () => {
    await import("dotenv/config");
    const { PRISMA_SOURCE_BREAKER_STORE: storeA } = await import(
      "@/lib/rates/sourceBreakerStore"
    );
    const { PRISMA_SOURCE_BREAKER_STORE: storeB } = await import(
      "@/lib/rates/sourceBreakerStore"
    );
    const { db } = await import("@/lib/dbClient");
    const { applyFailure, classifyEngineFailure, cooldownFor } = await import(
      "@/lib/rates/sourceBreaker"
    );

    const identity = {
      anchorSlug: `breakertest-${randomUUID().replaceAll("-", "")}`,
      corridorSlug: "usdc-us-brl-br",
    };
    const now = new Date();
    const opened = applyFailure(
      applyFailure(null, classifyEngineFailure("QUOTE", "QUOTE_FAILURE"), now).next,
      classifyEngineFailure("QUOTE", "QUOTE_FAILURE"),
      now,
    );
    const final = applyFailure(opened.next, classifyEngineFailure("QUOTE", "QUOTE_FAILURE"), now);

    try {
      await storeA.applyTransition(identity, { row: null, next: final.next });

      const viaSecondInstance = await storeB.find(identity);
      assert.equal(viaSecondInstance?.state, "OPEN");
      assert.equal(viaSecondInstance?.consecutiveOpens, 1);

      // Single-probe claim: exactly one of two racing claims wins.
      const [first, second] = await Promise.all([
        storeB.claimRecoveryProbe(identity, {
          token: `probe-${randomUUID()}`,
          now: new Date(final.next.cooldownUntil!.getTime() + 1_000),
          deadline: new Date(final.next.cooldownUntil!.getTime() + 31_000),
        }),
        storeA.claimRecoveryProbe(identity, {
          token: `probe-${randomUUID()}`,
          now: new Date(final.next.cooldownUntil!.getTime() + 1_000),
          deadline: new Date(final.next.cooldownUntil!.getTime() + 31_000),
        }),
      ]);
      assert.notEqual(first, second, "exactly one claim may win");
      const halfOpen = await storeA.find(identity);
      assert.equal(halfOpen?.state, "HALF_OPEN");
      assert.equal(halfOpen?.recoveryProbesActive, 1);

      // Cleanup guards the documented threshold arithmetic against drift.
      assert.equal(
        final.next.cooldownUntil!.getTime() - now.getTime(),
        cooldownFor(1),
      );
    } finally {
      await db.sourceBreaker.deleteMany({
        where: { anchorSlug: identity.anchorSlug },
      });
      await db.$disconnect();
    }
  },
);
