import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFailure,
  applySuccess,
  claimRecoveryProbe,
  classifyEngineFailure,
  cooldownFor,
  effectiveState,
  expireRecoveryProbe,
  gateSource,
  isRecoveryProbeLive,
  type ClassifiedEngineFailure,
} from "@/lib/rates/sourceBreaker";
import type { SourceBreakerRow } from "@/types/rates";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const TEN_MINUTES = 10 * 60_000;
const ONE_HOUR = 60 * 60_000;

function transportFailure(
  phase: "QUOTE" | "PERSISTENCE" = "QUOTE",
): ClassifiedEngineFailure {
  return classifyEngineFailure(phase, "QUOTE_FAILURE");
}

function invalidEvidenceFailure(): ClassifiedEngineFailure {
  return classifyEngineFailure("NORMALIZATION", "INVALID_RATE");
}

test("classification separates transport/service failures from invalid evidence", () => {
  assert.deepEqual(classifyEngineFailure("QUOTE", "QUOTE_FAILURE"), {
    kind: "TRANSPORT_OR_SERVICE",
    reason: "quote_failure:QUOTE_FAILURE",
  });
  assert.deepEqual(classifyEngineFailure("PERSISTENCE", "PERSISTENCE_FAILURE"), {
    kind: "TRANSPORT_OR_SERVICE",
    reason: "persistence_failure:PERSISTENCE_FAILURE",
  });
  assert.deepEqual(classifyEngineFailure("NORMALIZATION", "INVALID_RATE"), {
    kind: "INVALID_EVIDENCE",
    reason: "invalid_evidence:INVALID_RATE",
  });
});

test("repeated eligible transport failures open the breaker at the documented threshold", () => {
  let row: SourceBreakerRow | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = applyFailure(row, transportFailure(), NOW);
    row = outcome.next;
    assert.equal(outcome.event, null);
  }
  const third = applyFailure(row, transportFailure(), NOW);
  assert.equal(third.event, "OPENED");
  assert.equal(third.next.state, "OPEN");
  assert.equal(third.next.consecutiveOpens, 1);
  assert.equal(
    third.next.cooldownUntil?.getTime(),
    NOW.getTime() + TEN_MINUTES,
  );
});

test("a failure outside the window restarts the consecutive count", () => {
  const first = applyFailure(null, transportFailure(), NOW);
  const muchLater = new Date(NOW.getTime() + 16 * 60_000);
  const second = applyFailure(first.next, transportFailure(), muchLater);
  assert.equal(second.next.consecutiveTransportFailures, 1);
  assert.equal(second.event, null);
});

test("invalid evidence never opens the breaker regardless of repetition", () => {
  let row: SourceBreakerRow | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const outcome = applyFailure(row, invalidEvidenceFailure(), NOW);
    row = outcome.next;
    assert.equal(outcome.event, null);
    assert.equal(row.state, "CLOSED");
    assert.equal(row.state, "CLOSED");
  }
  assert.equal(row!.recentInvalidEvidenceFailures, 50);
  const gate = gateSource(row, NOW);
  assert.equal(gate.allowed, true);
});

test("an open breaker suppresses attempts with a safe, credential-free reason", () => {
  const opened = applyFailure(
    applyFailure(applyFailure(null, transportFailure(), NOW).next, transportFailure(), NOW).next,
    transportFailure(),
    NOW,
  );
  const gate = gateSource(opened.next, new Date(NOW.getTime() + 1_000));
  assert.equal(gate.allowed, false);
  assert.equal(gate.suppressed?.state, "OPEN");
  assert.equal(gate.suppressed?.reason, "BREAKER_OPEN");
  assert.equal(typeof gate.suppressed?.cooldownRemainingMs, "number");
  assert.equal(JSON.stringify(gate).includes("postgres"), false);
});

