# Relay Extensions

Relay extensions are local JavaScript or TypeScript modules that customize the UI and prompt workflow. The config and runtime API call them **plugins**. They run inside the Relay process with local code execution privileges, so install only extensions you trust.

Extensions complement the ACP agent. They are suited to presentation, input workflows, local policy, shortcuts, MCP configuration, and lightweight integrations; they should not implement a second agent runtime or local agent tool layer.

Common uses include:

- slash commands, keybindings, and autocomplete
- widgets, overlays, editor chrome, and custom renderers
- prompt interception, permission policy, and elicitation handling
- thread and agent workflows
- MCP configuration and local service integrations
- typed settings and persisted plugin state

## Quick Start

Create `~/.config/relay/plugins/hello-relay/package.json`:

```json
{
  "name": "relay-plugin-hello",
  "version": "0.0.0",
  "private": true,
  "description": "minimal Relay extension",
  "author": "local",
  "type": "module",
  "exports": "./index.ts",
  "dependencies": {
    "@atlassian/relay-plugin-sdk": "0.6.0"
  },
  "relay": {
    "plugin": "index.ts"
  }
}
```

Create `~/.config/relay/plugins/hello-relay/index.ts`:

```ts
import { defineRelayPlugin } from "@atlassian/relay-plugin-sdk";

export default defineRelayPlugin((relay) => {
  relay.ui.toast("Hello from Relay", "info");
});
```

Enable extensions in `~/.config/relay/config.toml`:

```toml
[plugins]
enabled = true
```

Restart Relay or run `/reload`. Reload recompiles each external extension's complete local import graph, so edits to files imported by the entrypoint are included. Relay validates imports and plugin setup before replacing the active runtime; a failed reload keeps the previous plugins running. Reload waits for an active agent response to finish. Use `/plugins` to inspect discovered extensions, diagnostics, commands, and MCP state, and to enable or disable individual entries.

## SDK

Add `@atlassian/relay-plugin-sdk` to the extension and import public helpers and types from it:

```ts
import { defineRelayCommand, defineRelayPlugin, relayCard, type RelayPluginApi } from "@atlassian/relay-plugin-sdk";
```

Do not import Relay `src/...` internals. Existing imports from `relay/plugin` remain supported, but the SDK package is the stable authoring entry point.

Useful helpers include `defineRelayPlugin`, `defineRelayCommand`, `defineRelayKeybinding`, `defineRelayAutocompleteProvider`, `defineRelayWidget`, `defineRelayEditorStatusSegment`, `defineRelayEditorFooterSegment`, `defineRelayEditorHeaderRenderer`, `defineRelayEditorFooterRenderer`, `defineRelayEditorChromeElementRenderer`, `defineRelayToolRenderer`, `defineRelayMessageRenderer`, `relayLine`, `relayLines`, `relayCard`, `createRelayDisposable`, and `combineRelayDisposables`.

## Discovery and Configuration

User-installed extensions live under:

```text
~/.config/relay/plugins/<plugin-name>/
```

When `XDG_CONFIG_HOME` is set, the root is `$XDG_CONFIG_HOME/relay/plugins/`. Relay discovers bundled extensions, user-installed extensions, configured paths, and explicitly trusted project sources, in that order.

An entry may be a `.ts`, `.tsx`, `.js`, or `.mjs` file; a directory with `index.ts`, `index.tsx`, `index.js`, or `index.mjs`; or a package whose `relay` field declares `plugin` or `plugins`:

```json
{
  "type": "module",
  "relay": {
    "plugins": ["theme.mjs", "commands.mjs"]
  }
}
```

Configuration:

```toml
[plugins]
enabled = true
allow_project_plugins = false
paths = []
trusted_workspaces = []
disabled = []
```

Relative `paths` resolve from the workspace cwd. Project extension loading is off by default. Relay exposes `RELAY_CONFIG_DIR` and `RELAY_CACHE_DIR` to extensions; prefer `RELAY_CACHE_DIR` for durable cache data.

### Source and package layouts

A single `.ts` file is sufficient for a small configured plugin. Use a package directory for plugins with multiple modules, runtime assets, dependencies, tests, or distribution metadata. Keep `index.ts` as the canonical entrypoint and place helper modules and assets beside it or under package-local directories.

Declare libraries needed while the plugin runs in `dependencies`; reserve `devDependencies` for formatting, testing, and type-checking tools. Install third-party dependencies beside the plugin so normal package resolution can find them. Relay runs TypeScript through Bun, so local and bundled plugins do not need generated JavaScript entrypoints or a separate runtime compiler.

