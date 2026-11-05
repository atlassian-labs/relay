import { createTextAttributes } from "@opentui/core";
import { useSharedTerminalDimensions } from "../context/terminal-dimensions";
import { For, Show } from "solid-js";
import type { ListItem } from "../autocomplete";
import { getColors } from "../context/theme";
import { truncateTextEnd } from "../util/format";
import { centeredWindowStart } from "../util/list-window";
import { pluginSourceKind, pluginSourceLabel, type PluginSettingsItem } from "../util/plugins";

export interface PluginsOverlayProps {
  visible: () => boolean;
  items: () => readonly ListItem<PluginSettingsItem>[];
  selectedIndex: () => number;
  detailsOpen: () => boolean;
}

type DetailRow =
  | { readonly kind: "blank" }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "field"; readonly label: string; readonly text: string }
  | { readonly kind: "bullet"; readonly text: string; readonly dim?: boolean }
  | { readonly kind: "table"; readonly left: string; readonly right: string; readonly dim?: boolean };

const SECTION_GAP: DetailRow = { kind: "blank" };
const DETAIL_INDENT = "    ";
const TABLE_LEFT_WIDTH = 20;
const REGEXP_SPECIAL_CHARS = new Set(["\\", "^", "$", "*", "+", "?", ".", "(", ")", "|", "[", "]", "{", "}"]);

type ShortcutHint = readonly [keys: string, label: string];

function enabledCount(items: readonly ListItem<PluginSettingsItem>[]): number {
  return items.filter((item) => item.value.type === "plugin" && item.value.enabled).length;
}

function pluginCount(items: readonly ListItem<PluginSettingsItem>[]): number {
  return items.filter((item) => item.value.type === "plugin").length;
}

function bundledCount(items: readonly ListItem<PluginSettingsItem>[]): number {
  return items.filter((item) => item.value.type === "plugin" && pluginSourceKind(item.value.source) === "bundled")
    .length;
}

function localCount(items: readonly ListItem<PluginSettingsItem>[]): number {
  return items.filter((item) => item.value.type === "plugin" && pluginSourceKind(item.value.source) === "local").length;
}

function itemEnabled(item: PluginSettingsItem): boolean {
  return item.type === "system" ? item.enabled : item.enabled;
}

function itemName(item: PluginSettingsItem): string {
  return item.type === "system" ? "Enable/disable all plugins" : item.name;
}

function itemMarker(item: PluginSettingsItem): string {
  if (item.type === "system") return item.enabled ? "[*]" : "[ ]";
  return item.enabled ? "[*]" : "[-]";
}

function itemStatus(item: PluginSettingsItem): string {
  if (item.type === "system") return item.enabled ? "enabled" : "disabled";
  if (item.enabled) return "enabled";
  if (item.disabledByGlobal) return "disabled globally";
  return "disabled";
}

function itemSource(item: PluginSettingsItem): string {
  return item.type === "system" ? "system" : pluginSourceLabel(item.source);
}

function itemDescription(item: PluginSettingsItem): string {
  if (item.type === "system") return "Loads local and bundled Relay plugins.";
  return item.description ?? "No description provided.";
}

function rowDescription(item: PluginSettingsItem, selected: boolean): string {
  if (selected) return `Space to ${itemEnabled(item) ? "disable" : "enable"}; Enter view details.`;
  return itemDescription(item);
}

function selectedItem(
  items: readonly ListItem<PluginSettingsItem>[],
  selectedIndex: number,
): PluginSettingsItem | null {
  return items[selectedIndex]?.value ?? null;
}

function tableRow(left: string, right: string, dim?: boolean): DetailRow {
  return dim === undefined ? { kind: "table", left, right } : { kind: "table", left, right, dim };
}

function indentedMessage(text: string, dim = true): DetailRow {
  return { kind: "bullet", text, dim };
}

