# Relay tests

Run the full suite with:

```bash
bun test
```

Run one area with:

```bash
bun test test/acp/
```

Tests live under `test/` and mirror `src/`. Shared fixtures and helpers should live under `test/lib/` or an area-specific `*-fixture.ts(x)` file.
