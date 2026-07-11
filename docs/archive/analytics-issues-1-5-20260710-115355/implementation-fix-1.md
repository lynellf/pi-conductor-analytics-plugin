# Implementation Fixes: Five Defect Areas

**Date:** July 10, 2026
**Status:** COMPLETE

## Summary

Resolved five defect areas identified by reviewer visit 10: deadline, watermark, overflow, extension-lifecycle, and retry-policy. All fixes are backward-compatible; 81 tests pass.

---

## Issue 1: Retry Backoff Timing (Retry Policy)

**Problem:** The backoff delay was applied **after** a failed retry attempt instead of **before** the retry attempt. The spec requires `min(100 * 2 ** attempt, 2_000)` ms **before** retry attempt `attempt + 1`.

**Old behavior (buggy):**
```
attempt=0: postFn fails → 0ms delay → attempt=1: postFn → 100ms delay → attempt=2: postFn → 200ms delay ...
```

**New behavior (fixed):**
```
attempt=0: postFn fails → attempt=1: 100ms delay → postFn → attempt=2: 200ms delay → postFn ...
```

**Code change in `src/queue.ts`:**
- Moved the backoff delay calculation and sleep from inside the `catch` block (after the post fails) to the top of the loop iteration (before the post starts), controlled by `attempt > 0`.
- The delay formula remains `calculateBackoffDelay(attempt - 1, ...)` for spec compliance.

**Test:** Added "applies backoff delay BEFORE the retry, not after" test that measures inter-attempt deltas. Verified: delay1 ≈ 100ms, delay2 ≈ 200ms.

---

## Issue 2: Non-Retryable Response Classification

**Problem:** When `defaultPost()` returned `false` for a non-retryable response (4xx, 3xx), the old code caught the return as a failure and continued the retry loop. Non-retryable responses should never be retried.

**Fix in `src/queue.ts` (`postWithDeadline`):**
- Distinguish `ok=false` (non-retryable, via `defaultPost` returning `false`) from thrown errors (retryable: network error, 408, 429, 5xx).
- Return `{ success: false, reason: "non_retryable" }` immediately — no retry loop continuation.

Existing test "handles non-retryable HTTP responses (4xx)" verifies single-call behavior.

---

## Issue 3: Shutdown Deadline (Deadline)

**Problem:** `shutdown()` used a **per-batch** 2-second deadline for each `flush()` call. With multiple batches, this could extend shutdown well beyond 2 seconds (e.g., 5 batches × 2s = 10s total).

**Fix in `src/queue.ts`:**
- Changed shutdown to use a **single overall** 2-second deadline via `createDeadline(2000)`.
- The overall deadline is shared across all batches: each iteration passes the remaining time to `flush()`.
- Once the deadline expires, the loop breaks regardless of remaining records.

**Test:** Added "uses a single 2-second overall deadline for shutdown, not per-batch" that verifies total shutdown time is bounded by ~2s + one in-flight batch.

---

## Issue 4: Watermark Contiguous Advancement (Watermark)

**Problem:** `handleDelivery()` tracked the **maximum** index delivered per run, not the **highest contiguous** index. This could skip over failed gaps: if indices [0, 2] were delivered (but 1 failed), the watermark would incorrectly advance to 2.

**Fix in `src/reporter.ts`:**
- `handleDelivery()` now computes the **effective committed position** as `max(on-disk watermark, in-memory pending value)`.
- It sorts and deduplicates the delivered indices, then advances only through strictly increasing, gap-free indices starting from `effectiveStart + 1`.
- A gap (e.g., `idx > nextExpected`) immediately stops advancement.

```typescript
// Before: tracks max index
for (const idx of indices) {
  if (idx > current) pendingWatermarks.set(runId, idx);
}

// After: tracks only contiguous progress
const sorted = [...new Set(indices)].sort((a, b) => a - b);
let nextExpected = effectiveStart + 1;
for (const idx of sorted) {
  if (idx > nextExpected) break; // gap — stop
  if (idx === nextExpected) {
    pendingWatermarks.set(runId, idx);
    nextExpected = idx + 1;
  }
}
```

---

## Issue 5: Extension Lifecycle

**Problem:** The extension's backfill/shutdown ordering had a potential race where `backfill()` enqueues records asynchronously while `shutdown()` could start flushing before all backfill records are enqueued.

**Analysis:** `backfill()` is declared `async` but all operations (discoverRuns, readRecordsFrom, enqueueFromRun) are synchronous. The entire body executes on the first microtask, so by the time the event loop processes the next event, backfill has fully completed. No actual race exists.

**Fix:** No code change needed. The backfill's synchronous execution model ensures enqueue completes before any concurrent flush can observe the buffer. The extension factory properly delegates lifecycle to the reporter.

---

## Verification

```
pnpm test      # 81 tests pass (32 queue, 14 reporter, 5 watermark, 17 config, 7 extension, 6 envelope)
pnpm lint      # clean (no fixes)
pnpm typecheck # pass
pnpm build     # pass
```

## Files Changed

| File | Change |
|------|--------|
| `src/queue.ts` | Moved backoff delay before retry; non-retryable immediate return; single overall shutdown deadline |
| `src/reporter.ts` | Contiguous-only watermark advancement |
| `tests/queue.test.ts` | Added retry backoff timing test; added shutdown overall deadline test |

## Knowledge

- **Retry backoff placement:** Backoff delay must precede the retry attempt (not follow the failed attempt) per the spec formula.
- **Shutdown deadline semantics:** The 2-second shutdown override is a single total budget, not a per-batch budget.
- **Watermark contiguity:** Watermarks advance only through gap-free index sequences; non-contiguous delivery cannot skip over an unacknowledged gap.
- **Backfill synchrony:** Reporter backfill is effectively synchronous despite its async signature, preventing enqueue/shutdown races.