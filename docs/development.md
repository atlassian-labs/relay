# Relay Development

## Requirements

Relay uses Bun. Use the version pinned in `.bun-version` / `package.json` (`bun@1.3.14`). Package scripts re-exec through `scripts/pinned-bun.sh`.

```sh
bun install
```

If the pinned Bun runtime is missing or stale:

```sh
RELAY_BUN_AUTO_INSTALL=1 bash scripts/pinned-bun.sh --version
```

## Run locally

```sh
bun run dev --agent codex
bun run dev --agent rovodev
bun run dev acp "my-agent acp"
bun run web --agent codex
```

Build and run the bundled CLI:

```sh
bun run build
bun run dist/index.js --agent alta
```

Optional local global link:

```sh
bun run build
bun link
```

## Debugging in VS Code

The repo ships debug configs in `.vscode/`. Install the recommended **Bun for Visual Studio Code** (`oven.bun-vscode`) extension when prompted.

Relay is a full-screen TUI, so the Bun extension's launch request (which pipes stdio through the Debug Console) can't render it. Use the **Attach to Relay** config instead:

1. Set breakpoints (e.g. in `src/ui/app/session-controller.ts`).
2. Run and Debug → **Attach to Relay** (F5).

The config runs a preLaunchTask that starts Relay in a real integrated terminal under `--inspect-wait`, waits for the inspector to listen, then attaches — the TUI renders in the terminal while you step in VS Code. To debug a specific agent, add flags to the task command in `.vscode/tasks.json`.

## Checks and tests

```sh
bun run typecheck
bun run lint
bun run lint:effect-shape
bun run lint:boundaries
bun run format
bun run format:check
bun test
bun run build
bun run check
```

Focused suites:

```sh
bun run test:e2e
bun run playwright:install
bun run test:web
bun run test:web:ui
```

When changing a test file, run that test file or focused suite before final verification.

## Notification fixture

Enable notifications in `/settings` or config, then run:

```sh
bun run dev:notifications
```

Submit one of: `completion`, `permission`, `permission-long`, `question`, `question-url`, `stop`, `error`, or `all`.

## Local UI showcase

Use the disposable fake ACP agent to test interactive UI without sending anything to an LLM:

```sh
bun run dev:ui-showcase
```

To open the queue sandbox:

```sh
bun run dev:ui-showcase --queue
```

The faux agent streams for roughly 10–15 seconds for every user message, whether typed directly or submitted from the queue. Submit prompts while a turn is active to populate the local queue. Use Option/Alt+Up or Down to browse queued rows, Enter to edit the selected row, Shift+Option/Alt+Up or Down to reorder it, Tab to steer it into the running turn, Delete to remove it, or Escape to close queue browsing. While browsing or editing, automatic queue draining stays paused. Enter saves an edit, Shift+Enter inserts a newline, Escape cancels an edit back to browsing, and leaving browse mode resumes draining. Each queued prompt automatically starts another 10–15 second faux turn when it reaches the front. Press Escape from the composer to interrupt the current fake turn.

## Project map

- `src/index.ts` — CLI parsing, TUI launch, and `web` dispatch.
- `src/acp/` — ACP JSON-RPC client, transports, protocol capabilities, and prompt content.
- `src/application/` — ACP-to-conversation mapping and session/launch orchestration shared by TUI, web, and exec modes.
- `src/ui/` — Solid/OpenTUI terminal app, editor, state, autocomplete, layout, overlays, slash commands.
- `src/ui/tool-renderers/` — tool rendering for agent profiles `default`, `alta`, and `rovodev`.
- `src/plugins/` — plugin API, loader, lifecycle, commands, keybindings, renderers, MCP wiring, bundled plugins.
- `src/config/` — TOML config loading, schema validation, themes, migrations, live updates.
- `src/core/` — provider-agnostic conversation types, events, threads, diffs, and git/worktree helpers.
- `src/platform/` — filesystem, process, environment/path, time, and Git diff adapters.
- `src/web/` — local web dashboard server and browser client assets.
- `test/` — Bun unit/integration tests.
- `playwright-tests/` — browser/web Playwright tests.
- `scripts/` — pinned Bun wrapper, build/check tooling, smoke runners, packaging scripts.

## Logs while developing

Relay writes logs to `~/.config/relay/logs/`. Use:

```sh
RELAY_LOG=debug bun run dev --agent alta
```