JavaScript entrypoints remain supported for existing and external plugins.

## Extension Shape

The module default-exports a function that receives `RelayPluginApi` and may return a promise:

```ts
import type { RelayPluginApi } from "@atlassian/relay-plugin-sdk";

export default function example(relay: RelayPluginApi) {
  const tip = relay.ui.addTip("Example loaded");
  relay.on("relay:shutdown", () => tip.dispose());
}
```

`relay.plugin` contains the extension ID, name, path, description, and author. `relay.cwd` is Relay's current workspace. Registration APIs return disposable handles, and Relay disposes registered resources on reload or shutdown.

The root API contains:

- `relay.ui`: toasts, dialogs, tips, chat blocks, widgets, overlays, editor status/footer segments, and renderers
- `relay.editor`: composer configuration, text operations, themes, submission, and autocomplete
- `relay.input` and `relay.userBash`: prompt interception, hidden reminders, and `!` / `!!` policy
- `relay.permissions` and `relay.elicitation`: local ACP request policy
- `relay.commands` and `relay.keybindings`: local commands and shortcuts
- `relay.tools`: tool renderers and display policies
- `relay.agent` and `relay.thread`: active ACP agent and Relay thread operations
- `relay.acp` and `relay.mcp`: ACP updates and MCP server lifecycle
- `relay.storage` and `relay.settings`: runtime/persisted state and user-editable config

## Commands and Input

Register a slash command:

```ts
relay.commands.register("hello", {
  description: "Say hello",
  argumentPlaceholder: "[name]",
  run(args, ctx) {
    ctx.toast(`Hello ${args || "world"}`);
  },
});
```

Command names are normalized by removing leading slashes and lowercasing. Plugin commands run before ACP-advertised commands with the same name; conflicts are visible in `/plugins`.

`relay.input.onBeforeSubmit(handler)` can preserve, rewrite, or handle visible prompt text. `relay.input.addSystemReminder(provider)` appends hidden `system-reminder:` ACP text blocks after the visible text is finalized. These reminders are prompt content, not true system messages.

`relay.userBash.onBeforeRun(handler)` can rewrite local shell commands, cwd, or environment. `relay.userBash.onRun(handler)` can replace execution; returning `null` or `undefined` lets Relay use the next handler or its normal shell runner.

## UI, Widgets, and Rendering

Common UI methods:

```ts
relay.ui.getTheme();
relay.ui.toast(message, variant?, durationMs?);
relay.ui.openDiff(options);
relay.ui.confirm(title, message, options?);
relay.ui.select(title, options, options?);
relay.ui.input(title, placeholder?, options?);
relay.ui.editor(title, prefill?, options?);
relay.ui.addTip(text, options?);
relay.ui.addChatBlock(block);
relay.ui.setEditorStatus(key, value);
relay.ui.showOverlay(key, widget);
relay.ui.setWidget(key, widget);
relay.ui.setEditorStatusSegment(key, segment);
relay.ui.setEditorFooterSegment(key, segment);
relay.ui.registerEditorHeaderRenderer(renderer);
relay.ui.registerEditorFooterRenderer(renderer);
relay.ui.registerEditorChromeElementRenderer(renderer);
```

Toast variants are `info`, `warning`, and `error`. Widget placements are `appHeader`, `editorHeader`, `aboveEditor`, `belowEditor`, `sidebar`, `modal`, `overlay`, `welcome`, and `welcomeAddon`. `appHeader` renders above the chat log; `editorHeader` renders pinned blocks above the queue and status line.

Widgets return text-oriented colored lines and may handle keys, clicks, links, focus, visibility, and invalidation. Whole lines and individual segments support `bold`, `underline`, and `strikethrough` terminal attributes. `showOverlay(key, widget)` is a convenience for a focused `overlay` widget. `setWidget(key, widget)` supports every placement, replaces an existing widget registered under the same key, and removes it when `widget` is `undefined`.

### Editor header and footer rendering

`registerEditorHeaderRenderer` and `registerEditorFooterRenderer` can replace the complete editor header or footer with Relay lines. Renderers receive the terminal dimensions, theme colors, editor text, surface name, a live `state` snapshot, and an `invalidate()` callback. The snapshot includes workspace, provider/mode/model/reasoning, turn status, queued prompts, token usage, and file changes. Return `null` to let the next renderer or Relay's built-in surface run; return an empty array to hide the surface. The first registered renderer that does not return `null` wins. A complete header replacement also replaces `editorHeader` widgets, the queue, and the status line.