function escapeRegExp(value: string): string {
  return [...value].map((character) => (REGEXP_SPECIAL_CHARS.has(character) ? `\\${character}` : character)).join("");
}

function stripShortcutDescriptionPrefix(description: string, pluginName: string): string {
  return description.replace(new RegExp(`^${escapeRegExp(pluginName)}:\\s*`, "i"), "");
}

function commandDescription(command: Extract<PluginSettingsItem, { type: "plugin" }>["commands"][number]): string {
  return [command.description, command.argumentPlaceholder ? `args: ${command.argumentPlaceholder}` : undefined]
    .filter(Boolean)
    .join(" · ");
}

function commandRowsForPlugin(item: Extract<PluginSettingsItem, { type: "plugin" }>): DetailRow[] {
  if (!item.commands.length) {
    return [indentedMessage(item.enabled ? "No slash commands registered." : "Enable plugin to load slash commands.")];
  }
  return [
    tableRow("Command", "Description", true),
    ...item.commands.flatMap((command) => [
      tableRow(`/${command.invocationName}`, commandDescription(command)),
      ...(command.diagnostics ?? []).map((diagnostic) => indentedMessage(`warning: ${diagnostic.message}`, false)),
    ]),
  ];
}

function mcpCommand(server: Extract<PluginSettingsItem, { type: "plugin" }>["mcpServers"][number]): string {
  return [server.command, ...(server.args ?? [])].join(" ");
}

function mcpRowsForPlugin(item: Extract<PluginSettingsItem, { type: "plugin" }>): DetailRow[] {
  if (!item.mcpServers.length) {
    return [indentedMessage(item.enabled ? "No MCP servers registered." : "Enable plugin to load MCP servers.")];
  }
  return [
    ...(item.mcpRestartNeeded ? [indentedMessage("warning: MCP changes require an agent restart", false)] : []),
    tableRow("Server", "Command", true),
    ...item.mcpServers.map((server) => tableRow(server.name, mcpCommand(server))),
  ];
}

function detailRows(item: PluginSettingsItem): readonly DetailRow[] {
  if (item.type === "system") {
    return [
      { kind: "field", label: "Status", text: itemStatus(item) },
      { kind: "field", label: "Source", text: "system" },
      { kind: "field", label: "Description", text: itemDescription(item) },
      SECTION_GAP,
      { kind: "heading", text: "Controls" },
      indentedMessage("space toggles plugin loading globally", false),
      indentedMessage("enter or esc returns to the plugin list", false),
    ];
  }

  const commandRows = commandRowsForPlugin(item);
  const shortcutRows: DetailRow[] = item.shortcuts.length
    ? [
        tableRow("Key", "Description", true),
        ...item.shortcuts.map((shortcut) =>
          tableRow(
            shortcut.key,
            shortcut.description ? stripShortcutDescriptionPrefix(shortcut.description, item.name) : "",
          ),
        ),
      ]
    : [indentedMessage(item.enabled ? "No shortcut mappings registered." : "Enable plugin to load shortcuts.")];
  const settingRows: DetailRow[] = item.settings.length
    ? [
        tableRow("Setting", "Value / Description", true),
        ...item.settings.map((setting) =>
          tableRow(`${setting.title} (${setting.key})`, `${String(setting.value)} — ${setting.description}`),
        ),
      ]
    : [indentedMessage(item.enabled ? "No plugin settings registered." : "Enable plugin to load settings.")];
  const mcpRows = mcpRowsForPlugin(item);

  return [
    { kind: "field", label: "Status", text: itemStatus(item) },
    { kind: "field", label: "Source", text: itemSource(item) },
    { kind: "field", label: "Authors", text: item.author ?? "Unknown" },
    { kind: "field", label: "Description", text: itemDescription(item) },
    { kind: "field", label: "Location", text: item.path },
    SECTION_GAP,
    { kind: "heading", text: "Shortcut mappings" },
    ...shortcutRows,
    SECTION_GAP,
    { kind: "heading", text: "Slash commands" },
    ...commandRows,
    SECTION_GAP,
    { kind: "heading", text: "Settings" },
    ...settingRows,
    SECTION_GAP,
    { kind: "heading", text: "MCP servers" },
    ...mcpRows,
  ];
}