test("an open breaker admits a probe attempt only after the cooldown elapses", () => {
  const opened = applyFailure(
    applyFailure(applyFailure(null, transportFailure(), NOW).next, transportFailure(), NOW).next,
    transportFailure(),
    NOW,
  ).next;

  const before = gateSource(opened, new Date(NOW.getTime() + TEN_MINUTES - 1));
  assert.equal(before.allowed, false);

  const after = gateSource(opened, new Date(NOW.getTime() + TEN_MINUTES));
  assert.equal(after.allowed, true);
  assert.ok(after.recoveryProbe);
});

test("the single recovery probe claim is granted once and refused while held", () => {
  const opened = applyFailure(
    applyFailure(applyFailure(null, transportFailure(), NOW).next, transportFailure(), NOW).next,
    transportFailure(),
    NOW,
  ).next;
  const probeTime = new Date(NOW.getTime() + TEN_MINUTES + 1_000);

  const claimed = claimRecoveryProbe(opened, {
    token: "probe-a",
    now: probeTime,
    deadline: new Date(probeTime.getTime() + 30_000),
  });
  assert.equal(claimed?.state, "HALF_OPEN");
  assert.equal(claimed?.recoveryProbesActive, 1);
  assert.equal(claimed?.recoveryProbeToken, "probe-a");

  // A second claim against the *claimed* row (another worker's view) is
  // refused: the durable slot is held, not recomputed from the stale snapshot.
  const refused = claimRecoveryProbe(claimed, {
    token: "probe-b",
    now: probeTime,
    deadline: new Date(probeTime.getTime() + 30_000),
  });
  assert.equal(refused, null);
});

test("a live half-open probe blocks further probes and reports the bounded reason", () => {
  const probing: SourceBreakerRow = {
    state: "HALF_OPEN",
    consecutiveTransportFailures: 0,
    consecutiveOpens: 1,
    recentInvalidEvidenceFailures: 0,
    openAt: NOW,
    cooldownUntil: NOW,
    recoveryProbeToken: "probe-a",
    recoveryProbeDeadline: new Date(NOW.getTime() + 30_000),
    recoveryProbesActive: 1,
    windowStartAt: NOW,
    lastFailureAt: NOW,
    lastSuccessAt: null,
  };

  const gate = gateSource(probing, new Date(NOW.getTime() + 1_000));
  assert.equal(gate.allowed, false);
  assert.equal(gate.suppressed?.state, "HALF_OPEN");
  assert.equal(gate.suppressed?.reason, "RECOVERY_PROBE_LIMIT");
});

test("an expired half-open probe reports a timeout and expires back to open", () => {
  const probing: SourceBreakerRow = {
    state: "HALF_OPEN",
    consecutiveTransportFailures: 0,
    consecutiveOpens: 1,
    recentInvalidEvidenceFailures: 0,
    openAt: NOW,
    cooldownUntil: NOW,
    recoveryProbeToken: "probe-a",
    recoveryProbeDeadline: new Date(NOW.getTime() + 30_000),
    recoveryProbesActive: 1,
    windowStartAt: NOW,
    lastFailureAt: NOW,
    lastSuccessAt: null,
  };

  const later = new Date(NOW.getTime() + 31_000);
  const gate = gateSource(probing, later);
  assert.equal(gate.allowed, false);
  assert.equal(gate.suppressed?.reason, "PROBE_TIMEOUT");

  const expired = expireRecoveryProbe(probing, later);
  assert.equal(expired.event, "RECOVERY_PROBE_TIMEOUT");
  assert.equal(expired.next.state, "OPEN");
  assert.equal(expired.next.consecutiveOpens, 2);
  assert.equal(
    expired.next.cooldownUntil?.getTime(),
    later.getTime() + cooldownFor(2),
  );
});

