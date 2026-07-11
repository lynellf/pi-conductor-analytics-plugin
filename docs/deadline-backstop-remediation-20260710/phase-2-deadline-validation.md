# Phase 2: Deadline Validation Fix

## Summary
Fixed `reporter.flush()` to explicitly handle non-positive `deadlineMs` by delegating to `queue.flush()` fallback, instead of silently returning.

## Root Cause
`reporter.flush()` had:
```ts
if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || deadlineMs <= 0)) {
  return; // Silently ignore
}
```
This silently swallowed invalid deadlines. Callers (including `shutdown()`) got no flush operation when passing an invalid deadline, with no indication of why.

## Fix
Changed to match `queue.flush()` semantics — non-positive values fall back to the config timeout:
```ts
if (deadlineMs !== undefined && deadlineMs <= 0) {
  deadlineMs = undefined; // triggers queue's fallback to config.timeoutMs
}
await queue.flush(deadlineMs);
```

Rationale: The caller's intent (a deadline override) should be honored as a best-effort. Falling back to the config default (5s) rather than silently no-opping is more useful behavior for library callers.
