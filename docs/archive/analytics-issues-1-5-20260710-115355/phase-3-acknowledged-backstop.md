# Phase 3: Make backstop progress acknowledgement-driven and crash-safe

## Objective

Resolve issue #3 by coupling backfill items to successful queue delivery while preserving at-least-once replay and explicit run-directory support.

## Ordered tasks

### 1. Refactor JSONL scanning to retain delivery identity

- In `src/watermark.ts`, replace the current enqueue-only scan result with records carrying `{ record, runId, lineIndex }` (or equivalent private metadata), while keeping `runBackstop(cwd, queue, config)` as a compatibility wrapper.
- Add an explicit-runs-dir path used by `AnalyticsReporter.backfill()`; do not assume `cwd/.pi-conductor/runs` in the new API.
- Parse only complete newline-terminated JSONL lines. Preserve physical indexes. Diagnose malformed complete lines without uploading them; do not advance past an incomplete trailing line so it can be retried after restart.
- Keep run discovery deterministic and avoid matching watermark sidecars as JSONL runs.

**Acceptance:** Backfill returns/queues the correct records and identity for each run, ignores malformed data safely, and a trailing partial line remains eligible on the next scan.

### 2. Add delivery acknowledgement metadata to the queue

- Extend queue items internally so a backfill item has an acknowledgement callback/metadata and normal live events do not require one.
- On a successful HTTP batch, invoke acknowledgements for every item in that batch only after the full envelope returns 2xx. On a failed, timed-out, non-retryable, or dropped batch invoke none.
- Ensure batching, overflow drops, shutdown flushes, and queue stats continue to work with mixed live/backfill items.
- Keep callbacks guarded and synchronous only for lightweight progress bookkeeping; they must not perform network I/O or throw into the queue.

**Acceptance:** A failed batch leaves its watermark untouched; a successful batch can notify all included run/index pairs; overflow and failure paths never falsely acknowledge.

### 3. Implement contiguous per-run progress and atomic sidecars

- Add a progress tracker in `src/watermark.ts`/`src/reporter.ts` that starts from each run's committed watermark, records successful indexes, and advances only through the highest contiguous acknowledged line. Never let a later success jump over a failed gap.
- Write sidecars with a temp file created in the same runs directory, flush/close it, then `renameSync` (or equivalent atomic rename). Clean up temp files on failure and keep the prior valid sidecar.
- Decide and document how complete malformed lines are accounted for without treating an unacknowledged valid record as sent. Keep incomplete trailing content below the committed position.

**Acceptance:** Multiple batches and interleaved runs cannot skip gaps; a crash during sidecar replacement leaves either the old or new valid watermark; a successful contiguous prefix advances exactly once.

### 4. Integrate backfill lifecycle in the reporter and adapter

- Make `AnalyticsReporter.backfill()` return the count of records queued and attach acknowledgement metadata automatically.
- Update the Pi adapter's `session_start` handling to report backfill count but not claim delivery merely because enqueue succeeded.
- Ensure `shutdown()` performs the bounded best-effort flush and leaves failed backfill records for a later run. Do not add an unbounded in-memory retry loop after deadline expiry.

**Acceptance:** A failed backfill followed by a new reporter instance re-enqueues the same records; a successful backfill advances the sidecar only after the post succeeds; normal event delivery remains unchanged.

### 5. Add failure/restart/partial-file tests

- Extend `tests/watermark.test.ts` with injected queue/post behavior for failed and timed-out batches, successful replay, restart/re-enqueue, partial success across multiple batches, interleaved runs, atomic-write failure preservation, and malformed trailing JSONL.
- Add reporter-level tests proving explicit `runsDir`, backfill count, acknowledgement timing, and duplicate-on-crash semantics.
- Retain existing compatibility tests for the legacy `runBackstop(cwd, queue, config)` path.

## Verification checkpoint

```bash
pnpm vitest run tests/watermark.test.ts tests/reporter.test.ts
pnpm typecheck
pnpm build
```

## Dependencies

Phase 2's abort/deadline semantics are required so a timed-out batch is a definite non-acknowledgement. Phase 1's reporter owns the explicit runs directory.

## Stop/rollback conditions

- Stop if any watermark is written during enqueue, before a successful batch acknowledgement, or after a non-contiguous acknowledgement.
- Stop if malformed trailing content can move the watermark past a valid record that was not delivered.
- If atomic rename is unavailable on a supported runtime, preserve the old sidecar and fail the advancement visibly; never fall back to direct overwrite.

## Files likely touched

- `src/watermark.ts`
- `src/queue.ts`
- `src/reporter.ts`
- `src/types.ts`
- `extensions/analytics.ts`
- `tests/watermark.test.ts`
- `tests/reporter.test.ts`
