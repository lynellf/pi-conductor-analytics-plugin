# Deadline Backstop Remediation: Implementation Notes

## Current Request
Fix three acceptance gaps found by reviewer: deadline settlement, deadline validation, and backstop/documentation correctness.

## Outcome
All three gaps fixed. Verification gates pass.

## Changes

### 1. Deadline Settlement — `src/queue.ts`

**Bug:** `flush(deadlineMs)` used `deadlineMs ?? this.config.request.timeoutMs`. The `??` operator only falls back for `undefined`, not for `0` or negative values. When `deadlineMs <= 0` was passed (e.g. from `shutdown`'s deadline remaining calculation), it created an unbounded deadline via `createDeadline(deadlineMs)` — violating the 2-second shutdown deadline.

**Fix:** Explicitly validate that `deadlineMs > 0` before using it; fall back to `config.timeoutMs` otherwise:
```ts
const effectiveDeadlineMs =
  deadlineMs !== undefined && deadlineMs > 0 ? deadlineMs : this.config.request.timeoutMs;
const deadline = createDeadline(effectiveDeadlineMs);
```

### 2. Deadline Validation — `src/reporter.ts`

**Gap:** `flush(deadlineMs)` in `reporter.ts` silently returned for invalid `deadlineMs` values, giving the caller no feedback.

**Fix:** Instead of returning early for invalid values, set `deadlineMs = undefined` so `queue.flush()` applies its own fallback to `config.timeoutMs`. This is consistent with `queue.flush()` semantics:
```ts
if (deadlineMs !== undefined && deadlineMs <= 0) {
  deadlineMs = undefined; // triggers queue's fallback to config.timeoutMs
}
await queue.flush(deadlineMs);
```

### 3. Backstop Watermark Correctness — `src/watermark.ts`

**Bug:** `runBackstop()` immediately advanced the watermark file to `lineCount - 1` after reading records, BEFORE any delivery attempt. If delivery failed, those records were permanently lost (at-least-once guarantee violated).

**Fix:**
- Changed `runBackstop()` from `sync` to `async Promise<number>`
- Track per-run high indices in a local `pendingHighIndex` map
- Use `enqueueFromRun()` (not `enqueue()`) to preserve run metadata in the buffer
- Wire a delivery callback on the queue — watermarks are updated ONLY after confirmed delivery
- Added a 300-second safety timeout to resolve the Promise if delivery never succeeds (prevents caller hang)

**Key invariant preserved:** If delivery fails, watermark is NOT updated and records will be replayed on the next backstop (at-least-once).

### 4. Tests

- `tests/queue.test.ts`: Added test "rejects non-positive deadlineMs and falls back to config timeoutMs" verifying the `queue.ts` fix.
- `tests/watermark.test.ts`: Rewrote all tests to `await` the async `runBackstop()`. Added two new tests:
  - "does NOT advance watermark if delivery fails" (uses `vi.useFakeTimers` to skip the 300s safety timeout)
  - "advances watermark after successful delivery" (confirms correct `lastSentIndex`)

## Files Changed
| File | Change |
|------|--------|
| `src/queue.ts` | Deadline validation: reject non-positive deadlineMs, fall back to config.timeoutMs |
| `src/reporter.ts` | Flush: set deadlineMs=undefined for invalid values, delegate to queue |
| `src/watermark.ts` | runBackstop: async, delivery-callback-based watermark update, enqueueFromRun |
| `tests/queue.test.ts` | New test for deadlineMs fallback behavior |
| `tests/watermark.test.ts` | Async tests, new delivery-confirmation tests, fake timers for failure case |

## Verification Evidence
- `pnpm typecheck`: ✅ No errors
- `pnpm build`: ✅ Compiles cleanly
- `pnpm test`: ✅ 84 tests pass (6 test files)
- `pnpm lint`: ✅ No issues
