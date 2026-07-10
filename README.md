# pi-conductor-analytics-plugin

Pi extension that reports [pi-conductor](https://github.com/lynellf/pi-conductor) run telemetry to an external HTTP endpoint.

## Overview

This plugin hooks into pi-conductor's `pi.events.on("conductor:record", ...)` event to receive persisted run records (`session_started`, `session_ended`, `transition_accepted`, `transition_rejected`, `checkpoint_snapshot`, etc.) and forwards them to a configured HTTP(S) endpoint in a **non-blocking, best-effort** fashion.

## Installation

```bash
# From the plugin directory
pi install /path/to/pi-conductor-analytics-plugin

# Or via npm/pnpm
pnpm add pi-conductor-analytics-plugin
pi install ./node_modules/pi-conductor-analytics-plugin
```

> **Prerequisites:** pi-conductor must also be installed as a pi extension. The plugin listens for events emitted by pi-conductor's extension; if pi-conductor is not loaded, the plugin will be inactive.

## Programmatic API

For library integrations that want to report analytics without the full Pi extension lifecycle, use `createAnalyticsReporter()`:

```ts
import { createAnalyticsReporter } from "pi-conductor-analytics-plugin";
import { join } from "node:path";

const reporter = createAnalyticsReporter({
  cwd: process.cwd(),
  runsDir: join(process.cwd(), ".pi-conductor/runs"),
  configPath: "./analytics.json",        // optional explicit config
  source: "library:conductor:record",    // optional custom source label
});

// Enqueue records for delivery
reporter.enqueue({ type: "my_event", value: 42 });

// Flush pending records
await reporter.flush();

// Stop the reporter (flushes remaining records with 2-second timeout)
await reporter.shutdown();

// Get delivery statistics
const stats = reporter.stats();
// { enqueued: 1, delivered: 1, failed: 0, dropped: 0, pending: 0 }
```

All methods are safe to call when the reporter is disabled (missing config, no endpoint):

- `enqueue()` silently drops invalid records
- `backfill()`, `flush()`, and `shutdown()` resolve immediately
- `stats()` returns a snapshot with all counters at zero

### JSONL Backfill

The `backfill()` method scans the runs directory for JSONL files and enqueues records past each run's committed watermark:

```ts
// Scan for unprocessed records from disk
const count = await reporter.backfill();
// Returns the number of records enqueued
```

## Configuration

Config lookup order (first existing file wins):

1. `<cwd>/.pi-conductor-analytics.json`
2. `<cwd>/.pi/conductor-analytics.json`
3. `$HOME/.pi-conductor-analytics.json`
4. `$HOME/.config/pi-conductor/analytics.json`

### Example config

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

### Config fields

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `endpoint` | *required* | HTTP(S) URL to POST records to |
| `headers` | `{}` | Custom HTTP headers with `${ENV_VAR}` interpolation |
| `batch.enabled` | `true` | Enable batch delivery |
| `batch.maxRecords` | `25` | Max records per batch POST |
| `batch.flushIntervalMs` | `1000` | Flush interval (ms) for partial batches |
| `request.timeoutMs` | `5000` | Request timeout (ms) |
| `request.maxRetries` | `2` | Max retries per failed request |

## Delivery behavior

### Non-blocking delivery

Record handlers only enqueue work synchronously. Network I/O happens in the background via a bounded delivery queue. The queue flushes:

- When the batch size (`batch.maxRecords`) is reached
- On the configured interval (`batch.flushIntervalMs`)
- On `session_shutdown`

### Request deadline with abort semantics

Each HTTP request has an overall **deadline** (configured via `request.timeoutMs`, default 5,000 ms). The deadline:

- Starts when the first attempt begins
- Applies to all retries collectively
- Aborts the in-flight attempt when reached
- Stops retries after abort or deadline expiry

On shutdown, a 2-second deadline is used to ensure the process exits cleanly even if the network is unresponsive.

### Deterministic retry policy

Failed requests are retried with **deterministic capped exponential backoff**:

| Attempt | Backoff delay |
|---------|---------------|
| 1 | 100 ms |
| 2 | 200 ms |
| 3 | 400 ms |
| 4+ | 800 ms (capped at 2,000 ms) |

The maximum delay is capped at 2,000 ms. If the remaining deadline is less than the calculated backoff, the retry is skipped.

**Retryable statuses:** `408 Request Timeout`, `429 Too Many Requests`, `5xx Server Errors`

**Non-retryable:** All other HTTP responses (including `4xx` client errors) are accepted and dropped after one attempt.

### Queue overflow behavior

The delivery queue is bounded to 500 pending records to prevent unbounded memory growth.

- **Oldest-drop:** When the queue is full, the oldest pending record is dropped
- **Immediate first diagnostic:** The overflow callback is invoked synchronously on the first overflow event
- **Rate-limited subsequent diagnostics:** After the first overflow, callbacks are rate-limited to once per 5 seconds while aggregating suppressed drops
- **Recovery:** After pending records drain, the rate-limit window resets so a subsequent overflow is reported immediately

Use `queue.setOverflowCallback()` to subscribe to overflow events:

```ts
const reporter = createAnalyticsReporter(options, (dropped, pending, suppressed) => {
  console.log(`Overflow: ${dropped} dropped, ${pending} pending, ${suppressed} suppressed since last callback`);
});
```

### Statistics

Call `stats()` to get a snapshot of delivery metrics:

```ts
const { enqueued, delivered, failed, dropped, pending } = reporter.stats();
```

- `enqueued`: Total records added to the queue
- `delivered`: Records successfully POSTed and confirmed
- `failed`: Records that failed after exhausting retries
- `dropped`: Records dropped due to queue overflow
- `pending`: Records currently in the queue awaiting delivery

## JSONL backstop / watermark

On `session_start`, the plugin scans `<cwd>/.pi-conductor/runs/*.jsonl` for records that haven't been sent yet (tracked via per-run `.watermark.json` sidecar files). This ensures records are not lost if:

- The plugin loads after a run has already started
- There was a network outage during the run
- The plugin was installed after previous runs

### At-least-once semantics

The backstop provides **at-least-once delivery** for persisted records:

- Watermarks advance **only after successful contiguous delivery** (2xx response)
- Failed or timed-out batches leave the watermark unchanged
- Records replay after restart if delivery was not confirmed
- **Duplicates are possible** after a crash: if the plugin crashes between successful delivery and watermark update, the same records will be resent

### Atomic sidecar updates

Watermark updates use atomic file operations:

1. Write to a temporary file in the same directory
2. Flush and close the temporary file
3. Rename the temp file to the watermark file

This ensures that a crash during update leaves either the old or new watermark intact.

### Backfill behavior

- Only complete newline-terminated JSONL lines are processed
- Malformed lines are skipped without blocking valid records
- A trailing incomplete line (partial write) is **not** included and does not advance the watermark
- On the next backfill (after restart), the partial line is retried

## Privacy

- This plugin sends **only** pi-conductor's persisted run telemetry records.
- It does **not** read or upload full role-session transcript files (the JSONL files at `<session_file>` paths).
- No role or session secrets are logged.
- Custom HTTP headers with `${ENV_VAR}` interpolation are expanded at config load time. The expanded values are **never** logged.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Typecheck
pnpm typecheck

# Test
pnpm test

# Lint
pnpm lint
```

## Project structure

```
├── package.json             Package metadata, pi extension registration
├── extensions/analytics.ts  Extension entrypoint (loaded by pi)
├── src/
│   ├── index.ts             Public API exports
│   ├── types.ts             TypeScript types
│   ├── config.ts            Config discovery, validation, env interpolation
│   ├── envelope.ts          Envelope creation
│   ├── queue.ts             Bounded async delivery queue, POST logic
│   ├── reporter.ts          Programmatic reporter factory
│   └── watermark.ts        JSONL backstop / per-run watermark tracking
└── tests/
    ├── config.test.ts
    ├── envelope.test.ts
    ├── queue.test.ts
    ├── reporter.test.ts
    ├── extension.test.ts
    └── watermark.test.ts
```

## Behavior notes

- **Warning surfaces:** Factory/setup context uses `console.warn` (no `ctx` available). `session_start` / `session_shutdown` handlers use `ctx.ui.notify`. The `conductor:record` event handler receives only `data`, no ctx; use `console.warn`.
- **No `pi-conductor` peer dependency:** The plugin depends only on `@earendil-works/pi-coding-agent`. It uses `pi.events` (the shared event bus) for the `conductor:record` bridge, avoiding a direct import of pi-conductor internals.
- **`session_shutdown`:** This is a first-class typed event (`ExtensionAPI.on("session_shutdown", ...)`) and is used for the typed handler form.
