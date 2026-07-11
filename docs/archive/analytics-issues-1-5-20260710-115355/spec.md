# Spec: Analytics plugin issues 1–5

## Goal

Resolve all five open issues in `lynellf/pi-conductor-analytics-plugin` in one compatible implementation: expose a Pi-independent reporter for library integrations, make HTTP cancellation and retry timing real and bounded, make JSONL backstop watermarks delivery-aware and crash-safe, and surface bounded-queue loss promptly without compromising the plugin's non-blocking behavior.

## Current request

Implement the scope of GitHub issues [#1](https://github.com/lynellf/pi-conductor-analytics-plugin/issues/1) through [#5](https://github.com/lynellf/pi-conductor-analytics-plugin/issues/5), preserving normal `pi install` behavior and existing low-level exports where practical.

## Findings

- `extensions/analytics.ts` currently owns config loading, `DeliveryQueue`, event subscription, backstop invocation, and shutdown handling. It is not reusable by a library caller.
- `src/queue.ts` removes a batch before delivery, creates an `AbortController` without passing its signal to the injected post function, and retries at 100/200/300 ms (linear rather than exponential).
- `defaultPost()` does not receive or pass an abort signal to `fetch()`.
- `src/watermark.ts` advances a watermark immediately after `enqueue()`, so an HTTP failure can permanently hide records on the next run. It derives `.pi-conductor/runs` from `cwd` and writes sidecars directly.
- Queue overflow drops the oldest item and increments counters, but has no prompt diagnostic callback. `stats()` already exposes the basic counters.
- The README documents a 500-record cap, exponential backoff, and outage recovery, but those claims are not all true in the current implementation.
- There is no `.okf/` directory in this checkout. The archived design under `docs/archive/conductor-analytics-plugin/` is useful background but predates the current implementation and the five issue reports.

## Behavior and public contract

### Reporter API (issue #1)

Add a Pi-independent public factory and lifecycle interface from `src/index.ts`:

```ts
export interface AnalyticsReporter {
  enqueue(record: AnalyticsRecord): void;
  backfill(): Promise<number>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): QueueStats;
}

export interface AnalyticsReporterOptions {
  cwd: string;
  runsDir: string;
  configPath?: string;
  source?: string;
}

export function createAnalyticsReporter(
  options: AnalyticsReporterOptions,
): AnalyticsReporter;
```

`AnalyticsRecord` remains a minimal structural type (`Readonly<Record<string, unknown>>` with a string `type`), not a pi-conductor import. `source` defaults to `pi.events:conductor:record`; callers may provide `library:conductor:record` or another explicit label. `runsDir` is mandatory at the reporter boundary so library integrations never depend on the process CWD. `configPath`, when supplied, is used directly; otherwise existing lookup precedence is retained. The exact type names may follow repository conventions, but the exported boundary and semantics are fixed by this spec.

The reporter owns validation, config resolution, queue construction, JSONL backfill, source-aware envelopes, flush, shutdown, and diagnostics. The Pi extension becomes an adapter: it creates one reporter, forwards valid `conductor:record` events, calls `backfill()` on session start, and calls `shutdown()` on session shutdown. It must not load the control-plane reporter into spawned role sessions or add a pi-conductor dependency.

Existing exports (`getConfig`, `DeliveryQueue`, `defaultPost`, `runBackstop`, and envelope/type exports) remain available. If a signature must change, retain an overload or compatibility adapter and document it.

### Delivery and retry (issues #2 and #4)

- Injected post functions receive an `AbortSignal`; `defaultPost()` passes it to `fetch()`.
- Each flush has one overall deadline, using the configured request timeout or the explicit shutdown timeout. A never-settling post is aborted and the flush resolves as a failed best-effort operation within that deadline.
- Retryable failures remain HTTP 408, 429, and 5xx plus thrown transport errors. Non-retryable responses are not retried.
- Use deterministic capped exponential backoff with no jitter for this release: `min(100 * 2 ** attempt, 2_000)` milliseconds before retry attempt `attempt + 1`. Sleep is capped by remaining deadline; no retry starts after the deadline.
- Clear timeout/abort resources on every success, failure, and abort path. Delivery failures remain contained and never throw into conductor lifecycle handlers.

### Backstop and watermarking (issue #3)

Backfill records carry run identity and their physical JSONL line index internally. The queue acknowledges backfill items only after the complete HTTP batch succeeds. A failed, timed-out, dropped, or process-interrupted batch produces no watermark advancement. Successful acknowledgements are accumulated per run and advance only through the highest contiguous acknowledged line; an acknowledgement after a failed gap cannot skip that gap. This gives at-least-once recovery: duplicates are possible after a crash, but undelivered records are not silently marked sent.

JSONL scanning must distinguish complete newline-terminated lines from an incomplete trailing line. Valid records from complete lines may be queued; a malformed complete line is skipped with a diagnostic and is not treated as a delivered record. An incomplete/malformed trailing line is left below the committed watermark so a later run can retry it. The implementation must preserve enough line/index metadata to satisfy contiguous advancement and must not enqueue full pi role-session transcript files.

Watermark sidecars are written crash-safely using a temporary file in the same directory followed by atomic rename. Explicit `runsDir` is supported by the reporter; the legacy `runBackstop(cwd, ...)` behavior remains compatible or is a documented adapter.

### Overflow diagnostics (issue #5)

Queue capacity remains 500 pending records and overflow remains non-blocking oldest-drop behavior. Add an optional diagnostic callback/event with stable data including dropped count and pending count. Emit the first overflow immediately; rate-limit subsequent notifications (5 seconds is the default) and aggregate suppressed drops. Reset the rate-limit/aggregation state after the queue drains. `stats()` remains the programmatic source of cumulative `dropped` and current `pending` metrics, and the reporter exposes it.

The Pi adapter supplies a safe callback that logs a redacted warning immediately (no headers or records), then surfaces the latest aggregate through `ctx.ui.notify` from session lifecycle handlers when a UI context exists. No overflow path requires a conductor record handler context, throws, awaits, or blocks.

## Constraints

- Best-effort analytics must never block or fail pi-conductor.
- Preserve incoming records unchanged in `records[]`.
- Do not log endpoint credentials, interpolated header values, full records, or environment variables.
- Do not read or upload role-session transcript files referenced by `session_file`.
- Do not add a direct pi-conductor dependency solely for types.
- Keep JSON configuration and current config precedence for the extension.
- Keep Node/TypeScript/Vitest/Biome conventions from `package.json`, `tsconfig*.json`, and `biome.json`.

## Non-goals

- Exactly-once delivery or server-side deduplication.
- Persistent outbox storage beyond the existing JSONL source and watermark sidecars.
- YAML/TOML configuration.
- Changes to pi-conductor itself.
- Loading analytics into every spawned role session.
- A redesign of the external analytics schema beyond adding configurable `source`.

## Assumptions

- The endpoint treats duplicate envelopes as acceptable under at-least-once recovery; the README will state this explicitly.
- A physical JSONL line index is the least invasive compatible watermark identity. Complete malformed lines can be diagnosed and skipped; incomplete trailing content must remain replayable.
- A deterministic backoff without jitter is preferable because issue #4 requires exact fake-timer verification and does not require jitter.
- `configPath` takes precedence over discovered config paths and is read with the same validation/default rules.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Changing queue item shape breaks existing callers | Keep `enqueue(record)` valid; make delivery metadata/options additive and preserve existing exports. |
| A batch contains records from multiple runs | Acknowledge each metadata-bearing item only after batch success; advance each run independently through contiguous indexes. |
| A crash occurs after POST success but before watermark rename | Treat replay as expected at-least-once behavior; use atomic rename and document duplicates. |
| Abort races with a resolved fetch or retry sleep | Centralize deadline handling, clear timers in `finally`, and check the signal before every retry/sleep. |
| Diagnostics become noisy or leak data | Rate-limit/aggregate, include counts only, and never include payload/header values. |
| Backstop scanning large run files increases memory | Preserve current bounded queue and use bounded line/batch processing or an explicit implementation stop condition if streaming is needed. |

## User decisions

None are required to implement the issue acceptance criteria. The plan assumes deterministic capped exponential backoff and physical JSONL line indexes as stated above.

## Acceptance criteria

1. `createAnalyticsReporter` is exported, Pi-independent, accepts explicit `cwd`, `runsDir`, optional `configPath`, and source, and owns the reporter lifecycle; the extension is a thin compatible adapter.
2. A never-resolving injected post/fetch is aborted; normal flush and the 2-second shutdown override settle within their deadlines with no dangling timers.
3. Retry behavior is deterministic capped exponential, documented identically in code/tests/README, respects the overall deadline, and preserves retryable/non-retryable status behavior.
4. Failed or timed-out backfill does not advance a watermark; restart replays it; successful acknowledgements advance only contiguous progress; sidecar writes are atomic; malformed trailing JSONL remains replayable.
5. First and subsequent queue overflows produce safe, rate-limited/aggregated diagnostics; stats are accurate; the Pi adapter surfaces warnings without handler context; overflow remains non-blocking.
6. Focused tests cover each issue and the combined reporter/extension flow. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
7. README documents source selection, API usage, retry/deadline policy, at-least-once backstop semantics/duplicates, overflow diagnostics, and existing privacy/non-goal boundaries.

## Verification commands

Focused during implementation:

```bash
pnpm vitest run tests/queue.test.ts
pnpm vitest run tests/watermark.test.ts
pnpm vitest run tests/reporter.test.ts tests/extension.test.ts
```

Repository gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Telemetry

- `okf_docs_read`: 0 (`.okf/` is absent; archived documents were read as background)
- `okf_tokens_read`: unknown
- `source_files_read`: 17 relevant repository files (README, package/configuration, extension, source, and tests)
- `stale_okf_hits`: 1 (archived spec still describes the pre-implementation scaffold and does not include issues #1–#5)
- `missing_okf_hits`: 1 (`.okf/` topic map is absent)
