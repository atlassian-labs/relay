# Relay

ACP-first terminal UI. The agent owns execution; Relay owns the experience: rendering ACP output, prompt history, config, themes, and subprocess lifecycle. Relay does **not** implement a local agent runtime or tool layer.

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/get-started/introduction) is the open protocol that standardizes communication between coding agents and clients such as editors and terminal UIs, allowing Relay to work with any compatible local or remote agent.

## Conversational Style

Keep answers short and concise. No emojis in commits, issues, PR comments, or code.

## Code Quality

- Read files in full before making wide-ranging changes, before editing files you have not already fully inspected, and when the user asks you to investigate or audit something. Do not rely only on search snippets for broad changes.
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional

## Commands

Requires Bun. Use Bun as the package manager/runtime, not npm/pnpm/yarn.

```bash
bun install                  # install dependencies
bun run dev --agent codex    # run from source through scripts/pinned-bun.sh
bun run web                  # run the web UI entrypoint
bun run build                # bundle to dist/
bun run typecheck            # tsgo / TypeScript 7 native-preview check
bun run lint                 # Oxlint
bun run lint:effect-shape    # Effect shape constraints
bun run lint:boundaries      # Architecture dependency constraints
bun run format               # oxfmt write
bun run format:check         # oxfmt check
bun test                     # unit test suite
bun run test:e2e             # smoke/e2e suite
bun run check                # pinned Bun check: version + typecheck + lint + effect-shape + format check + unit tests + build
```

- Use `bun run format` when files need oxfmt formatting.
- For successful noisy commands, avoid sending full output back to the model. Prefer `cmd >/tmp/relay-<name>.log && echo "<name> ok"`; on failure, rerun or print only the relevant failure section.
- Run `bun run format` as `bun run format >/tmp/relay-format.log && git diff --name-only` unless the user explicitly asks for full formatter output.
- Run focused tests/checks while iterating. Save full `bun run check` for final verification unless the task specifically requires it earlier; when it passes, summarize as `check ok` instead of pasting the full transcript.
- Do not chain validation commands with commit/push commands when only the final status matters. Capture hook/commit/push logs to a temp file with both stdout and stderr redirected (`cmd >/tmp/relay-<name>.log 2>&1`). If the command fails, print only the relevant failure tail, e.g. `tail -120 /tmp/relay-<name>.log`.
- Whenever significant work has been completed and forms a logical unit, commit it. Split unrelated changes into separate logical commits.
- When the user asks to raise, open, or create a PR, push the branch and share the Bitbucket PR creation link; do not call Bitbucket APIs or CLIs to create the PR unless explicitly requested.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- Before committing, review all changes and include only the files that belong to that logical unit.
- Follow commit message conventions: docs:, feat:, fix:, build:, etc. for the commit prefix.
- Name branches with the matching change-type prefix and a short kebab-case description, for example `docs/theme-guide`, `feat/custom-themes`, `fix/editor-contrast`, or `build/pinned-bun`; use the prefix that best describes the branch's primary purpose.

## Architecture

- `src/index.ts` and `src/cli.ts`: process entrypoint, argument parsing, configuration/bootstrap, and dispatch to TUI, web, exec, and agent-management modes.
- `src/core/`: provider- and runtime-agnostic conversation, activity, command, thread, handoff, user-message, and diff domain types/helpers.
- `src/acp/`: the ACP boundary—SDK types, JSON-RPC transports, protocol client, capabilities, process lifecycle, session configuration, and agent compatibility profiles.
- `src/application/`: ACP-to-domain mapping and session/launch use cases shared by TUI, web, and exec modes.
- `src/platform/`: thin filesystem, process, git, time, environment, and crypto adapters for runtime boundaries.
- `src/ui/`: SolidJS/OpenTUI terminal UI, routes, controllers, contexts, state, autocomplete, paste handling, layout, and reusable components.
- `src/ui/tool-renderers/`: generic and agent-specific tool rendering profiles. Keep agent-specific presentation behavior here when possible.
- `src/web/`: web server, static assets, WebSocket session bridge, and browser client entrypoint.
- `src/plugins/`: plugin API, loader/runner, lifecycle, commands, keybindings, UI and renderer slots, MCP wiring, and bundled plugins.
- `packages/relay-plugin-sdk/` and `src/plugin.ts`: public TypeScript plugin SDK and package export entrypoint.
- `src/builtin-skills/`: bundled Relay skill definitions, prompts, metadata, and reference material.
- `src/config/`: TOML config loading, schema validation, built-in agent definitions, theme registry, and config migration/default helpers.
- `src/effect/`: shared Effect runtime and error helpers.
- `src/logging/`, `src/telemetry*.ts`, `src/sounds/`, `src/notify.ts`, `src/skills.ts`, `src/prompt-history.ts`, and `src/user-bash.ts`: focused runtime services and utilities used by the user-facing modes.
- Dependency direction for `core`, `acp`, `platform`, and `application` is enforced by `scripts/check-boundaries.ts`; run `bun run lint:boundaries` after changing imports across these layers.
- `cmd/relay/main.go`: Atlas CLI plugin shim that execs the bundled Bun runtime and JS bundle.
- `scripts/`: pinned Bun wrapper, build/check tooling, performance tooling, smoke runners, and Atlas plugin packaging scripts.
- `test/`: Bun unit and integration tests mirroring `src/`; shared fixtures/helpers belong in `test/lib/`.
- `playwright-tests/`: Playwright coverage for browser/web flows.
- Extension documentation lives in `docs/extensions.md`; it covers local plugin locations including `~/.config/relay/plugins/<plugin-name>/`.

## Conventions

- Prefer Bun APIs and existing project helpers over introducing Node/package-manager alternatives.
- Keep Relay ACP-driven and agent-agnostic by default; do not add local tool execution paths outside existing user-bash behavior.
- When changing UI behavior, add or update focused tests. Use OpenTUI `testRender` frame-capture tests for rendered terminal flows.
- Solid components run once; use signals/stores for reactivity rather than assuming React-style rerenders.
- Config, prompt history, logs, user sound overrides, and user-installed plugins live under `~/.config/relay/` at runtime (respects `$XDG_CONFIG_HOME` if set). User-installed plugins must be placed under `~/.config/relay/plugins/<plugin-name>/`; do not create or recommend workspace-local plugin paths. Built-in plugins are the exception because they ship with Relay and are not installed in the user plugin directory. Legacy `~/.relay/` is auto-migrated on first run.
- When a user refers to a plugin without specifying a path, assume they likely mean a user-installed plugin under `~/.config/relay/plugins/<plugin-name>/`, not a bundled plugin in the workspace, unless context indicates otherwise.

## User Override

If the user's instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
