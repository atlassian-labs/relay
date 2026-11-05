# Relay Features

Relay is ACP-first: agents own execution, and Relay owns the terminal/web experience around ACP sessions.

## Agents and sessions

- Launch configured ACP agents over stdio, or connect to ACP WebSocket agents.
- Built-in agent profiles: `default`, `alta`, `codex`, `claude`, and `rovodev`.
- Native runners for Rovo Dev, Codex, Claude Code, and Cursor Agent.
- Create, resume, list, load, and delete agent sessions when the agent supports them.
- Maintain per-workspace Relay threads, including optional git worktree threads.
- Switch session model, mode, and thinking level from advertised ACP capabilities.
- Send active-turn guidance with option/alt+enter when supported; otherwise prompts are queued.
- Spawn independent child sessions, monitor them across running Relay instances, and exchange attributed messages in both directions. See [Child Sessions and Live Collaboration](child-sessions.md).
- Start a focused, user-driven child thread from the TUI with `/handoff <goal>`; Relay prepares a context-aware opening prompt without switching away from the parent thread.
- Configure task types and keyword-triggered reminders to help agents delegate work with suitable model and thinking defaults. This is separate from the TUI handoff flow.

## Non-interactive execution

- Run one prompt with any configured or native ACP agent using `relay exec "<prompt>"`.
- Read prompts from stdin with `relay exec -` and write only the final agent text to stdout.
- Override advertised model and thinking/reasoning options with `--model` and `--thinking-level`.
- Decline permission requests and elicitations automatically so headless runs cannot wait for UI input.

## Terminal UI

- Streaming chat, thinking, tool, approval, elicitation, and info blocks.
- Tool rendering with compact headers, truncated detail previews, syntax highlighting, and diff views.
- Working tree diff overlay via `/diff`.
- Browse, edit, reorder, steer, or delete prompts queued while the agent is running; pause and resume queue draining when needed.
- Terminal and sound notifications for completions, errors, permissions, and input requests.

## Prompt editor

- Slash command autocomplete and agent/plugin command discovery.
- Native commands include `/new`, `/tree`, `/threads`, `/resume` (`/sessions`), `/subagents`, `/children`, `/fork`, `/handoff`, `/edit`, `/diff`, `/export`, `/mcp`, `/mode`, `/models`, `/thinking`, `/settings`, `/login`, `/logout`, `/plugins`, `/reload`, `/copy`, and `/exit` (`/quit`).
- `@` file/folder autocomplete and file context attachments.
- Tab path completion for relative, absolute, home, and quoted paths.
- Text paste expansion, file path paste handling, local image attachments, and OS clipboard image paste (`ctrl/option+v`).
- Prompt history with arrow navigation and `ctrl+r` search.
- Local shell commands: `!cmd` runs locally; `!!cmd` attaches output to the next prompt.
- External editor handoff with `F2`, `ctrl+x`, or `/edit`.
- Optional Vim-style editor keybindings.
- Link picker for the latest assistant message with `ctrl+l`.

## Web dashboard

Run `relay web` to start a local browser dashboard. It supports ACP chat, threads, agent switching, model/mode/thinking controls, session listing/resume, approvals, elicitations, prompt queueing, local bash commands, and path completion.

## Plugins

Relay plugins can add commands, keybindings, widgets, editor autocomplete, prompt interceptors, tool/message renderers, settings, MCP servers, and agent lifecycle hooks. Use `/plugins` to inspect and toggle plugins, and `/reload` after editing plugin files.

See [Relay Extensions](extensions.md).
