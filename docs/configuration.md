# Relay Configuration

Relay reads `~/.config/relay/config.toml` (`$XDG_CONFIG_HOME/relay/config.toml` when set). If it does not exist, Relay creates it with the current defaults. Legacy `~/.relay/` is migrated automatically on first run.

## Invoking Relay

Commands in this document are shown as `relay`. Where Relay is installed as an
Atlas CLI plugin, run `atlas relay` instead and pass the same arguments.

## Agents

Relay launches the default agent from `[agents]`, a named built-in agent, or a named runner from `--agent <name>`.

Built-in agents need no runner config. Relay launches Rovo Dev with `rovo acp`, Codex/Claude ACP adapters with `npx`, and Cursor Agent with `agent acp`:

```sh
relay --agent rovo
relay --agent codex
relay --agent claude
relay --agent cursor
# aliases: rovodev, rovo-dev, claude-code, claude-acp, codex-acp, cursor-agent, cursor-acp
```

Set one as the default with:

```toml
[agents]
default = "codex"
```

A freshly generated config defines `code-agent` and `alta` runners that call the
Atlas CLI. They only work where that CLI is installed, so set `default` to a
built-in agent such as `codex` if you do not have it:

```toml
[agents]
default = "code-agent"

[agents.runners.code-agent]
command = "atlas"
args = ["alta", "agent", "run", "code-agent"]
profile = "alta"
```

The `alta` runner is retained as a compatibility alias. Versioned stock configs migrate to `code-agent`; custom commands or agent sources remain unchanged. Fresh Code Agent runners have no `preferred_model`, so the agent keeps its own default. Existing model and thinking preferences are preserved as user overrides.

Add a custom runner without editing TOML:

```sh
relay add <name> "<command>" --profile <profile>
```

Examples:

```sh
relay add my-agent "my-agent acp" --profile default
relay add custom-agent "custom-agent acp" --profile default
```

Available profiles are `default`, `alta`, `codex`, `claude`, and `rovodev`. A profile selects both tool rendering and any provider-specific ACP behavior. Unknown profiles fall back to default behavior/rendering.

Run a configured agent:

```sh
relay --agent my-agent
```

Equivalent config:

```toml
[agents]
default = "my-agent"

[agents.runners.my-agent]
command = "my-agent"
args = ["acp"]
profile = "default"
preferred_model = "my-model"
# env = { EXAMPLE = "value" }
```

With `default` set, `relay` launches that agent.

Use an inline ACP command for one-off runs:

```sh
relay acp "my-agent acp"
```

Force generic tool rendering for troubleshooting:

```sh
relay --agent rovodev --default-renderer
```

## WebSocket agents

A runner can connect to an ACP server over WebSocket instead of spawning a process.

```toml
[agents.runners.remote]
transport = "websocket"
url = "wss://agent.example.com/acp"
profile = "default"
# framing = "json" # "json" or "ndjson"
# protocols = ["acp"]

[agents.runners.remote.headers]
Authorization = "Bearer <token>"
```

## UI

Current UI keys:

```toml
[ui]
theme = "nightowl"
thread_worktree_location = "relay"       # "relay" or "repo"
terminal_title_prompt_source = "smart"   # "smart", "first", or "last"
prompt_marker = ">"                      # normal prompt marker; set to "❯" to match many zsh prompts
selection_marker = "→"                   # active-row marker in selection panels; set to "" to hide
mermaid_rendering = "streaming"           # "off", "final", or "streaming"
tool_result_preview_lines = 5             # 0 (Off) hides results (header only); 1, 5, 10, 15 set the preview length
thinking_preview_lines = 1
show_thinking = true                     # persist whether thinking blocks are visible
succinct_tool_results = true
slash_panel_position = "bottom"          # "bottom" or "top"
disabled_builtin_slash_commands = []      # e.g. ["review"] disables Relay's built-in /review
vim_keybindings = false
show_tips = true                         # welcome-screen and editor-header tips
sticky_prompt_header_lines = 3            # 0 disables; max 10
```

Consecutive tool-call grouping is disabled by default and currently configured directly in TOML. Rules match exact ACP tool names. A run must contain at least two configured tools; expanding its summary renders the original tool rows without indentation, including their normal icons and detail actions.

