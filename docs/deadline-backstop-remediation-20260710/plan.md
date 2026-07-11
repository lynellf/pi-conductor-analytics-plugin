# Deadline Settlement + Backstop Remediation Plan

## Issues to Fix

### 1. Deadline Settlement (`queue.ts`)
**Bug:** `flush(deadlineMs)` silently ignores non-positive `deadlineMs` values.
When `deadlineMs <= 0` is passed, `deadlineMs ?? this.config.request.timeoutMs` evaluates to `this.config.request.timeoutMs`
(because `??` only rejects `undefined`, not `0` or negative), but then `createDeadline(deadlineMs)` is called with that
positive value — the validation check only fires when `deadlineMs !== undefined`. Non-positive values pass through
untouched and create a deadline using `config.timeoutMs` (5000ms), overriding the caller's intent.

**Fix:** Validate that `deadlineMs` is a positive number before using it; fall back to `config.timeoutMs` otherwise.

### 2. Deadline Validation (`reporter.ts`)
**Gap:** `flush(deadlineMs)` in `reporter.ts` silently returns for invalid `deadlineMs` (e.g., `-5`). The caller
gets no feedback that their deadline was rejected.

**Fix:** Keep the early-return for `undefined`, but also handle non-positive numbers by falling back to
`config.timeoutMs` (consistent with `queue.flush()` semantics), and add a comment explaining the fallback.

### 3. Backstop Watermark Correctness (`watermark.ts`)
**Bug:** `runBackstop()` immediately advances the watermark file to `lineCount - 1` after reading records,
*before* any delivery attempt. If delivery fails, those records are lost permanently.

**Fix:** Make `runBackstop()` async, wire a delivery callback on the queue, and update watermarks only after
successful delivery is confirmed. The return type changes from `number` to `Promise<number>`.

## Files to Change

| File | Change |
|------|--------|
| `src/queue.ts` | Fix `flush()` deadline validation |
| `src/watermark.ts` | Make `runBackstop()` async; use delivery callback |
| `src/index.ts` | Update `runBackstop` export comment (already correct) |
| `tests/queue.test.ts` | Add test: rejects non-positive deadlineMs |
| `tests/watermark.test.ts` | Update tests for async runBackstop; add delivery-confirmation test |

## Verification Gates
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm lint`
