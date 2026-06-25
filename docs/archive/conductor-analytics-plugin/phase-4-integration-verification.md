# Phase 4: Integration Verification and Documentation

## Goal
Verify the plugin with pi-conductor and document installation/configuration.

## Tasks

### Task 4.1: Integration fixture
- Add fixtures copied from observed `.pi-conductor/runs/*.jsonl` records.
- Emit each fixture line through fake `pi.events` and assert POST envelopes.

Acceptance:
- All observed `PersistedRecord` variants are accepted and preserved.

### Task 4.2: Local smoke test docs
- Document how to run a local server, configure endpoint, install both extensions, and start `/conduct`.
- Include example config and expected POST shape.

Acceptance:
- README explains config precedence, privacy caveat, and non-blocking best-effort semantics.

### Task 4.3: Optional live smoke
- Start a local HTTP capture server.
- Install `pi-conductor` and this plugin in a local pi session.
- Run a tiny conductor workflow and confirm received payloads.

Acceptance:
- Captured payload contains `checkpoint_snapshot` and lifecycle/transition records.

## Checkpoint
Run full validation: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
