# Source circuit-breaker policy (live rate sources)

Status: normative for reviewed live-rate source execution.

Issue #167. A repeatedly failing reviewed rate source must stop consuming
scheduler and network capacity on every run while preserving transparent,
durable evidence of why it is temporarily suppressed. This document defines
the breaker states, thresholds, failure classification, cooldown, recovery
probes, and evidence-safety rules.

## Why a durable, application-level breaker

The rate engine used to attempt every prepared source on every execution and
only recorded failures in the run summary. Without durable state, a dead
endpoint is re-contacted every cycle, and without an application-level
breaker there is no way to bound that cost while keeping the source
eligible for recovery.

## Identity and durability

A breaker row is keyed to the reviewed source identity
(`anchorSlug` + `corridorSlug`) in the `source_breakers` table (Prisma model
`SourceBreaker`). State survives process restarts; nothing lives only in
process memory. The transitions live in `lib/rates/sourceBreaker.ts` (pure)
and `lib/rates/sourceBreakerStore.ts` (durable store).

## States and transitions

| State | Meaning | Exits |
| --- | --- | --- |
| `CLOSED` | Normal operation; failures accumulate toward the threshold | `OPEN` when the threshold is met |
| `OPEN` | The source is skipped before any network attempt and no observation is persisted | `HALF_OPEN` after the cooldown, when the single probe is claimed |
| `HALF_OPEN` | One recovery probe is in flight or its result is being applied | `CLOSED` on a successful probe, `OPEN` on a failed/expired probe |

## Failure classification

| Class | Examples | Breaker effect |
| --- | --- | --- |
| `TRANSPORT_OR_SERVICE` | Quote fetch threw (`QUOTE_FAILURE`), snapshot persistence failed (`PERSISTENCE_FAILURE`) | Counts toward opening |
| `INVALID_EVIDENCE` | Normalization rejected the payload (`INVALID_RATE`, `ASSET_MISMATCH`, …) | Never opens the breaker |

Normalization is schema-validated, so a normalization failure means the
endpoint returned evidence that cannot become an observation. That is an
evidence-quality problem: suppressing it behind a cooldown would hide a
persistent publisher defect, and breaker state must never be the thing that
turns invalid evidence into accepted evidence.

## Thresholds, windows, and cooldowns

All knobs are constants in `constants/rates.ts`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `BREAKER_FAILURE_THRESHOLD` | 3 | Consecutive transport failures that open a breaker |
| `BREAKER_FAILURE_WINDOW_MS` | 15 min | Failures older than the window restart the count |
| `BREAKER_BASE_COOLDOWN_MS` | 10 min | First cooldown after opening |
| `BREAKER_BACKOFF_MULTIPLIER` | 2 | Cooldown multiplier per reopen |
| `BREAKER_MAX_COOLDOWN_MS` | 60 min | Cooldown ceiling |
| `BREAKER_HALF_OPEN_MAX_PROBES` | 1 | Maximum concurrent recovery probes per source |
| `BREAKER_HALF_OPEN_FAILURES_BEFORE_REOPEN` | 1 | Failed probes before reopening |
| `BREAKER_PROBE_TIMEOUT_MS` | 30 s | A probe claim older than this expires back to `OPEN` |
| `BREAKER_STATE_TTL_MS` | 24 h | Non-closed state with no events falls back to `CLOSED` |

Cooldowns escalate across reopen cycles (10 → 20 → 40 → capped at 60 min)
and reset to the base cooldown when a probe recovers. The 24-hour TTL makes
restarts and abandoned incidents self-healing: a stale `OPEN` row with no
activity for a day is treated as `CLOSED` deterministically from durable
timestamps.

## Recovery probes and concurrency

After the cooldown elapses, the next run may admit exactly one recovery
probe. The claim is a single guarded store write
(`claimRecoveryProbe`) whose predicate admits the write only while the
durable state is `OPEN`, the cooldown has elapsed, and no claim is live, so
concurrent scheduler instances cannot fan out probes; losers are skipped
for that run with reason `RECOVERY_PROBE_LIMIT`. An expired claim is
expired exactly once (event `RECOVERY_PROBE_TIMEOUT`) and the breaker
returns to `OPEN` with the next cooldown step.

A successful probe deterministically restores `CLOSED` operation
(event `RECOVERED`); a failed probe reopens with escalated backoff
(event `REOPENED`).

## Skips are not observations

A breaker-suppressed source appears in the run summary as
`skippedSources` with reasons `BREAKER_OPEN`, `RECOVERY_PROBE_LIMIT`, or
`PROBE_TIMEOUT`, and as an entry in `breakerEvents` when a transition
happened. Suppression never persists a rate snapshot, never counts as a
fresh observation, and therefore cannot affect the staleness-aware median,
`MIN_FRESH_SOURCES`, or source-authority rules. `breakerEvents` are audit
evidence only and are quoted without URLs, credentials, or hostnames.

## Store outage behavior

If the breaker store itself fails, the engine fails open: sources are
attempted exactly as before the breaker existed, and engine failures keep
being recorded in the run summary. A breaker outage must never regress
evidence collection.

## Scope

Out of scope for #167 and unchanged by it: source authority (#122),
telemetry (#123), run concurrency and deadlines (#144), median
`MIN_FRESH_SOURCES` invariants, and the reputation engine.
