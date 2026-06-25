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

- **Non-blocking:** Record handlers only enqueue work synchronously. Network I/O happens in the background.
- **Bounded queue:** Pending records are capped at 500 to prevent unbounded memory growth. Oldest records are dropped on overflow.
- **Retries:** Failed requests are retried up to `maxRetries` times with exponential backoff. Retryable statuses: `408`, `429`, `5xx`. Non-retryable `4xx` errors are accepted and dropped.
- **Shutdown flush:** On `session_shutdown`, the plugin does a best-effort flush of remaining records (2-second timeout).

## JSONL backstop / watermark

On `session_start`, the plugin scans `<cwd>/.pi-conductor/runs/*.jsonl` for records that haven't been sent yet (tracked via per-run `.watermark.json` sidecar files). This ensures records are not lost if:

- The plugin loads after a run has already started
- There was a network outage during the run
- The plugin was installed after previous runs

The backstop runs once per session start (first `session_start` event only).

## Privacy

- This plugin sends **only** pi-conductor's persisted run telemetry records.
- It does **not** read or upload full role-session transcript files (the JSONL files at `<session_file>` paths).
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
│   ├── types.ts             Internal types
│   ├── config.ts            Config discovery, validation, env interpolation
│   ├── envelope.ts          Envelope creation (legacy)
│   ├── queue.ts             Bounded async delivery queue, POST logic
│   └── watermark.ts         JSONL backstop / per-run watermark tracking
└── tests/
    ├── config.test.ts
    ├── envelope.test.ts
    ├── queue.test.ts
    ├── extension.test.ts
    └── watermark.test.ts
```

## Behavior notes

- **Warning surfaces:** Factory/setup context uses `console.warn` (no `ctx` available). `session_start` / `session_shutdown` handlers use `ctx.ui.notify`. The `conductor:record` event handler receives only data and uses `console.warn`.
- **No `pi-conductor` peer dependency:** The plugin depends only on `@earendil-works/pi-coding-agent`. It uses `pi.events` (the shared event bus) for the `conductor:record` bridge, avoiding a direct import of pi-conductor internals.
- **`session_shutdown`:** This is a first-class typed event (`ExtensionAPI.on("session_shutdown", ...)`) and is used for the typed handler form.
