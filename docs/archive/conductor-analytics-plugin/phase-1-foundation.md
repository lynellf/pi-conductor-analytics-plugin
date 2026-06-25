# Phase 1: Package and Extension Foundation

## Goal
Create a minimal pi-installable TypeScript package and extension entrypoint.

## Tasks

### Task 1.1: Scaffold package
- Add `package.json`, `tsconfig.json`, test config, and source/test directories.
- Configure `pi.extensions` to point at the built extension entrypoint.
- Add scripts: `build`, `typecheck`, `test`, `lint`, `format`.

Acceptance:
- `pnpm build` compiles an empty extension.
- `pi install ./` can discover the extension path once built.

### Task 1.2: Add extension factory
- Implement default export accepting `ExtensionAPI`.
- Register a listener on `pi.events.on("conductor:record", handler)`.
- Handler initially validates minimally and calls an injected no-op reporter.

Acceptance:
- Fake event bus test proves the handler receives conductor records.
- Handler does not throw on malformed data.

## Checkpoint
Run `pnpm typecheck && pnpm test`.
