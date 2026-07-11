# Phase 1: Define and wire the embeddable reporter API

**Status: IMPLEMENTED** (July 10, 2025)

## Implementation Summary

This phase established the Pi-independent `AnalyticsReporter` lifecycle boundary from issue #1 without changing normal extension behavior.

## Objective

Create the Pi-independent lifecycle boundary from issue #1 without changing normal extension behavior. Establish source/runs-directory/config-path plumbing before delivery and watermark internals are hardened.

## Ordered tasks

### 1. Add the public reporter contract

- Update `src/types.ts` with `AnalyticsRecord`, `AnalyticsReporter`, `AnalyticsReporterOptions`, and source-capable `AnalyticsEnvelope` types. Keep the existing default source literal compatible by allowing the configured source at the internal/public envelope boundary.
- Keep `QueueStats`, `AnalyticsConfig`, `ResolvedConfig`, and existing exports intact unless a type alias/overload is needed.
- Define that `enqueue()` validates the minimal record shape and returns immediately; invalid input is ignored and diagnosed without throwing.

**Acceptance:** The public types do not import pi-conductor or Pi extension types, and existing callers can still construct the current envelope/queue types.

### 2. Make configuration and envelope construction injectable

- In `src/config.ts`, add an explicit-file loader or equivalent helper used by `configPath`; apply the same JSON parsing, validation, defaults, and warning redaction as discovered config.
- Preserve `getConfig(cwd)` lookup order and cache behavior for existing extension users. Do not let a supplied reporter `configPath` get replaced by process-global cached config.
- In `src/envelope.ts` and `src/queue.ts`, add source as an option/default rather than hard-coding `pi.events:conductor:record`. Preserve the existing default for `createEnvelope()` and `DeliveryQueue` callers.

**Acceptance:** A library caller can select a config file and source; current `createEnvelope(records, cwd)` output is unchanged except for internal implementation details.

### 3. Implement `createAnalyticsReporter`

- Add `src/reporter.ts` with a factory that owns resolved config, `DeliveryQueue`, explicit `cwd`, explicit `runsDir`, source, record validation, `backfill()`, `flush()`, `shutdown()`, and `stats()`.
- Make `backfill()` use the explicit `runsDir`; do not derive it from `cwd` inside the reporter. Keep the reporter disabled/no-op when config is disabled or has no endpoint.
- Expose the factory and types from `src/index.ts`.
- Ensure queue diagnostics can be passed through a callback owned by the adapter (the callback contract may be completed in Phase 2).

**Acceptance:** A caller can create a reporter without Pi, enqueue a valid record, flush/shutdown it, obtain stats, and invoke backfill against a temporary explicit runs directory. Disabled configuration performs no network work and all lifecycle methods settle.

### 4. Convert the extension into a thin adapter

- Refactor `extensions/analytics.ts` to create the reporter once using `process.cwd()`, the default conductor runs directory, and the default event source.
- Forward only valid `pi.events` records to `reporter.enqueue()`, invoke `reporter.backfill()` once from `session_start`, and invoke `reporter.shutdown()` from `session_shutdown`.
- Retain config warning behavior, no-record warning behavior, `ctx.ui.notify` lifecycle messages, and the current inactive behavior. Ensure no reporter is created or event listener registered when config is disabled.
- Ensure module-level state does not leak across multiple factory invocations in tests or co-loaded extension instances.

**Acceptance:** Co-loaded pi-conductor + analytics still receives and queues records exactly once; the adapter contains no delivery or watermark business logic and never loads in spawned sessions as a new behavior.

### 5. Add focused reporter and adapter tests

- Add `tests/reporter.test.ts` using an isolated temp CWD/runs directory and injected post function. Cover enqueue/flush/shutdown/stats, explicit source in the outgoing envelope, explicit runs directory, config-path selection, and disabled configuration.
- Extend `tests/extension.test.ts` to assert the adapter forwards valid records, ignores invalid records, calls backfill only once, shuts down, and retains the existing Pi event wiring.
- Use cleanup for timers, temp files, and reporter shutdown in every test.

## Verification checkpoint

```bash
pnpm vitest run tests/reporter.test.ts tests/extension.test.ts
pnpm typecheck
pnpm build
```

## Dependencies

None for the contract; Phase 2 must complete the queue callback/signal details before the reporter can be considered production-ready.

## Stop/rollback conditions

- Stop if preserving existing low-level exports requires an undocumented breaking signature; add an overload/adapter before proceeding.
- Stop if extension tests show duplicate queue instances or duplicate event delivery; resolve lifecycle ownership before Phase 2.
- Roll back only the adapter wiring if the public reporter tests pass but Pi integration regresses; do not discard the standalone reporter contract.

## Files likely touched

- `src/types.ts`
- `src/config.ts`
- `src/envelope.ts`
- `src/reporter.ts` (new)
- `src/index.ts`
- `extensions/analytics.ts`
- `tests/reporter.test.ts` (new)
- `tests/extension.test.ts`