```toml
[ui.tool_call_groups]
enabled = true

[[ui.tool_call_groups.rules]]
tool_names = ["read"]
singular = "Read {count} file"
plural = "Read {count} files"

[[ui.tool_call_groups.rules]]
tool_names = ["find"]
singular = "Found {count} path"
plural = "Found {count} paths"

[[ui.tool_call_groups.rules]]
tool_names = ["grep"]
singular = "Searched {count} pattern"
plural = "Searched {count} patterns"
```

`disabled_builtin_slash_commands` accepts Relay-owned command names with or without a leading slash or `relay.` prefix, such as `["review", "goal"]`. Disabled commands are removed from Relay autocomplete and no longer intercept plugin or ACP agent commands with the same name.

`mermaid_rendering` controls terminal-friendly Unicode rendering for top-level fenced `mermaid` blocks. `streaming` updates diagrams as assistant content arrives, `final` waits for the completed message, and `off` keeps the original code block. Unsupported, invalid, or over-wide diagrams remain source code.

Most UI options are editable from `/settings`. `/settings` offers common `prompt_marker` choices; edit `config.toml` for any other plain-text marker. Relay trims surrounding whitespace and falls back to `>` if the marker is blank, more than 4 characters long, uses the reserved `!` / `!!` bash markers, or contains terminal control characters.

Themes: `amp-dark`, `amp-light`, `ayu`, `catppuccin-frappe`, `catppuccin-latte`, `catppuccin-macchiato`, `catppuccin-mocha`, `dracula`, `everforest`, `flexoki`, `github-dark`, `github-light`, `gruvbox-dark`, `gruvbox-light`, `kanagawa`, `kanagawa-dragon`, `monokai`, `nightowl`, `nord`, `one-dark`, `one-light`, `osaka-jade`, `palenight`, `rosepine`, `solarized-dark`, `solarized-light`, `synthwave84`, `tokyo-day`, `tokyo-night`, `vesper`. Custom JSON themes can be installed under `~/.config/relay/themes/`; see [Relay Themes](themes.md).

## Prompt overrides

Child-session task types, keyword matching, and collaboration workflows are documented in [Child Sessions and Live Collaboration](child-sessions.md).

Relay uses its bundled prompt unless a matching file exists under `~/.config/relay/prompts/`:

```text
child-session-collaboration.md
handoff.md
review.md
relay-plugins.md
relay-themes.md
```

Relay does not copy bundled defaults into this directory, so bundled prompt updates continue to apply until a user creates an override. Prompt files are read at startup and during config reload; restart Relay after editing one.

Template placeholders:

- `child-session-collaboration.md`: `{{session_json}}`, `{{matched_task_types_json}}`
- `handoff.md`: `{{goal}}`
- `review.md`: `{{input}}`, `{{arguments}}`, `{{context}}`

The Relay plugin and theme prompts have no placeholders; command arguments are appended to the selected prompt. An empty child-session collaboration override disables that reminder.

## Notifications

```toml
[notifications]
terminal_enabled = true
sound_enabled = true
volume = 0.1 # 0.0 to 1.0
```

Set `RELAY_DISABLE_NOTIFICATIONS=1` to disable notification dispatch for a run. Terminal notification protocol selection is handled by OpenTUI; use `OPENTUI_NOTIFICATION_PROTOCOL` or `OPENTUI_NOTIFICATIONS` for OpenTUI overrides.

Custom sound overrides live in `~/.config/relay/sounds/`:

```text
completion.wav
elicitation.wav
error.wav
```

## Extensions

```toml
[plugins]
enabled = true
allow_project_plugins = false
paths = []
trusted_workspaces = []
disabled = []
```

User-installed extensions live under `~/.config/relay/plugins/<plugin-name>/`. Built-in extensions are shipped with Relay and can be toggled from `/plugins` or by editing `plugins.disabled`. See [Relay Extensions](extensions.md).

Plugin settings are stored under `[plugin_settings.<source>_<plugin-name>]`.

## Logging

```toml
[logging]
level = "info" # "error", "warn", "info", "debug", or "trace"
```

Run logs are written to `~/.config/relay/logs/`. Override the level for one run with:

```sh
RELAY_LOG=debug relay --agent codex
```
