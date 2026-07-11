# Phase 3: Backstop Watermark Correctness Fix

## Summary
Fixed `runBackstop()` to update watermarks ONLY after confirmed successful delivery, fixing a critical at-least-once guarantee violation.

## Root Cause
The old `runBackstop()` advanced the watermark immediately after reading records from JSONL, before any delivery attempt:
```ts
// OLD (buggy): updated before delivery!
for (const record of records) {
  queue.enqueue(record);
  totalEnqueued++;
}
if (lineCount > watermark + 1) {
  writeWatermark(runsDir, run.runId, lineCount - 1); // ← premature!
}
```
If delivery failed, records were permanently lost because the watermark had already advanced past them.

## Fix
1. **Changed `runBackstop()` to `async`**: returns `Promise<number>`
2. **Track per-run indices**: store `pendingHighIndex[runId]` for each run
3. **Use `enqueueFromRun()`**: preserves run metadata in buffer so delivery callback can identify which run delivered records belong to
4. **Wire delivery callback**: watermark is written ONLY when `result.success === true`
5. **300-second safety timeout**: resolves the Promise if delivery never succeeds (prevents caller hang; watermark is NOT advanced — at-least-once is preserved)

### Key Invariant Preserved
If delivery fails → watermark NOT updated → records replay on next backstop ✓

## Test Coverage
- "does NOT advance watermark if delivery fails": verifies no watermark file created when delivery fails
- "advances watermark after successful delivery": verifies `lastSentIndex === 1` (0-based) after delivering 2 records
- Both tests use `vi.useFakeTimers()` for the safety timeout

## Other Behavioral Changes
- `runBackstop()` is now `async Promise<number>` instead of `sync number`
- Library callers using `runBackstop()` directly must `await` the result
- The recommended path (`reporter.backfill()`) was already async and is unaffected