test("a successful probe deterministically restores closed operation", () => {
  const probing: SourceBreakerRow = {
    state: "HALF_OPEN",
    consecutiveTransportFailures: 0,
    consecutiveOpens: 1,
    recentInvalidEvidenceFailures: 0,
    openAt: NOW,
    cooldownUntil: NOW,
    recoveryProbeToken: "probe-a",
    recoveryProbeDeadline: new Date(NOW.getTime() + 30_000),
    recoveryProbesActive: 1,
    windowStartAt: NOW,
    lastFailureAt: NOW,
    lastSuccessAt: null,
  };

  const recovered = applySuccess(probing, NOW);
  assert.equal(recovered.event, "RECOVERED");
  assert.equal(recovered.next.state, "CLOSED");
  assert.equal(recovered.next.consecutiveOpens, 0);
  assert.equal(recovered.next.recoveryProbesActive, 0);
  assert.equal(gateSource(recovered.next, NOW).allowed, true);
});

test("a single failed probe immediately reopens with escalated cooldown", () => {
  const probing: SourceBreakerRow = {
    state: "HALF_OPEN",
    consecutiveTransportFailures: 0,
    consecutiveOpens: 1,
    recentInvalidEvidenceFailures: 0,
    openAt: NOW,
    cooldownUntil: NOW,
    recoveryProbeToken: "probe-a",
    recoveryProbeDeadline: new Date(NOW.getTime() + 30_000),
    recoveryProbesActive: 1,
    windowStartAt: NOW,
    lastFailureAt: NOW,
    lastSuccessAt: null,
  };

  const failed = applyFailure(probing, transportFailure(), NOW);
  assert.equal(failed.event, "REOPENED");
  assert.equal(failed.next.state, "OPEN");
  assert.equal(failed.next.consecutiveOpens, 2);
  assert.equal(
    failed.next.cooldownUntil?.getTime(),
    NOW.getTime() + cooldownFor(2),
  );
});

test("cooldowns escalate across reopen cycles and cap at the maximum", () => {
  assert.equal(cooldownFor(1), TEN_MINUTES);
  assert.equal(cooldownFor(2), 20 * 60_000);
  assert.equal(cooldownFor(3), 40 * 60_000);
  assert.equal(cooldownFor(4), ONE_HOUR);
  assert.equal(cooldownFor(9), ONE_HOUR);
});

test("a stale open breaker state falls back to closed after the state TTL", () => {
  const opened = applyFailure(
    applyFailure(applyFailure(null, transportFailure(), NOW).next, transportFailure(), NOW).next,
    transportFailure(),
    NOW,
  ).next;

  const insideTtl = effectiveState(opened, new Date(NOW.getTime() + 60 * 60_000));
  assert.equal(insideTtl.state, "OPEN");

  const afterTtl = effectiveState(opened, new Date(NOW.getTime() + 25 * 60 * 60_000));
  assert.equal(afterTtl.state, "CLOSED");
  assert.equal(gateSource(opened, new Date(NOW.getTime() + 25 * 60 * 60_000)).allowed, true);
});

test("invalid evidence recorded on an open breaker never heals it into half-open", () => {
  const opened = applyFailure(
    applyFailure(applyFailure(null, transportFailure(), NOW).next, transportFailure(), NOW).next,
    transportFailure(),
    NOW,
  ).next;

  const withInvalid = applyFailure(opened, invalidEvidenceFailure(), NOW);
  assert.equal(withInvalid.next.state, "OPEN");
  assert.equal(gateSource(withInvalid.next, new Date(NOW.getTime() + 1_000)).allowed, false);
});

test("probe liveness requires a live deadline and an active claim", () => {
  assert.equal(isRecoveryProbeLive(null, NOW), false);
  const openRow: SourceBreakerRow = {
    state: "OPEN",
    consecutiveTransportFailures: 3,
    consecutiveOpens: 1,
    recentInvalidEvidenceFailures: 0,
    openAt: NOW,
    cooldownUntil: NOW,
    recoveryProbeToken: null,
    recoveryProbeDeadline: null,
    recoveryProbesActive: 0,
    windowStartAt: NOW,
    lastFailureAt: NOW,
    lastSuccessAt: null,
  };
  assert.equal(isRecoveryProbeLive(openRow, NOW), false);
});
