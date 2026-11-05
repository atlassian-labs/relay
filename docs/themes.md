# Relay Themes

Relay themes are JSON files that define the colors used by the terminal UI.

## Location

Place custom themes in:

```text
~/.config/relay/themes/*.json
```

When `XDG_CONFIG_HOME` is set, Relay uses `$XDG_CONFIG_HOME/relay/themes/*.json` instead.

Relay loads custom themes during startup and config reload. Valid custom themes appear in `/settings` under **Themes**. Select one there, or set its name in `~/.config/relay/config.toml`:

```toml
[ui]
theme = "my-theme"
```

A valid custom theme takes precedence over a bundled theme with the same name. If a custom theme cannot be read, parsed, or validated, Relay keeps the bundled theme (when one has that name) and shows a warning in the chat log at launch. When two custom files declare the same name, the alphabetically first file is kept and Relay shows a warning.

Restart Relay after adding or editing a theme file. Editing `config.toml` also causes Relay to rescan the theme directory.

## Creating a Theme

Create the directory and a JSON file:

```sh
mkdir -p ~/.config/relay/themes
$EDITOR ~/.config/relay/themes/my-theme.json
```

Every color must be a six-digit hexadecimal RGB value such as `#89b4fa`, or the name of a color declared in `vars`. Theme names must start with a letter or digit and may contain letters, digits, `.`, `_`, and `-`.

```json
{
  "name": "my-theme",
  "label": "My Theme",
  "vars": {
    "background": "#1e1e2e",
    "surface": "#313244",
    "surfaceAlt": "#45475a",
    "foreground": "#cdd6f4",
    "subtle": "#4d4f63",
    "muted": "#7f849c",
    "label": "#a6adc8",
    "blue": "#89b4fa",
    "yellow": "#f9e2af",
    "green": "#a6e3a1",
    "red": "#f38ba8",
    "orange": "#fab387",
    "purple": "#cba6f7",
    "teal": "#94e2d5"
  },
  "colors": {
    "bg": "background",
    "fg": "foreground",
    "textSubtle": "subtle",
    "textMuted": "muted",
    "textLabel": "label",
    "title": "foreground",
    "spinner": "blue",
    "accent": "blue",
    "info": "yellow",
    "markdownHeading": "yellow",
    "markdownCode": "teal",
    "selected": "green",
    "error": "red",
    "notice": "orange",
    "diffAdded": "green",
    "diffRemoved": "red",
    "toolBg": {
      "pending": "surface",
      "success": "#2b3a33",
      "error": "#3d2f38"
    },
    "badge": {
      "bg": "surface",
      "label": "purple"
    },
    "running": "blue",
    "success": "green",
    "failed": "red",
    "panel": "surface",
    "panelAlt": "surfaceAlt",
    "panelUser": "#393947",
    "border": "surfaceAlt",
    "thinking": "purple"
  }
}
```

`label` and `vars` are optional. `label` defaults to `name`. All fields inside `colors`, `toolBg`, and `badge` are required. Theme color names use camelCase throughout Relay and its plugin SDK.

## Color Reference

| Color                             | Purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| `bg`, `fg`                        | Main background and foreground                    |
| `textSubtle`                      | Lowest-emphasis text and separators               |
| `textMuted`                       | Metadata, thinking text, and tool output          |
| `textLabel`                       | Structural labels and details                     |
| `title`, `accent`, `info`         | Titles, primary accents, and informational states |
| `spinner`                         | Running spinner                                   |
| `markdownHeading`, `markdownCode` | Markdown headings and code                        |
| `selected`                        | Selected and highlighted items                    |
| `error`, `notice`                 | Error and warning states                          |
| `diffAdded`, `diffRemoved`        | Added and removed diff lines                      |
| `toolBg.pending`                  | Pending/running tool background                   |
| `toolBg.success`, `toolBg.error`  | Completed tool backgrounds                        |
| `badge.bg`, `badge.label`         | Badge background and label                        |
| `running`, `success`, `failed`    | Tool and activity statuses                        |
| `panel`, `panelAlt`, `panelUser`  | Standard, alternate, and user-message panels      |
| `border`                          | Borders and separators                            |
| `thinking`                        | Thinking/reasoning accent                         |

Relay derives deprecated `faint`, `dim`, and `muted` aliases from `textSubtle`, `textMuted`, and `textLabel`; custom themes do not need to define them.

## Troubleshooting

Theme warnings include the file path and the invalid field. Common causes are a missing required color, a value that is not `#RRGGBB`, an unknown variable, a circular variable reference, an invalid name, or malformed JSON.

If the configured theme is unavailable, Relay falls back to `catppuccin-mocha` and reports the invalid `ui.theme` value.
