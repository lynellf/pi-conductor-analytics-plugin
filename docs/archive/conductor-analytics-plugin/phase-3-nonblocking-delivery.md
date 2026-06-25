# Phase 3: Non-blocking HTTP Delivery

## Goal
Send records to the configured endpoint without blocking pi-conductor.

## Tasks

### Task 3.1: Bounded queue
- Implement an in-memory queue with configurable `maxRecords` per batch and bounded total pending records.
- Event handler enqueues and returns immediately.
- On overflow, drop oldest or newest consistently and count drops for diagnostics.

Acceptance:
- Test verifies enqueue does not await `fetch`.
- Overflow test verifies bounded memory behavior.

### Task 3.2: POST worker
- Use Node 22 global `fetch` and `AbortController` timeout.
- POST `AnalyticsEnvelope` JSON.
- Apply configured headers and `Content-Type: application/json`.
- Retry bounded attempts for network errors and retryable HTTP statuses.

Acceptance:
- Tests cover 2xx success, non-retryable 4xx, retryable 5xx, timeout, and retry exhaustion.
- Failures are swallowed/logged and never thrown to event emitter.

### Task 3.3: Shutdown flush
- Listen for `session_shutdown` and request a short best-effort flush.
- Do not wait indefinitely.

Acceptance:
- Fake timer test proves shutdown flush respects timeout.

## Checkpoint
Run `pnpm typecheck && pnpm test`.
