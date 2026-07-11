# Defect Fixes: Retry Config + Deadline Tracking + Input Validation

## Current Request
Commit uncommitted defect fixes across 5 source files with one git commit.

## Outcome
All 5 files with defect fixes committed. Verification gates passed.

## Files Changed
| File | Change |
|------|--------|
| `src/config.ts` | Fixed default retry config: baseDelayMs 200→100, maxDelayMs 5000→2000 |
| `src/queue.ts` | Fixed deadline tracking: moved `remaining` calculation AFTER delays |
| `src/reporter.ts` | Added validation for deadlineMs parameter in flush() |
| `src/types.ts` | Updated JSDoc to reflect new default values |
| `README.md` | Added documentation for new retry config options |

## Verification Evidence
- `pnpm typecheck`: ✅ Passed
- `pnpm build`: ✅ Passed  
- `pnpm test`: ✅ 81 tests passed
- `pnpm lint`: ✅ No issues
