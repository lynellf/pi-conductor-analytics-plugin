# Spec: pi-conductor Analytics Plugin

## What I found

- Current repo (`pi-conductor-analytics-plugin`) is essentially empty: README plus one sample `.pi-conductor/runs/<run_id>.jsonl`; no `package.json` yet.
- `pi-conductor` already exposes the hook needed for this plugin:
  - Public export: `subscribeToRecords` from `pi-conductor` / `src/host/index.ts`.
  - Extension bridge: `extensions/conduct.ts` subscribes internally and re-emits every record on `pi.events.emit("conductor:record", record)`.
  - `record-emitter.ts` is fire-and-forget and isolates listener errors; the durable JSONL log remains the source of truth.
- The conductor JSONL run telemetry shape is the `PersistedRecord` union in `src/persistence/log.ts`: `checkpoint_snapshot`, `session_started`, `session_ended`, `session_failed`, `transition_accepted`, `transition_rejected`, and `model_fallback`.
- Actual samples under `/Users/ezellfrazier/Documents/GitHub/pi-conductor/.pi-conductor/runs/*.jsonl` confirm those record types and fields. Records include `run_id`, role/session metadata, usage/cost, transition details, model fallback details, and full checkpoint snapshots. `session_started` records include `session_file` paths for pi session JSONL, but the conductor event payload does not include those session file contents.
- Feasibility: high. The plugin can be a separate pi extension that listens to `pi.events.on("conductor:record", ...)`, loads local/global config, and posts records or batches without blocking conductor. The main caveat is install/order dependency: `pi-conductor` must be installed and its extension loaded so it emits `conductor:record`.

## Objective

Build a separate pi extension package that reports pi-conductor run telemetry to an external HTTP endpoint.

Users can configure an endpoint in either their HOME directory or the current working directory where pi was launched. When pi-conductor emits persisted run records, this plugin sends the records to the configured endpoint in a best-effort, non-blocking manner.

## Feasibility verdict

**Feasible with low-to-medium implementation risk.** pi-conductor has already implemented the in-process record emitter and a `pi.events` bridge. This plugin does not need to modify pi-conductor for the MVP.

Caveats:
- The plugin reports conductor run records, not full nested pi role-session transcript contents, unless a future phase explicitly reads `session_file` paths.
- Delivery is best-effort; it should not block or fail conductor runs.
- If the server requires strict schemas, it must accept versioned envelopes and unknown fields because conductor record shapes may evolve.

## Public contract

### Config files

Config lookup order:
1. `<cwd>/.pi-conductor-analytics.json`
2. `<cwd>/.pi/conductor-analytics.json`
3. `<home>/.pi-conductor-analytics.json`
4. `<home>/.config/pi-conductor/analytics.json`

First existing file wins. CWD config overrides HOME config.

MVP config shape:

```json
{
  "enabled": true,
  "endpoint": "https://analytics.example.com/pi-conductor/events",
  "headers": {
    "Authorization": "Bearer ${PI_CONDUCTOR_ANALYTICS_TOKEN}"
  },
  "batch": {
    "enabled": true,
    "maxRecords": 25,
    "flushIntervalMs": 1000
  },
  "request": {
    "timeoutMs": 5000,
    "maxRetries": 2
  }
}
```

Required:
- `endpoint` when `enabled !== false`.

Optional:
- `headers`: string values, with `${ENV_NAME}` interpolation.
- `batch.enabled`: default `true`.
- `batch.maxRecords`: default `25`.
- `batch.flushIntervalMs`: default `1000`.
- `request.timeoutMs`: default `5000`.
- `request.maxRetries`: default `2`.

### POST payload

The plugin should send a stable envelope while preserving each conductor record unchanged:

```ts
interface AnalyticsEnvelope {
  plugin: "pi-conductor-analytics-plugin";
  plugin_version: string;
  schema_version: 1;
  sent_at: string;
  cwd: string;
  source: "pi.events:conductor:record";
  records: unknown[];
}
```

