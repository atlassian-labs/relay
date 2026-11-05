/**
 * Settings & plugins overlay management.
 *
 * Builds and refreshes the interactive `/settings` and `/plugins` overlays and
 * applies the toggles. Extracted from app-root as a factory: the overlay
 * primitive signals and the two settings-submenu `let`s stay in the root (they
 * are also read by `selectOverlayItem`, `hideOverlay`, and the keyboard
 * handler), so they are injected here as accessors/mutators.
 */

import { type ListItem, SelectionMode, type SlashCommand } from "../autocomplete";
import { nextBlockId, useApp } from "../state";
import type { PluginRunner } from "../../plugins";
import type { SelectionOverlayBehavior } from "./selection-overlay";
import type { ConfigSetting, EditableConfigKey } from "../../config/schema";
import { getThemeOptions } from "../../config/themes";
import type { SessionConfigOptionState } from "../state";
import {
  getConfig,
  setConfigValue,
  setPluginSettingValue,
  setPluginsEnabled,
  setRelayPluginEnabled,
} from "../../config";
import { invalidateSyntaxStyle } from "../context/theme";
import {
  SETTING_VALUE_CHOICES,
  buildAcpConfigOptionValueItems,
  buildNotificationSettingsItems,
  buildSettingsItems,
  formatAcpConfigOptionTitle,
  formatAcpConfigOptionValue,
  formatPluginSettingValue,
  formatSettingValue,
  getConfigValue,
  nextAcpConfigOptionValue,
  nextPluginSettingValue,
  nextSettingValue,
  type AcpConfigOptionValueItem,
  type PluginSettingEntry,
  type SettingsItem,
  type SettingsSubmenuId,
} from "../util/settings";
import { buildPluginItems, type PluginSettingsItem } from "../util/plugins";

type App = ReturnType<typeof useApp>;
export type SettingsSelection =
  | EditableConfigKey
  | SettingsSubmenuId
  | { readonly type: "plugin-setting"; readonly pluginId: string; readonly key: string }
  | { readonly acpConfigOptionId: string };

export interface SettingsOverlayDeps {
  showSelectionOverlay: (
    items: ListItem<any>[],
    mode: SelectionMode,
    layout?: any,
    selectedIndex?: number,
    behavior?: SelectionOverlayBehavior,
  ) => void;
  setSettingsOverlayActive: (value: boolean) => void;
  settingsOverlayActive: () => boolean;
  selectionMode: () => SelectionMode | null;
  overlayItems: () => ListItem<any>[];
  overlayIndex: () => number;
  setOverlayItems: (items: ListItem<any>[]) => void;
  setOverlayIndex: (value: number) => void;
  setSelectionAllItems: (items: ListItem<any>[]) => void;
  getActiveSettingsSubmenu: () => SettingsSubmenuId | null;
  setActiveSettingsSubmenu: (value: SettingsSubmenuId | null) => void;
  getActiveSettingsValueSetting: () => ConfigSetting | null;
  setActiveSettingsValueSetting: (value: ConfigSetting | null) => void;
  acpConfigOptions: () => SessionConfigOptionState[];
  updateAcpConfigOption: (option: SessionConfigOptionState, value: string, app: App) => Promise<void>;
  pluginRunner: () => PluginRunner | null;
  pluginsCwd: () => string;
  agentCommands: () => readonly SlashCommand[];
  applyTheme: (themeId: string) => void;
  showToast: (message: string, variant?: any, duration?: number) => void;
}

export interface SettingsOverlayController {
  openThemeOverlay: (fromSettings?: boolean) => void;
  openNotificationSettingsOverlay: (selected?: EditableConfigKey) => void;
  openSettingsSubmenu: (id: SettingsSubmenuId) => void;
  reopenSettingsAfterUpdate: (selected: EditableConfigKey, submenu: SettingsSubmenuId | null) => void;
  openSettingValueOverlay: (setting: ConfigSetting, parentSubmenu?: SettingsSubmenuId | null) => void;
  openAcpConfigOptionValueOverlay: (option: SessionConfigOptionState) => void;
  pluginSettingEntries: () => PluginSettingEntry[];
  openSettingsOverlay: (selected?: SettingsSelection) => void;
  openPluginsOverlay: (selectedPluginId?: string) => void;
  openPluginDetailsOverlay: (selectedPluginId?: string) => void;
  refreshPluginsOverlay: () => void;
  updateInteractiveSetting: (setting: ConfigSetting, app: App, parentSubmenu?: SettingsSubmenuId | null) => void;
  updateInteractiveAcpConfigOption: (option: SessionConfigOptionState, app: App, value?: string) => void;
  updateInteractivePluginSetting: (item: Extract<SettingsItem, { type: "plugin-setting" }>, app: App) => void;
  updateInteractivePlugin: (item: PluginSettingsItem, app: App) => void;
  refreshSettingsOverlay: () => void;
}

