# Phase 1: Deadline Settlement Fix

## Summary
Fixed `queue.flush()` deadline validation to explicitly reject non-positive `deadlineMs` values instead of silently passing them to `createDeadline()`.

## Root Cause
`deadlineMs ?? this.config.request.timeoutMs` only falls back for `undefined`, not for `0` or negative values. When `shutdown()` computed a small positive `remaining` value and passed it to `flush()`, the behavior was accidentally correct. But the semantic intent was wrong: any non-positive `deadlineMs` should fall back to the config timeout, not be used as-is.

## Fix
`src/queue.ts`: Changed `flush()` to use explicit validation:
```ts
const effectiveDeadlineMs =
  deadlineMs !== undefined && deadlineMs > 0 ? deadlineMs : this.config.request.timeoutMs;
const deadline = createDeadline(effectiveDeadlineMs);
```

This ensures:
- `undefined` → uses config.timeoutMs ✓
- `0` → uses config.timeoutMs ✓ (was creating unbounded deadline before)
- `-5` → uses config.timeoutMs ✓
- `100` → uses 100ms ✓