For single-record mode, `records` contains one item. For batch mode, it contains multiple items. Each item is the exact `PersistedRecord` object received from pi-conductor.

### Hook/API details

Primary hook:

```ts
pi.events.on("conductor:record", (data: unknown) => {
  // validate minimally, enqueue, return immediately
});
```

Rationale:
- This is the extension-to-extension API exposed by pi-conductor's installed extension.
- It avoids importing pi-conductor internals or relying on module identity across separate packages.

Fallback direct import of `subscribeToRecords` is **not MVP** unless plugin loading tests prove event ordering or installation behavior needs it.

## Non-blocking delivery requirements

- Event handler must do only minimal validation and enqueue work synchronously.
- Network POSTs run in background via an internal queue; handlers never `await` network I/O.
- Queue must be bounded to prevent unbounded memory growth.
- Failures are logged/debuggable but never thrown back into pi or conductor.
- Timeout and retry are bounded.
- On `session_shutdown`, best-effort flush may run, but must use a short timeout and still avoid blocking indefinitely.

## Error handling

- Missing config or `enabled: false`: no-op extension, optionally log one debug message.
- Invalid config: no-op and surface a warning via `ctx.ui.notify` only when a context is available; otherwise console warn.
- Network failure: retry up to `maxRetries`, then drop or optionally retain in a small dead-letter buffer for diagnostics.
- HTTP non-2xx: treat as failure; retry if retryable (`408`, `429`, `5xx`), otherwise drop and warn.
- Invalid record payload: ignore and warn; do not crash.

## Project structure

```text
package.json                 Package metadata, pi extension registration, scripts
src/extension.ts             Default pi extension factory
src/config.ts                Config discovery, validation, env interpolation
src/envelope.ts              Envelope creation
src/queue.ts                 Bounded async delivery queue and retry logic
src/types.ts                 Internal public types
extensions/analytics.ts      Extension entrypoint exported to pi, or built dist equivalent
tests/                       Vitest unit/integration tests
docs/conductor-analytics-plugin/ Plan/spec artifacts
```

## Commands

After scaffolding:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Expected package scripts:

```json
{
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "lint": "biome check .",
  "format": "biome format --write ."
}
```

## Testing strategy

- Unit tests for config lookup precedence, JSON validation, env interpolation, and redaction-safe errors.
- Unit tests for envelope creation preserving record objects unchanged.
- Queue tests using fake `fetch`, fake timers, retry/timeout cases, and bounded overflow behavior.
- Extension wiring test using a fake `ExtensionAPI` event bus; emit `conductor:record` and assert an enqueued POST.
- Fixture test using sample conductor JSONL records from this repo or copied fixtures.

## Boundaries

Always:
- Preserve incoming records unchanged inside `records[]`.
- Keep delivery best-effort and non-blocking.
- Bound queue size, retry count, and request timeout.
- Avoid logging header values/secrets.

Ask first:
- Reading and uploading nested `session_file` transcript contents.
- Adding persistent local retry storage.
- Changing pi-conductor itself.
- Supporting YAML/TOML config in addition to JSON.

Never:
- Throw from event handlers.
- Block conductor runs on network delivery.
- Upload environment variables wholesale.
- Include secrets in logs, errors, or test snapshots.

## Success criteria

- A pi-installable plugin package registers an extension with pi.
- With pi-conductor installed, emitting `conductor:record` results in a non-blocking POST to the configured endpoint.
- Payload preserves all fields of each received conductor record.
- CWD config overrides HOME config.
- Network errors do not affect pi-conductor execution.
- Unit tests cover config, envelope, queue, and extension wiring.

## Open questions

- Should future scope include reading/uploading pi role-session JSONL files referenced by `session_file`?
- Should the server expect one record per POST or batches? MVP supports batch by default.
- Is JSON-only config acceptable, or should YAML be supported for consistency with conductor manifests?
