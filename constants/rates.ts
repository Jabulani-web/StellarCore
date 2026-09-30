export const RATE_FRESHNESS_THRESHOLD_MS = 120_000;
export const MIN_FRESH_SOURCES = 2;

// Issue #167: per-source circuit breakers for reviewed live-rate sources.
// A source that keeps failing must stop consuming scheduler and network
// capacity every run while preserving transparent, durable evidence of why it
// is temporarily suppressed.
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_FAILURE_WINDOW_MS = 15 * 60_000;
export const BREAKER_BASE_COOLDOWN_MS = 10 * 60_000;
export const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;
export const BREAKER_BACKOFF_MULTIPLIER = 2;
export const BREAKER_HALF_OPEN_MAX_PROBES = 1;
export const BREAKER_HALF_OPEN_FAILURES_BEFORE_REOPEN = 1;
export const BREAKER_PROBE_TIMEOUT_MS = 30_000;
export const BREAKER_STATE_TTL_MS = 24 * 60 * 60_000;
