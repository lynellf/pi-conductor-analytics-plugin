# Analytics Issues 1-5: Defect Fixes

**Current Request:** Fix reviewer-identified defects: deadline timing, retry defaults, validation, and documentation mismatches.

**Outcome:** All blocking defects have been fixed and verified.

## Files Changed

- `src/config.ts` - Fixed retry defaults to match README: baseDelayMs=100, maxDelayMs=2000
- `src/types.ts` - Updated JSDoc defaults to match: baseDelayMs=100, maxDelayMs=2000
- `src/queue.ts` - Fixed deadline timing bug: recalculate `remaining` after delays
- `src/reporter.ts` - Added validation for flush deadlineMs parameter
- `README.md` - Added retry config fields to config table

## Defects Fixed

### 1. Retry Default Mismatch (FIXED)
- **Issue:** `config.ts` had `baseDelayMs: 200, maxDelayMs: 5000` but README documented `100ms, 2000ms`
- **Fix:** Updated defaults in `config.ts` to `baseDelayMs: 100, maxDelayMs: 2000`
- **Fix:** Updated JSDoc defaults in `types.ts` to match

### 2. Deadline Timing Bug (FIXED)
- **Issue:** In `postWithDeadline`, `remaining` was calculated before delay but used after delay
- **Fix:** Moved `remaining = deadline.remaining()` to after all delays to ensure accurate deadline tracking

### 3. Validation Edge Case (FIXED)
- **Issue:** `flush(deadlineMs?)` accepted any number without validation
- **Fix:** Added guard in reporter's flush() to silently ignore invalid (non-positive) deadline values

### 4. Documentation Incomplete (FIXED)
- **Issue:** README config table missing retry sub-fields
- **Fix:** Added `request.retry.baseDelayMs`, `request.retry.maxDelayMs`, `request.retry.jitterFactor` to config table

## Verification Evidence

```
pnpm test      # 81 tests pass (6 test files)
pnpm lint      # No fixes applied
pnpm typecheck # Pass
pnpm build     # Pass
```