export function PluginsOverlay(props: PluginsOverlayProps) {
  const colors = getColors();
  const dims = useSharedTerminalDimensions();
  const bold = createTextAttributes({ bold: true });

  const contentWidth = () => Math.max(1, dims().width - 2);
  const footerHints = (): readonly ShortcutHint[] =>
    props.detailsOpen()
      ? [
          ["space", "enable/disable"],
          ["enter/esc/backspace", "back"],
          ["ctrl+c", "close"],
        ]
      : [
          ["space", "enable/disable"],
          ["enter", "view details"],
          ["↑/↓", "navigate"],
          ["esc", "close"],
        ];
  const listBodyHeight = () => Math.max(0, dims().height - 5);
  const detailsBodyHeight = () => Math.max(0, dims().height - 5);
  const windowStart = () =>
    centeredWindowStart(props.selectedIndex(), props.items().length, Math.min(props.items().length, listBodyHeight()));
  const visibleItems = () => {
    const start = windowStart();
    return props.items().slice(start, start + listBodyHeight());
  };
  const detailItem = () => selectedItem(props.items(), props.selectedIndex());
  const visibleDetailRows = () => {
    const item = detailItem();
    if (!item) return [];
    return detailRows(item).slice(0, detailsBodyHeight());
  };

  return (
    <Show when={props.visible()}>
      <box
        position="absolute"
        zIndex={2450}
        top={0}
        left={0}
        width={dims().width}
        height={dims().height}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={colors.bg}
      >
        <Show
          when={props.detailsOpen()}
          fallback={
            <>
              <box height={1} width="100%">
                <text fg={colors.title} attributes={bold} wrapMode="none">
                  Plugins
                </text>
              </box>
              <box height={1} width="100%">
                <text fg={colors.textSubtle} wrapMode="none">
                  Browse local and bundled Relay plugins.
                </text>
              </box>
              <box height={1} width="100%">
                <text fg={colors.textSubtle} wrapMode="none">
                  {`Enabled ${enabledCount(props.items())} of ${pluginCount(props.items())} plugins · Bundled ${bundledCount(
                    props.items(),
                  )} · Local ${localCount(props.items())}`}
                </text>
              </box>
              <box height={1} />
              <For each={visibleItems()}>
                {(entry, rawIndex) => {
                  const idx = () => windowStart() + rawIndex();
                  const selected = () => idx() === props.selectedIndex();
                  const item = () => entry.value;
                  const marker = () => `${selected() ? "›" : " "} ${itemMarker(item())}`;
                  const nameWidth = () => Math.min(34, Math.max(18, Math.floor(contentWidth() * 0.28)));
                  const sourceWidth = () => Math.min(16, Math.max(10, Math.floor(contentWidth() * 0.14)));
                  const statusWidth = () => 10;
                  const descriptionWidth = () =>
                    Math.max(0, contentWidth() - nameWidth() - sourceWidth() - statusWidth() - 10);
                  return (
                    <box height={1} width="100%" flexDirection="row">
                      <text
                        fg={selected() ? colors.selected : colors.fg}
                        attributes={selected() ? bold : undefined}
                        wrapMode="none"
                      >
                        {`${marker()} ${truncateTextEnd(itemName(item()), nameWidth()).padEnd(nameWidth())}`}
                      </text>
                      <text fg={selected() ? colors.selected : colors.textSubtle} wrapMode="none">
                        {truncateTextEnd(itemSource(item()), sourceWidth()).padEnd(sourceWidth())}
                      </text>
                      <text
                        fg={selected() ? colors.selected : colors.textSubtle}
                        attributes={selected() ? bold : undefined}
                        wrapMode="none"
                      >
                        {`  ${truncateTextEnd(itemStatus(item()), statusWidth()).padEnd(statusWidth())}`}
                      </text>
                      <text
                        fg={selected() ? colors.selected : colors.textSubtle}
                        attributes={selected() ? bold : undefined}
                        wrapMode="none"
                      >
                        {`  ${truncateTextEnd(rowDescription(item(), selected()), descriptionWidth())}`}
                      </text>
                    </box>
                  );
                }}
              </For>
            </>
          }
        >
          <Show when={detailItem()}>
            {(item) => (
              <>
                <box height={1} width="100%" flexDirection="row">
                  <text fg={colors.title} attributes={bold} wrapMode="none">
                    {truncateTextEnd(`Plugins / ${itemName(item())}`, contentWidth())}
                  </text>
                </box>
                <box height={1} width="100%">
                  <text fg={colors.textSubtle} wrapMode="none">
                    {`Status: ${itemStatus(item())} · Source: ${itemSource(item())}`}
                  </text>
                </box>
                <box height={1} />
                <For each={visibleDetailRows()}>
                  {(row) => (
                    <box height={1} width="100%" flexDirection="row">
                      <Show when={row.kind === "blank"}>
                        <text wrapMode="none"> </text>
                      </Show>
                      <Show when={row.kind === "heading"}>
                        <text fg={colors.selected} attributes={bold} wrapMode="none">
                          {(row as Extract<DetailRow, { kind: "heading" }>).text}
                        </text>
                      </Show>
                      <Show when={row.kind === "field"}>
                        <text fg={colors.textSubtle} wrapMode="none">
                          {`${(row as Extract<DetailRow, { kind: "field" }>).label}: `.padEnd(14)}
                        </text>
                        <text fg={colors.fg} wrapMode="none">
                          {truncateTextEnd(
                            (row as Extract<DetailRow, { kind: "field" }>).text,
                            Math.max(0, contentWidth() - 14),
                          )}
                        </text>
                      </Show>
                      <Show when={row.kind === "bullet"}>
                        <text
                          fg={(row as Extract<DetailRow, { kind: "bullet" }>).dim ? colors.textSubtle : colors.fg}
                          wrapMode="none"
                        >
                          {truncateTextEnd(
                            `${DETAIL_INDENT}${(row as Extract<DetailRow, { kind: "bullet" }>).text}`,
                            contentWidth(),
                          )}
                        </text>
                      </Show>
                      <Show when={row.kind === "table"}>
                        <text
                          fg={(row as Extract<DetailRow, { kind: "table" }>).dim ? colors.textSubtle : colors.fg}
                          wrapMode="none"
                        >
                          {truncateTextEnd(
                            `${DETAIL_INDENT}${truncateTextEnd(
                              (row as Extract<DetailRow, { kind: "table" }>).left,
                              TABLE_LEFT_WIDTH,
                            ).padEnd(TABLE_LEFT_WIDTH)}${(row as Extract<DetailRow, { kind: "table" }>).right}`,
                            contentWidth(),
                          )}
                        </text>
                      </Show>
                    </box>
                  )}
                </For>
              </>
            )}
          </Show>
        </Show>
        <box flexGrow={1} />
        <box height={1} width="100%" backgroundColor={colors.bg}>
          <text bg={colors.bg} wrapMode="none">
            <For each={footerHints()}>
              {([keys, label], index) => (
                <>
                  <Show when={index() > 0}>
                    <span style={{ fg: colors.textSubtle } as never}> · </span>
                  </Show>
                  <span style={{ fg: colors.textLabel, bold: true } as never}>{keys}</span>
                  <span style={{ fg: colors.textSubtle } as never}> {label}</span>
                </>
              )}
            </For>
          </text>
        </box>
      </box>
    </Show>
  );
}
