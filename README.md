# Relay

![Relay](assets/relay1.png)

Relay is an [ACP](https://agentclientprotocol.com)-first terminal UI for coding
agents. The agent owns execution; Relay owns the experience — rendering ACP
output, managing prompt history, config, themes, and subprocess lifecycle.

Relay is agent-agnostic: it works with Codex, Claude Code, Cursor Agent, and any
other agent that speaks the Agent Client Protocol, in both a terminal UI and a
local web dashboard.

## Features

- Launch ACP agents over stdio or connect to ACP WebSocket agents.
- Native runners for Codex, Claude Code, and Cursor Agent — no config required.
- Per-workspace threads, optional git worktree threads, and session
  create/resume/list/delete when the agent supports it.
- Switch model, mode, and thinking level from advertised ACP capabilities.
- Streaming chat, thinking, tool, approval, and elicitation blocks with
  syntax highlighting, truncated tool details, and diff views.
- Slash-command and `@` file autocomplete, prompt history with `ctrl+r` search,
  image paste, external-editor handoff, and optional Vim keybindings.
- Terminal and sound notifications for completions, errors, and approvals.
- A plugin system for commands, keybindings, widgets, renderers, and MCP servers.
- A local web dashboard mirroring the terminal experience.

See [docs/features.md](docs/features.md) for the full list.

## Getting started

To install a released build with Homebrew, the install script, or a GitHub
Release archive, see [docs/installation.md](docs/installation.md).

To run from a source checkout, Relay requires [Bun](https://bun.sh).

```sh
git clone https://github.com/atlassian-labs/relay.git
cd relay
bun install
```

Run from source against a native agent:

```sh
bun run dev --agent codex
```

Build a standalone bundle (output in `dist/`):

```sh
bun run build
```

## Usage

```sh
relay [--agent <name>] [--prompt "<text>"] [--continue] [--resume]
relay exec [--agent <name>] [--model <model>] [--thinking-level <level>] "<prompt>"
relay web [--host <host>] [--port <port>] [--no-open]
relay add <name> "<command>" --profile <profile>
```

Common flags:

| Flag                     | Description                                  |
| ------------------------ | -------------------------------------------- |
| `--agent`, `-a`          | Agent to launch (native name or configured). |
| `--model`, `-m`          | Set the model for `exec` mode.               |
| `--prompt`, `-p`         | Send an initial prompt on startup.           |
| `--continue`, `-c`       | Continue the most recent session.            |
| `--resume`, `-r`         | Resume a session interactively.              |
| `--thinking-level`, `-t` | Set the initial thinking level.              |
| `web`                    | Start the local web dashboard.               |

## Non-interactive mode

Run one prompt without starting the terminal or web UI. The final agent text is
written to stdout, making it suitable for scripts and pipelines:

```sh
relay exec "Summarize this repository"
echo "Review the current changes" | relay exec --agent codex -
relay exec --model <model-id> --thinking-level high "Review the current changes"
```

The configured default agent is used when `--agent` is omitted. Model and
thinking-level overrides require the agent to advertise those ACP configuration
options. Permission requests and elicitations are declined in non-interactive
mode so the process cannot wait for UI input.

## Native agent support

Relay has native support for Codex, Claude Code, and Cursor Agent. These agents
work without `[agents.runners]` config; Relay knows how to launch them and
applies their built-in rendering/behavior profile where available.

| Agent        | Command                | Aliases                      | Native runner                                                      |
| ------------ | ---------------------- | ---------------------------- | ------------------------------------------------------------------ |
| Codex        | `relay --agent codex`  | `codex-acp`                  | `npx --yes --loglevel=error @zed-industries/codex-acp`             |
| Claude Code  | `relay --agent claude` | `claude-code`, `claude-acp`  | `npx --yes --loglevel=error @agentclientprotocol/claude-agent-acp` |
| Cursor Agent | `relay --agent cursor` | `cursor-agent`, `cursor-acp` | `agent acp`                                                        |

If `--agent <name>` is not a native agent and is not configured under
`[agents.runners.<name>]`, Relay shows a launch error on the welcome screen
instead of silently falling back.

## Other agents

Add a runner for any ACP-capable agent:

```sh
relay add my-agent "my-agent-command acp" --profile default
relay --agent my-agent
```

Equivalent config in `~/.config/relay/config.toml`:

```toml
[agents]
default = "my-agent"

[agents.runners.my-agent]
command = "my-agent-command"
args = ["acp"]
profile = "default"
```

Available profiles: `default`, `codex`, `claude`, `alta`, and `rovodev`.

## Web dashboard

Run a local browser dashboard with the same ACP experience as the terminal:

```sh
relay web
```

## Tips

- Use `!cmd` to run a local shell command without sending the output to the agent.
- Use `!!cmd` to run a local shell command and attach its output to your next prompt.
- Press `ctrl+b` to open the thread sidebar and spawn or switch between threads,
  with or without git worktrees.
- Press `ctrl+r` to search prompt history and `ctrl+l` to open the link picker.

## Extensions

Relay extensions customize local UI and prompt workflow surfaces. Author
extensions with the `@atlassian/relay-plugin-sdk` package; see the
[SDK README](packages/relay-plugin-sdk/README.md) and the
[extension guide](docs/extensions.md). Use `/plugins` to inspect and toggle
plugins, and `/reload` after editing plugin files.

## Telemetry

Relay does not collect telemetry by default. The first time you start it
interactively, Relay asks whether to enable anonymous usage analytics (session
duration, message count, tool-call count, slash-command names, and agent type);
prompts, responses, and file contents are never collected. The default answer is
no, and your answer applies from the next start. Non-interactive starts (piped
output, CI) record no answer, so you are asked on your first interactive run.

Change your choice at any time with `/settings`, or by editing
`telemetry.analytics_enabled` in `~/.config/relay/config.toml`. Telemetry always
respects the [`DO_NOT_TRACK`](https://consoledonottrack.com) standard: setting
`DO_NOT_TRACK=1` or `RELAY_TELEMETRY_DISABLED=1` disables it regardless of other
settings, and Relay does not ask for consent.

## Documentation

- [Features](docs/features.md)
- [Child sessions and live collaboration](docs/child-sessions.md)
- [Configuration](docs/configuration.md)
- [Extensions](docs/extensions.md)
- [Custom themes](docs/themes.md)
- [Development](docs/development.md)

## Tests

```sh
bun test
```

## Contributions

Contributions to Relay are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md)
to get started, and review our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright (c) 2026 Atlassian US, Inc. and others. Apache 2.0 licensed, see
[LICENSE](LICENSE) file.

[![With love from Atlassian](https://raw.githubusercontent.com/atlassian-internal/oss-assets/master/banner-cheers-light.png)](https://www.atlassian.com)
