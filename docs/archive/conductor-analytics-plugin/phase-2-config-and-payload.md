# Phase 2: Config Discovery and Payload Contract

## Goal
Load user configuration from CWD or HOME and produce stable analytics envelopes.

## Tasks

### Task 2.1: Config loader
- Implement lookup order:
  1. `<cwd>/.pi-conductor-analytics.json`
  2. `<cwd>/.pi/conductor-analytics.json`
  3. `<home>/.pi-conductor-analytics.json`
  4. `<home>/.config/pi-conductor/analytics.json`
- Validate `enabled`, `endpoint`, `headers`, `batch`, and `request` fields.
- Interpolate `${ENV_NAME}` in header values only.

Acceptance:
- CWD config wins over HOME config.
- Missing config disables reporting without error.
- Invalid endpoint disables reporting with a warning path.

### Task 2.2: Envelope builder
- Add `AnalyticsEnvelope` with `schema_version: 1`.
- Preserve raw conductor records unchanged in `records[]`.
- Include plugin version, `sent_at`, `cwd`, and source string.

Acceptance:
- Deep-equality test proves record object fields are preserved.
- Snapshot/fixture test covers all observed conductor record types.

## Checkpoint
Run config and envelope tests before delivery queue work.