export function buildThemeItems(
  current: string,
  options: ReadonlyArray<readonly [string, string]> = getThemeOptions(),
): ListItem<string>[] {
  return options.map(([themeId, label]) => ({
    value: themeId,
    label: themeId,
    description: label === themeId ? "" : label,
    active: themeId === current,
  }));
}

export function createSettingsOverlayController(deps: SettingsOverlayDeps): SettingsOverlayController {
  const {
    showSelectionOverlay,
    setSettingsOverlayActive,
    settingsOverlayActive,
    selectionMode,
    overlayItems,
    overlayIndex,
    setOverlayItems,
    setOverlayIndex,
    setSelectionAllItems,
    getActiveSettingsSubmenu,
    setActiveSettingsSubmenu,
    getActiveSettingsValueSetting,
    setActiveSettingsValueSetting,
    acpConfigOptions,
    updateAcpConfigOption,
    pluginRunner,
    pluginsCwd,
    agentCommands,
    applyTheme,
    showToast,
  } = deps;

  function settingsSelectionBehavior(parentSubmenu: SettingsSubmenuId | null): SelectionOverlayBehavior {
    return {
      onSelect: (item, app) => {
        const setting = item.value as SettingsItem;
        if (setting.type === "submenu") {
          openSettingsSubmenu(setting.id);
        } else if (setting.type === "plugin-setting") {
          updateInteractivePluginSetting(setting, app);
        } else if (setting.type === "acp-config-option") {
          openAcpConfigOptionValueOverlay(setting.option);
        } else if (SETTING_VALUE_CHOICES[setting.setting.key]) {
          openSettingValueOverlay(setting.setting, parentSubmenu);
        } else {
          updateInteractiveSetting(setting.setting, app, parentSubmenu);
        }
      },
    };
  }

  function openThemeOverlay(fromSettings = false): void {
    setActiveSettingsValueSetting(null);
    const current = getConfig().ui.theme;
    const items = buildThemeItems(current);
    const selectedIndex = fromSettings
      ? 0
      : Math.max(
          0,
          items.findIndex((item) => item.value === current),
        );
    showSelectionOverlay(items, SelectionMode.THEME, undefined, selectedIndex, {
      onSelect: (item) => {
        const themeId = item.value as string;
        applyTheme(themeId);
        if (fromSettings) openSettingsOverlay("themes");
        showToast(`Theme: ${themeId}`);
      },
    });
    if (fromSettings) {
      setSettingsOverlayActive(true);
      setActiveSettingsSubmenu("themes");
    }
  }

  function openNotificationSettingsOverlay(selected?: EditableConfigKey): void {
    setActiveSettingsSubmenu("notifications");
    setActiveSettingsValueSetting(null);
    const items = buildNotificationSettingsItems(getConfig());
    const selectedIndex = selected
      ? items.findIndex((item) => item.value.type === "setting" && item.value.setting.key === selected)
      : 0;
    showSelectionOverlay(
      items,
      SelectionMode.SETTINGS,
      {
        labelMinWidth: 34,
        labelMaxWidth: 52,
        descriptionMaxWidth: 80,
        viewportReservedWidth: 8,
      },
      selectedIndex >= 0 ? selectedIndex : 0,
      settingsSelectionBehavior("notifications"),
    );
    setSettingsOverlayActive(true);
  }

  function openSettingsSubmenu(id: SettingsSubmenuId): void {
    if (id === "themes") openThemeOverlay(true);
    else if (id === "notifications") openNotificationSettingsOverlay();
  }

  function reopenSettingsAfterUpdate(selected: EditableConfigKey, submenu: SettingsSubmenuId | null): void {
    if (submenu === "notifications") {
      openNotificationSettingsOverlay(selected);
      return;
    }
    openSettingsOverlay(selected);
  }

  function openSettingValueOverlay(setting: ConfigSetting, parentSubmenu: SettingsSubmenuId | null = null): void {
    const choices = SETTING_VALUE_CHOICES[setting.key];
    if (!choices) return;
    setActiveSettingsSubmenu(parentSubmenu);
    setActiveSettingsValueSetting(setting);
    const current = getConfigValue(getConfig(), setting.key);
    const items: ListItem<boolean | number | string>[] = choices.map((choice) => ({
      value: choice.value,
      label: formatSettingValue(setting, choice.value),
      description: choice.description ?? "",
      active: current === choice.value,
    }));
    const selectedIndex = items.findIndex((item) => item.value === current);
    showSelectionOverlay(
      items,
      SelectionMode.SETTING_VALUE,
      {
        labelMinWidth: 18,
        labelMaxWidth: 24,
        descriptionMaxWidth: 80,
        viewportReservedWidth: 8,
      },
      selectedIndex >= 0 ? selectedIndex : 0,
      {
        onSelect: (item, app) => {
          const nextValue = item.value as boolean | number | string;
          try {
            setConfigValue(setting.key, nextValue);
            invalidateSyntaxStyle();
            reopenSettingsAfterUpdate(setting.key, parentSubmenu);
            showToast(`${setting.title}: ${formatSettingValue(setting, nextValue)}`);
          } catch (err) {
            app.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Failed to update setting: ${err}`,
              variant: "error",
            });
          }
        },
      },
    );
    setSettingsOverlayActive(true);
  }

  function openAcpConfigOptionValueOverlay(option: SessionConfigOptionState): void {
    setActiveSettingsSubmenu(null);
    setActiveSettingsValueSetting(null);
    const items = buildAcpConfigOptionValueItems(option);
    const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
    const selectedIndex = items.findIndex((item) => item.value.value === currentValue);
    showSelectionOverlay(
      items,
      SelectionMode.ACP_CONFIG_VALUE,
      {
        labelMinWidth: 18,
        labelMaxWidth: 32,
        descriptionMaxWidth: 80,
        viewportReservedWidth: 8,
      },
      selectedIndex >= 0 ? selectedIndex : 0,
      {
        onSelect: (item, app) => {
          const valueItem = item.value as AcpConfigOptionValueItem;
          updateInteractiveAcpConfigOption(valueItem.option, app, valueItem.value);
        },
      },
    );
    setSettingsOverlayActive(true);
  }

  function pluginSettingEntries(): PluginSettingEntry[] {
    return pluginRunner()?.allPluginSettings() ?? [];
  }

  function openSettingsOverlay(selected?: SettingsSelection): void {
    setActiveSettingsSubmenu(null);
    setActiveSettingsValueSetting(null);
    const items = buildSettingsItems(getConfig(), pluginSettingEntries(), {
      acpConfigOptions: acpConfigOptions(),
    });
    const selectedIndex = selected
      ? items.findIndex((item) => {
          if (typeof selected === "object") {
            if ("acpConfigOptionId" in selected) {
              return item.value.type === "acp-config-option" && item.value.option.id === selected.acpConfigOptionId;
            }
            return (
              item.value.type === "plugin-setting" &&
              item.value.plugin.id === selected.pluginId &&
              item.value.key === selected.key
            );
          }
          return item.value.type === "submenu"
            ? item.value.id === selected
            : item.value.type === "setting" && item.value.setting.key === selected;
        })
      : 0;
    showSelectionOverlay(
      items,
      SelectionMode.SETTINGS,
      {
        labelMinWidth: 34,
        labelMaxWidth: 52,
        descriptionMaxWidth: 80,
        viewportReservedWidth: 8,
      },
      selectedIndex >= 0 ? selectedIndex : 0,
      settingsSelectionBehavior(null),
    );
  }

  function pluginItems(): ListItem<PluginSettingsItem>[] {
    return buildPluginItems(pluginsCwd(), getConfig(), pluginRunner(), { agentCommands: agentCommands() });
  }

  function selectedPluginIndex(items: readonly ListItem<PluginSettingsItem>[], selectedPluginId?: string): number {
    return selectedPluginId
      ? items.findIndex((item) => item.value.type === "plugin" && item.value.id === selectedPluginId)
      : 0;
  }

  function openPluginsOverlay(selectedPluginId?: string): void {
    const items = pluginItems();
    const selectedIndex = selectedPluginIndex(items, selectedPluginId);
    showSelectionOverlay(
      items,
      SelectionMode.PLUGINS,
      {
        labelMinWidth: 34,
        labelMaxWidth: 52,
        descriptionMaxWidth: 100,
        viewportReservedWidth: 8,
      },
      selectedIndex >= 0 ? selectedIndex : 0,
      {
        closeOnSelect: false,
        onSelect: (item) => {
          const plugin = item.value as PluginSettingsItem;
          openPluginDetailsOverlay(plugin.type === "plugin" ? plugin.id : undefined);
        },
      },
    );
  }

  function openPluginDetailsOverlay(selectedPluginId?: string): void {
    const items = pluginItems();
    const selectedIndex = selectedPluginIndex(items, selectedPluginId);
    showSelectionOverlay(
      items,
      SelectionMode.PLUGIN_DETAILS,
      {
        labelMinWidth: 34,
        labelMaxWidth: 52,
        descriptionMaxWidth: 100,
        viewportReservedWidth: 8,
      },
      selectedIndex >= 0 ? selectedIndex : 0,
      {
        closeOnSelect: false,
        onSelect: () => openPluginsOverlay(selectedPluginId),
      },
    );
  }

  function refreshPluginsOverlay(): void {
    const mode = selectionMode();
    if (mode !== SelectionMode.PLUGINS && mode !== SelectionMode.PLUGIN_DETAILS) return;
    const selected = overlayItems()[overlayIndex()]?.value as PluginSettingsItem | undefined;
    const items = pluginItems();
    setSelectionAllItems(items);
    setOverlayItems(items);
    if (!selected) return;
    const index = items.findIndex((item) => {
      if (selected.type === "system") return item.value.type === "system";
      return item.value.type === "plugin" && item.value.id === selected.id;
    });
    if (index >= 0) setOverlayIndex(index);
  }

  function updateInteractiveSetting(
    setting: ConfigSetting,
    app: App,
    parentSubmenu: SettingsSubmenuId | null = null,
  ): void {
    try {
      const nextValue = nextSettingValue(getConfig(), setting);
      setConfigValue(setting.key, nextValue);
      invalidateSyntaxStyle();
      reopenSettingsAfterUpdate(setting.key, parentSubmenu);
      showToast(`${setting.title}: ${formatSettingValue(setting, nextValue)}`);
    } catch (err) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Failed to update setting: ${err}`,
        variant: "error",
      });
    }
  }

  function updateInteractiveAcpConfigOption(option: SessionConfigOptionState, app: App, value?: string): void {
    const nextValue = value ?? nextAcpConfigOptionValue(option);
    updateAcpConfigOption(option, nextValue, app)
      .then(() => {
        openSettingsOverlay({ acpConfigOptionId: option.id });
        showToast(`${formatAcpConfigOptionTitle(option)}: ${formatAcpConfigOptionValue(option, nextValue)}`);
      })
      .catch((err) => {
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: `Failed to update setting: ${err}`,
          variant: "error",
        });
      });
  }

  function updateInteractivePluginSetting(item: Extract<SettingsItem, { type: "plugin-setting" }>, app: App): void {
    try {
      const nextValue = nextPluginSettingValue(item.currentValue, item.definition);
      setPluginSettingValue(item.plugin.id, item.plugin.name, item.key, nextValue);
      openSettingsOverlay({ type: "plugin-setting", pluginId: item.plugin.id, key: item.key });
      showToast(
        `${item.plugin.name}: ${item.definition.title}: ${formatPluginSettingValue(item.definition, nextValue)}`,
      );
    } catch (err) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Failed to update setting: ${err}`,
        variant: "error",
      });
    }
  }

  function updateInteractivePlugin(item: PluginSettingsItem, app: App): void {
    try {
      const stayInDetails = selectionMode() === SelectionMode.PLUGIN_DETAILS;
      if (item.type === "system") {
        const enabled = !item.enabled;
        setPluginsEnabled(enabled);
        if (stayInDetails) openPluginDetailsOverlay();
        else openPluginsOverlay();
        showToast(`Plugins: ${enabled ? "on" : "off"}`);
        return;
      }

      const enabled = !item.enabled;
      if (enabled && item.disabledByGlobal) setPluginsEnabled(true);
      setRelayPluginEnabled(item.id, enabled);
      if (stayInDetails) openPluginDetailsOverlay(item.id);
      else openPluginsOverlay(item.id);
      showToast(`${item.name}: ${enabled ? "on" : "off"}`);
    } catch (err) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Failed to update plugin: ${err}`,
        variant: "error",
      });
    }
  }

  function refreshSettingsOverlay(): void {
    if (!settingsOverlayActive()) return;
    const activeValueSetting = getActiveSettingsValueSetting();
    if (activeValueSetting && selectionMode() === SelectionMode.SETTING_VALUE) {
      const setting = activeValueSetting;
      const choices = SETTING_VALUE_CHOICES[setting.key];
      if (!choices) return;
      const selectedValue = overlayItems()[overlayIndex()]?.value as boolean | number | string | undefined;
      const current = getConfigValue(getConfig(), setting.key);
      const items: ListItem<boolean | number | string>[] = choices.map((choice) => ({
        value: choice.value,
        label: formatSettingValue(setting, choice.value),
        description: choice.description ?? "",
        active: current === choice.value,
      }));
      setSelectionAllItems(items);
      setOverlayItems(items);
      const selectedIndex = selectedValue !== undefined ? items.findIndex((item) => item.value === selectedValue) : -1;
      setOverlayIndex(selectedIndex >= 0 ? selectedIndex : Math.min(overlayIndex(), items.length - 1));
      return;
    }

    if (selectionMode() === SelectionMode.ACP_CONFIG_VALUE) {
      const selectedValueItem = overlayItems()[overlayIndex()]?.value as AcpConfigOptionValueItem | undefined;
      const selectedOptionId = selectedValueItem?.option.id;
      if (!selectedOptionId) return;
      const option = acpConfigOptions().find((candidate) => candidate.id === selectedOptionId);
      if (!option) return;
      const items = buildAcpConfigOptionValueItems(option);
      setSelectionAllItems(items);
      setOverlayItems(items);
      const selectedIndex = items.findIndex((item) => item.value.value === selectedValueItem.value);
      setOverlayIndex(selectedIndex >= 0 ? selectedIndex : Math.min(overlayIndex(), items.length - 1));
      return;
    }

    if (getActiveSettingsSubmenu() === "themes" && selectionMode() === SelectionMode.THEME) {
      const selectedTheme = overlayItems()[overlayIndex()]?.value as string | undefined;
      const current = getConfig().ui.theme;
      const items = buildThemeItems(current);
      setSelectionAllItems(items);
      setOverlayItems(items);
      const selectedIndex = selectedTheme ? items.findIndex((item) => item.value === selectedTheme) : -1;
      setOverlayIndex(selectedIndex >= 0 ? selectedIndex : Math.min(overlayIndex(), items.length - 1));
      return;
    }

    const selected = overlayItems()[overlayIndex()]?.value as SettingsItem | undefined;
    const items =
      getActiveSettingsSubmenu() === "notifications"
        ? buildNotificationSettingsItems(getConfig())
        : buildSettingsItems(getConfig(), pluginSettingEntries(), {
            acpConfigOptions: acpConfigOptions(),
          });
    setSelectionAllItems(items);
    setOverlayItems(items);
    if (selected) {
      const index = items.findIndex((item) => {
        if (selected.type === "submenu") return item.value.type === "submenu" && item.value.id === selected.id;
        if (selected.type === "plugin-setting") {
          return (
            item.value.type === "plugin-setting" &&
            item.value.plugin.id === selected.plugin.id &&
            item.value.key === selected.key
          );
        }
        if (selected.type === "acp-config-option") {
          return item.value.type === "acp-config-option" && item.value.option.id === selected.option.id;
        }
        return item.value.type === "setting" && item.value.setting.key === selected.setting.key;
      });
      if (index >= 0) setOverlayIndex(index);
    }
  }

  return {
    openThemeOverlay,
    openNotificationSettingsOverlay,
    openSettingsSubmenu,
    reopenSettingsAfterUpdate,
    openSettingValueOverlay,
    openAcpConfigOptionValueOverlay,
    pluginSettingEntries,
    openSettingsOverlay,
    openPluginsOverlay,
    openPluginDetailsOverlay,
    refreshPluginsOverlay,
    updateInteractiveSetting,
    updateInteractiveAcpConfigOption,
    updateInteractivePluginSetting,
    updateInteractivePlugin,
    refreshSettingsOverlay,
  };
}
