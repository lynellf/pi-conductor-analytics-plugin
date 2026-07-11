# Phase 2: Make delivery deadlines, retry policy, and overflow diagnostics real

## Objective

Resolve issues #2, #4, and #5 in the shared queue before wiring delivery acknowledgements into the backstop.

## Ordered tasks

### 1. Extend the post contract with cancellation

- In `src/queue.ts`, change the internal `PostFunction` contract to accept an `AbortSignal` (or a documented options object) as an additive parameter. Existing test functions with fewer parameters must remain assignable.
- Pass the signal from `postWithTimeout()` to `postFn()` and from `defaultPost()` into `fetch()`.
- Preserve JSON body, content type, custom headers, and current 2xx/non-retryable/retryable status classification.

**Acceptance:** A default post receives a live signal; injected posts can observe abort; no secrets or records are included in errors.

### 2. Implement one overall deadline and cleanup-safe abort path

- Refactor `postWithTimeout()` around a deadline (`startedAt + effectiveTimeout`) rather than a timer that only aborts an unused controller.
- Abort the in-flight attempt at deadline, stop retries after abort/deadline, and return `false` rather than throw.
- Clear timeout handles and any abort listeners in `finally` paths. Make shutdown's explicit 2,000 ms timeout use the same machinery and settle even when the injected post never resolves (the injected implementation must honor the signal; add a defensive deadline race if needed).
- Keep queue event handlers fire-and-forget: all background `flush()` rejections remain contained.

**Acceptance:** A never-resolving post/fetch causes `flush()` to settle within the configured timeout and `shutdown()` within its 2-second override; success/failure tests leave no active timers.

### 3. Isolate deterministic capped exponential backoff

- Add an exported-for-test or otherwise directly testable helper in `src/queue.ts` (or a small `src/retry.ts`) that computes `min(100 * 2 ** attempt, 2000)`.
- Before each retry, calculate remaining deadline and sleep only for `min(backoff, remaining)`. Check abort/deadline before and after sleeping; do not start a retry when no time remains.
- Keep retries at `maxRetries + 1` total attempts and retain status policy 408/429/5xx retryable, other HTTP results non-retried.

**Acceptance:** Fake-timer tests observe 100/200/400/... capped at 2,000 ms, exact maximum attempts, no post-retry for non-retryable 4xx, and no sleep beyond the deadline.

### 4. Add overflow diagnostics and stable metrics

- Add a queue options/callback contract in `src/types.ts`/`src/queue.ts` containing dropped count, pending count, and an aggregate/suppressed count if applicable.
- On oldest-drop, increment cumulative stats and invoke the callback synchronously for the first overflow. Rate-limit later callbacks (default 5,000 ms) while aggregating suppressed drops; reset the notification window/aggregation after pending records drain. The callback must be guarded so a throwing observer cannot affect enqueue.
- Return a snapshot from `stats()` with cumulative `dropped` and current `pending`; retain `overflowCount()` compatibility if existing consumers use it.
- Give the reporter and Pi adapter a way to subscribe without requiring the `conductor:record` callback's context. The adapter should log count-only warnings immediately and retain the latest aggregate for UI notification during `session_start`/`session_shutdown`.

**Acceptance:** The first overflow diagnostic includes dropped and pending counts, repeated bursts are rate-limited/aggregated, stats remain accurate through drain/recovery, and no callback can block or throw into enqueue.

### 5. Update queue tests

- Extend `tests/queue.test.ts` for signal propagation, never-resolving timeout, bounded shutdown, timer cleanup, retry sequence/deadline, status classification, and overflow callback/rate-limit/recovery behavior.
- Prefer fake timers for backoff and rate limiting; use a deferred promise for never-resolving posts and always close queues/timers in `afterEach`.

## Verification checkpoint

```bash
pnpm vitest run tests/queue.test.ts
pnpm vitest run tests/reporter.test.ts tests/extension.test.ts
pnpm typecheck
pnpm build
```

## Dependencies

Phase 1 reporter contract is required for adapter propagation, but the queue changes should preserve standalone construction and can be implemented before the Phase 1 adapter is finalized.

## Stop/rollback conditions

- Stop if a timeout test still depends on an injected post resolving after abort; add a bounded race/cleanup design rather than weakening the test.
- Stop if fake timers reveal retries can outlive `request.timeoutMs`; do not proceed to watermark acknowledgements until the deadline is authoritative.
- If diagnostics cause measurable synchronous work beyond counter updates, reduce the callback to a guarded count-only emission before continuing.

## Files likely touched

- `src/queue.ts`
- `src/types.ts`
- `src/retry.ts` (optional new helper)
- `src/reporter.ts`
- `extensions/analytics.ts`
- `tests/queue.test.ts`
- `tests/reporter.test.ts`
- `tests/extension.test.ts`
