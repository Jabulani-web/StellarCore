# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Per-source circuit breakers for reviewed live-rate sources: durable
  `source_breakers` state keyed to the reviewed source identity, documented
  closed/open/half-open thresholds, transport-versus-invalid-evidence failure
  classification, bounded exponential cooldowns, and single recovery probes
  that cannot fan out across instances. Breaker-suppressed sources are
  surfaced as skips and audit events, never as fresh rate observations, and
  median/source-authority rules are unchanged. Policy documented in
  `docs/source-breaker-policy.md`.
- Production PostgreSQL TLS policy: connections use certificate-verified TLS
  supplied by the application. TLS parameters are stripped from the database
  URL, production startup rejects plaintext or verification-bypass
  configuration with safe diagnostics, an optional provider CA is supported
  without committing secrets, and a separately gated emergency bypass never
  enables plaintext. Policy documented in `docs/database-tls-policy.md`.
- Evidence-based anchor availability transitions: discovery failures are
  classified (transient / deterministic / unknown) and a destructive status
  change requires consecutive-failure or sustained-window evidence, so one
  transient SEP-1 timeout no longer marks a healthy anchor DOWN. Recovery to
  LIVE requires repeated successful evidence, and bounded per-anchor health
  rows (`anchor_health_states`) make transitions deterministic across process
  restarts. Policy documented in `docs/anchor-health-policy.md`.

## [Prior work] — 2026-09-25

Summary of development before this changelog was introduced. Only highlights
are listed; see the full commit history for details.

### Added

- SEP-10 authentication boundary and opt-in integration harness.
- SEP-38 quote client and rate engine with live rate sources, a latest-rate
  read model, and a public rates API.
- Public anchors and corridors APIs with reviewed, offline-auditable
  anchor/corridor registries.
- Reputation engine and public reputation API.
- Scheduled refresh for keeping rates and evidence current.
- Public dashboard and landing page, including rate-source, anchor-capability,
  and evidence-legend transparency.
- Production deployment on Vercel with a manual production-migration workflow
  and a manual production registry bootstrap workflow.

### Changed

- Aligned rate identity with persisted evidence.
- Aligned documentation with production and added the contribution workflow.

[Unreleased]: https://github.com/Aboyeji-Isaac/StellarCore/commits/main/
[Prior work]: https://github.com/Aboyeji-Isaac/StellarCore/tree/main