```ts
relay.ui.registerEditorFooterRenderer({
  render(ctx) {
    const { modelId, reasoningLevel } = ctx.state;
    return [{ text: `${modelId} · ${reasoningLevel}`, fg: ctx.colors.accent }];
  },
});
```

Use `registerEditorChromeElementRenderer` for targeted changes without rebuilding the built-in layout. Matching element renderers run in registration order and each receives the current `RelayLine`, so changes compose. Return `null` to preserve the current line or return `{ text: "" }` to hide that element.

```ts
relay.ui.registerEditorChromeElementRenderer({
  elements: ["editorFooter.model", "editorFooter.reasoning"],
  render(ctx) {
    return { ...ctx.line, fg: ctx.colors.accent };
  },
});
```

Header elements cover queue title, hint, indicator, item label and preview; status spinner, Vim mode, label, plugin status, interrupt hint, tip parts, and right-side status/hints. Footer elements cover cwd, branch, worktree, provider, mode, token usage, goal status, file summary/additions/removals, plugin status, model, and reasoning. The exported `RelayEditorChromeElement` union contains the exact stable IDs. Element renderers affect only Relay's built-in header/footer; complete replacement output is rendered as supplied.

A small, self-contained overlay can handle its own keys:

```ts
const handle = relay.ui.showOverlay("example", {
  title: "Example",
  onKey(event) {
    if (event.name === "escape") handle.dispose();
  },
  render(ctx) {
    return [{ text: `Overlay body: ${ctx.width}x${ctx.height}` }];
  },
});
```

For interaction-driven state, replace the widget after each state change so Relay receives a new widget entry and repaints it. Bundled plugins use this pattern with keybindings enabled only while the overlay is open:

```ts
const key = "stateful-example";
const items = ["one", "two", "three"];
let open = false;
let selected = 0;

function close() {
  open = false;
  relay.ui.setWidget(key, undefined);
}

function renderOverlay() {
  relay.ui.setWidget(key, {
    placement: "overlay",
    title: "Stateful example",
    onClose: close,
    render: () => [{ text: `Selected: ${items[selected]}` }],
  });
}

relay.keybindings.register("down", {
  description: "Select next item",
  enabled: () => open,
  run() {
    selected = (selected + 1) % items.length;
    renderOverlay();
  },
});
relay.keybindings.register("escape", {
  description: "Close the example overlay",
  enabled: () => open,
  run: close,
});

open = true;
renderOverlay();
```

A focused modal or overlay with `onKey` receives keys before plugin keybindings; return `false` to let Relay continue routing the key. A focused widget without `onKey` lets Relay match keybindings from the widget's owning plugin before other UI handlers. Prefer one control pattern per widget rather than mixing both. Keybinding names normalize `return` to `enter`, `esc` to `escape`, and `arrowleft`/`arrowright`/`arrowup`/`arrowdown` to `left`/`right`/`up`/`down`.

`RelayWidgetHandle.invalidate()` requests a UI invalidation without replacing the widget definition. Prefer same-key `setWidget` replacement for mutable interaction state. A test that calls `render()` directly after changing closure state proves renderer logic, but not that Relay repaints; assert the interaction replaces the widget and exercise stateful controls in Relay after `/reload`.

Theme colors exposed through render contexts use camelCase, including `markdownHeading`, `markdownCode`, `diffAdded`, `diffRemoved`, `toolBg`, `panelAlt`, and `panelUser`.

Use `relay.ui.registerMessageRenderer` to replace chat block rendering and `relay.tools.registerRenderer` to replace tool call/result rendering. Return `null` to fall back to the next extension or Relay's built-in renderer. Tool display policies can independently control headers, diffs, result bodies, preview lines, collapsing, and toggling.

`relay.editor.configure`, `setTheme`, `addAutocompleteProvider`, `getText`, `setText`, `insertText`, `attachImage`, and `submit` customize the composer. `attachImage(path)` inserts a local image using the same marker and sidecar flow as pasting an image file, and returns `false` for an invalid or unsupported image. Unknown or invalid values passed to `setTheme` are ignored. Autocomplete providers are cursor-aware and may be asynchronous; Relay discards stale results after the prompt or cursor changes.

## Agent, Threads, ACP, and MCP

