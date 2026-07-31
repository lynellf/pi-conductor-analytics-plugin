# Changelog

All notable changes to this project are documented in this file.

## [0.2.0] - 2026-07-30

### Added

- Added a Pi-independent `AnalyticsReporter` API and `createAnalyticsReporter()` factory for library integrations, including configurable source labels and lifecycle control.
- Added non-blocking, batched HTTP delivery with bounded queueing, deterministic retries, request cancellation, diagnostics, and delivery statistics.
- Added JSONL backfill with atomic watermark sidecars and at-least-once delivery semantics.
- Added file-mutation telemetry contracts for `tool_execution_end` and `tool` records.

### Changed

- Watermarks now advance only over contiguous successfully delivered records and are updated only after delivery is acknowledged.
- Retry defaults now use a 100 ms base delay, 2 s maximum delay, and no jitter.
- Flush and shutdown now respect a single overall deadline; invalid non-positive deadlines are rejected.

### Fixed

- Applied retry delays before retry attempts and skip retries for non-retryable HTTP responses.
- Made bounded-queue overflow visible through immediate and rate-limited diagnostics.
