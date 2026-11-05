---
name: relay-themes
description: Create, modify, validate, troubleshoot, and install custom Relay terminal themes. Use when a user asks for a Relay color scheme, wants to port an existing palette, needs a theme under ~/.config/relay/themes, or has custom-theme loading or validation warnings.
disable-model-invocation: true
---

# Relay Themes

Create complete, readable custom Relay themes in the user's global Relay configuration.

## Workflow

1. Read the bundled **Relay Themes Reference** below for the current JSON contract, required colors, precedence, and troubleshooting guidance.
2. Resolve the target directory as `${XDG_CONFIG_HOME:-$HOME/.config}/relay/themes/`.
3. Inspect an existing target theme in full before modifying it.
4. Choose a lowercase theme name using letters, digits, `.`, `_`, or `-`, starting with a letter or digit.
5. Define every required camelCase color field. Use six-digit `#RRGGBB` colors or named entries from `vars`.
6. Validate the JSON syntax and ensure all variable references resolve without cycles.
7. Preserve contrast between text and its background panels, especially `textMuted`, `textLabel`, borders, selection state, and diff colors.
8. Tell the user to restart Relay after adding or editing a theme. Editing `config.toml` also triggers a theme rescan.

## Installation and Selection

Write themes only under the user config directory unless the user explicitly requests a Relay source change. Do not place custom themes in a workspace-local directory.

Select the result from `/settings` under **Themes**, or set:

```toml
[ui]
theme = "my-theme"
```

A valid user theme may intentionally override a bundled theme with the same name. Invalid custom themes must not replace a bundled theme; Relay reports their file and validation issue at launch.

## Validation

- Parse the finished file with a JSON parser.
- Check every required color from the reference document.
- Reject shorthand hex, alpha hex, terminal color indexes, empty strings, missing variables, and circular variables.
- Ignore unknown extra color fields when reviewing forward-compatible files.
- Prefer a new theme name when an override was not explicitly requested.
- Preserve unrelated theme files.
- Never commit or push unless the user asks.