`relay.agent` exposes the active agent name, profile, session ID, running/queue state, advertised optional capabilities, available modes/models/thinking levels, prompting and cancellation, restart, session creation/loading/forking/deletion/close, hidden prompts, active-turn input, and mode/model/thinking changes.

`relay.thread.current`, `list`, `conversation`, `conversationMarkdown`, `create`, `ensureSession`, `select`, and `archive` operate through Relay's normal thread controller. Conversation snapshots and Markdown exports contain Relay's in-memory visible blocks; they do not read the agent's persisted session storage.

`relay.acp.onSessionUpdate(handler)` receives normalized session updates. Raw ACP requests are currently unavailable.

Extensions can register MCP servers for the next agent launch:

```ts
relay.mcp.addServer({ name: "example", command: "example-mcp", args: ["serve"] }, { apply: "promptRestart" });
```

Apply modes are `nextSession`, `promptRestart`, and `restartNow`. `relay.mcp.status()` reports active and pending servers plus whether a restart is needed. MCP state and restart warnings appear in `/plugins`.

## Permission and Elicitation Policy

Hooks run in registration order; the first result other than `continue` responds to ACP. Errors become extension diagnostics and Relay falls back to its normal UI.

```ts
relay.permissions.onRequest((request) => {
  if (request.toolName === "bash" && request.preview?.includes("rm -rf")) {
    return { action: "deny", reason: "Dangerous command" };
  }
  return { action: "continue" };
});
```

Permission hooks may continue, deny, approve, or select an ACP option. Elicitation hooks may continue or respond with accept, decline, or cancel. Relay inserts a visible info or warning block whenever an extension answers a request automatically.

## Settings and Storage

Define settings during extension startup. They appear in `/settings` and are persisted in `config.toml`:

```ts
relay.settings.define("show_date", {
  title: "Show date",
  description: "Prepend the date to the clock.",
  type: "boolean",
  default: false,
});

const enabled = relay.settings.get("show_date");
relay.settings.set("show_date", !enabled);
```

Supported types are `boolean`, `choice`, `integer`, and `number`; numeric settings may specify `min` and `max`, while choices provide `choices: () => string[]`.

Use `relay.storage` for reload-scoped state. Use `relay.storage.persisted` for JSON-serializable state that survives reloads and restarts. User extension data is stored beneath `~/.config/relay/plugin-data/`; bundled extension data is stored beneath `~/.config/relay/bundled/`.

## Lifecycle and Events

Subscribe with `relay.on(type, handler)`. Important events include:

- Relay: `relay:start`, `relay:shutdown`, `ui:mount`, `ui:unmount`, `config:change`, `theme:change`
- Agent/session: `agent:process:start`, `agent:process:exit`, `agent:connect:start`, `agent:connect:ready`, `agent:connect:error`, `session:new`, `session:load`, `session:update`
- Prompt/turn: `prompt:beforeSubmit`, `prompt:submitted`, `prompt:complete`, `prompt:error`, `turn:start`, `turn:end`
- Streaming: `agent:activity`, `message:start`, `message:update`, `message:end`, `tool:start`, `tool:update`, `tool:end`
- Runtime: `permission:request`, `permission:resolved`, `elicitation:request`, `elicitation:resolved`, `thread:change`, `queue:change`, `thinking:change`, `model:change`, `mode:change`, `agent:lifecycle`, `plugin:error`

Normalized message and tool events are derived from live ACP updates and are not emitted while session history is replayed. Keep handlers fast and treat raw ACP/tool payloads as unknown data.

Plugin factories may initialize asynchronously, but long-lived processes, sockets, watchers, timers, and servers should start only when Relay or the relevant UI/workflow needs them. Close plugin-owned resources from an idempotent `relay:shutdown` handler; Relay emits `ui:unmount` and `relay:shutdown` before reload as well as normal shutdown. Dispose temporary widgets, listeners, and processes when their owning workflow closes rather than waiting for Relay to exit.

## Examples

Working examples live in [`examples/plugins/`](../examples/plugins/):

- `permission-safety-policy.ts`: local ACP permission policy
- `code-review-helper.ts`: diff, confirmation, and prompt workflow
- `mcp-manager.ts`: MCP lifecycle and restart management
- `fff-path-autocomplete.ts`: async `@` path autocomplete

Copy an example into `~/.config/relay/plugins/<plugin-name>/index.ts`, add a package manifest if needed, then run `/reload`.
