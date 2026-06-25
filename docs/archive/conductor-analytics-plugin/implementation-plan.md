# Implementation Plan: pi-conductor Analytics Plugin

## Summary
Build a separate pi extension that listens for pi-conductor's `conductor:record` event, batches received run telemetry records, and posts them to a configured HTTP endpoint. The plugin is best-effort and non-blocking.

## Architecture decisions

- Use `pi.events.on("conductor:record")` as the primary hook. This is already emitted by the installed pi-conductor extension and avoids direct dependency on pi-conductor internals.
- Preserve conductor telemetry by wrapping raw records in a versioned envelope rather than transforming them.
- Use JSON config only for MVP; CWD config overrides HOME config.
- Use an in-memory bounded queue with batched POSTs, timeout, and bounded retries.
- Treat delivery as best-effort: no thrown errors from event handlers and no blocking of conductor runtime.

## Phases

1. [Foundation](./phase-1-foundation.md) — package scaffold and extension event listener.
2. [Config and payload](./phase-2-config-and-payload.md) — config discovery/validation and envelope contract.
3. [Non-blocking delivery](./phase-3-nonblocking-delivery.md) — queue, POST worker, retries, shutdown flush.
4. [Integration verification](./phase-4-integration-verification.md) — fixtures, docs, optional live smoke.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| pi-conductor extension is not installed or not loaded | No telemetry received | Document dependency; optionally add startup warning if no records seen after a run is expected |
| Event payload shape evolves | Server parse failures | Version envelope and preserve unknown record fields |
| Network endpoint is slow/down | Runtime degradation | Handler only enqueues; queue has timeout/retry bounds |
| Queue grows during outages | Memory pressure | Bound pending records and count/drop overflow |
| Secrets leak in logs | Security issue | Never log header values or interpolated env values |
| User expects nested role session transcripts | Missing data | MVP states it uploads conductor run telemetry only; ask before reading `session_file` contents |

## Verification commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Feasibility conclusion

The goal is feasible. pi-conductor already exposes the required hook via `pi.events` and its persisted record objects match the on-disk JSONL records under `.pi-conductor/runs`. Implementation is primarily a small extension package plus robust config and delivery plumbing.
