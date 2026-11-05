import { getThemeIds } from "./themes";

export type EditableConfigKey =
  | "ui.theme"
  | "ui.thread_worktree_location"
  | "ui.terminal_title_prompt_source"
  | "ui.prompt_marker"
  | "ui.selection_marker"
  | "ui.editor_style"
  | "ui.mermaid_rendering"
  | "ui.tool_result_preview_lines"
  | "ui.thinking_preview_lines"
  | "ui.show_thinking"
  | "ui.sticky_prompt_header_lines"
  | "ui.succinct_tool_results"
  | "ui.slash_panel_position"
  | "ui.show_tips"
  | "ui.vim_keybindings"
  | "notifications.terminal_enabled"
  | "notifications.sound_enabled"
  | "notifications.volume"
  | "telemetry.analytics_enabled";

export type ConfigValueType = "boolean" | "number" | "integer" | "choice";

export interface ConfigSetting {
  key: EditableConfigKey;
  title: string;
  description: string;
  type: ConfigValueType;
  default: boolean | number | string;
  editable: true;
  min?: number;
  max?: number;
  choices?: () => readonly string[];
  acpOptionId?: string;
}

export const CONFIG_SETTINGS: readonly ConfigSetting[] = [
  {
    key: "ui.theme",
    title: "Theme",
    description: "UI theme.",
    type: "choice",
    default: "catppuccin-mocha",
    editable: true,
    choices: getThemeIds,
    acpOptionId: "relay.ui.theme",
  },
  {
    key: "ui.mermaid_rendering",
    title: "Mermaid rendering",
    description: "Render Mermaid code blocks as terminal-friendly Unicode diagrams.",
    type: "choice",
    default: "streaming",
    editable: true,
    choices: () => ["off", "final", "streaming"] as const,
  },
  {
    key: "ui.tool_result_preview_lines",
    title: "Tool result preview lines",
    description: "Number of tool result lines to show before truncating expandable output; 0 hides tool results.",
    type: "integer",
    default: 5,
    editable: true,
    min: 0,
    acpOptionId: "relay.ui.tool_result_preview_lines",
  },
  {
    key: "ui.thinking_preview_lines",
    title: "Thinking preview lines",
    description: "Number of finalized thinking lines to show before truncating; 0 disables truncation.",
    type: "integer",
    default: 1,
    editable: true,
    min: 0,
    max: 10,
    acpOptionId: "relay.ui.thinking_preview_lines",
  },
  {
    key: "ui.show_thinking",
    title: "Thinking visibility",
    description: "Show or hide thinking blocks.",
    type: "boolean",
    default: true,
    editable: true,
  },
  {
    key: "ui.succinct_tool_results",
    title: "Succinct tool results",
    description: "Hide result bodies for read/search-style tools when possible.",
    type: "boolean",
    default: true,
    editable: true,
    acpOptionId: "relay.ui.succinct_tool_results",
  },
  {
    key: "ui.slash_panel_position",
    title: "Slash panel position",
    description: "Show the slash command panel above or below the editor.",
    type: "choice",
    default: "bottom",
    editable: true,
    choices: () => ["bottom", "top"] as const,
  },
  {
    key: "ui.show_tips",
    title: "Tips",
    description: "Show tips on the welcome screen and in the editor header.",
    type: "boolean",
    default: true,
    editable: true,
  },
  {
    key: "ui.sticky_prompt_header_lines",
    title: "Sticky prompt header lines",
    description: "Number of lines shown in the sticky prompt header. Set to 0 to disable.",
    type: "integer",
    default: 3,
    editable: true,
    min: 0,
    max: 10,
    acpOptionId: "relay.ui.sticky_prompt_header_lines",
  },
  {
    key: "ui.thread_worktree_location",
    title: "Thread worktree location",
    description: "Where Relay-created thread worktrees are placed.",
    type: "choice",
    default: "relay",
    editable: true,
    choices: () => ["relay", "repo"] as const,
  },
  {
    key: "ui.prompt_marker",
    title: "Prompt marker",
    description:
      "Marker shown before normal prompt input; choose none to hide it. ! and !! still indicate local bash modes.",
    type: "choice",
    default: ">",
    editable: true,
    choices: () => [">", "❯", "#", "›", "$", ""] as const,
  },
  {
    key: "ui.selection_marker",
    title: "Selection marker",
    description: "Marker shown before selected rows in selection panels; choose none to hide it.",
    type: "choice",
    default: "→",
    editable: true,
    choices: () => ["→", "›", "❯", ">", "•", ""] as const,
  },
  {
    key: "ui.editor_style",
    title: "Editor style",
    description: "Choose the composer appearance.",
    type: "choice",
    default: "codex",
    editable: true,
    choices: () => ["codex", "pi"] as const,
  },
  {
    key: "ui.terminal_title_prompt_source",
    title: "Terminal title prompt source",
    description: "Which user prompt to show in the terminal title.",
    type: "choice",
    default: "smart",
    editable: true,
    choices: () => ["smart", "first", "last"] as const,
  },
  {
    key: "notifications.terminal_enabled",
    title: "Terminal notifications",
    description: "Show terminal notifications for completion, errors, and input requests.",
    type: "boolean",
    default: false,
    editable: true,
  },
  {
    key: "notifications.sound_enabled",
    title: "Notification sounds",
    description: "Play notification sounds for completion, errors, and input requests.",
    type: "boolean",
    default: false,
    editable: true,
  },
  {
    key: "notifications.volume",
    title: "Notification volume",
    description: "Volume level from 0.0 to 1.0.",
    type: "number",
    default: 0.5,
    editable: true,
    min: 0,
    max: 1,
  },
  {
    key: "ui.vim_keybindings",
    title: "Vim keybindings",
    description: "Enable Vim-style normal-mode shortcuts in the prompt editor.",
    type: "boolean",
    default: false,
    editable: true,
  },
  {
    key: "telemetry.analytics_enabled",
    title: "Usage analytics",
    description:
      "Collect basic usage analytics (session duration, message count, tool-call count, agent type). Changes take effect on next restart.",
    type: "boolean",
    default: false,
    editable: true,
  },
];

const CONFIG_SETTING_BY_KEY = new Map(CONFIG_SETTINGS.map((setting) => [setting.key, setting]));
const CONFIG_SETTING_BY_ACP_OPTION_ID = new Map(
  CONFIG_SETTINGS.flatMap((setting) => (setting.acpOptionId ? [[setting.acpOptionId, setting] as const] : [])),
);

export function getConfigSetting(key: string): ConfigSetting | undefined {
  return CONFIG_SETTING_BY_KEY.get(key as EditableConfigKey);
}

export function getConfigSettingByAcpOptionId(optionId: string): ConfigSetting | undefined {
  return CONFIG_SETTING_BY_ACP_OPTION_ID.get(optionId);
}

export function isEditableConfigKey(key: string): key is EditableConfigKey {
  return CONFIG_SETTING_BY_KEY.has(key as EditableConfigKey);
}
