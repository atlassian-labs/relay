import type {
  Disposable,
  RelayAutocompleteProvider,
  RelayEditorOptions,
  RelayEditorTheme,
  RelayPluginInfo,
} from "./types";

export interface RegisteredRelayAutocompleteProvider {
  readonly plugin: RelayPluginInfo;
  readonly provider: RelayAutocompleteProvider;
}

export interface RelayPluginEditorState {
  readonly options: Partial<RelayEditorOptions>;
  readonly theme: Partial<RelayEditorTheme>;
  readonly autocompleteProviders: readonly RelayAutocompleteProvider[];
}

type MutableRelayEditorTheme = {
  -readonly [Key in keyof RelayEditorTheme]?: RelayEditorTheme[Key] | undefined;
};

function normalizeEditorTheme(theme: Partial<RelayEditorTheme>): Partial<RelayEditorTheme> {
  const input = theme as Record<string, unknown>;
  const normalized: MutableRelayEditorTheme = {};
  if ("borderColor" in input && (typeof input.borderColor === "string" || input.borderColor === undefined)) {
    normalized.borderColor = input.borderColor;
  }
  if ("textColor" in input && (typeof input.textColor === "string" || input.textColor === undefined)) {
    normalized.textColor = input.textColor;
  }
  if ("cursorColor" in input && (typeof input.cursorColor === "string" || input.cursorColor === undefined)) {
    normalized.cursorColor = input.cursorColor;
  }
  return normalized;
}

export class RelayPluginEditorRegistry {
  private readonly optionEntries = new Map<string, Partial<RelayEditorOptions>>();
  private readonly themeEntries = new Map<string, Partial<RelayEditorTheme>>();
  private readonly providers = new Map<string, RegisteredRelayAutocompleteProvider>();
  private order = 0;

  configure(plugin: RelayPluginInfo, options: Partial<RelayEditorOptions>): Disposable {
    const key = `${plugin.id}:options:${++this.order}`;
    this.optionEntries.set(key, options);
    return { dispose: () => this.optionEntries.delete(key) };
  }

  setTheme(plugin: RelayPluginInfo, theme: Partial<RelayEditorTheme>): Disposable {
    const key = `${plugin.id}:theme:${++this.order}`;
    this.themeEntries.set(key, normalizeEditorTheme(theme));
    return { dispose: () => this.themeEntries.delete(key) };
  }

  addAutocompleteProvider(plugin: RelayPluginInfo, provider: RelayAutocompleteProvider): Disposable {
    const key = `${plugin.id}:autocomplete:${++this.order}`;
    this.providers.set(key, { plugin, provider });
    return { dispose: () => this.providers.delete(key) };
  }

  listAutocompleteProviders(): readonly RegisteredRelayAutocompleteProvider[] {
    return [...this.providers.values()];
  }

  state(): RelayPluginEditorState {
    return {
      options: Object.assign({}, ...this.optionEntries.values()) as Partial<RelayEditorOptions>,
      theme: Object.assign({}, ...this.themeEntries.values()) as Partial<RelayEditorTheme>,
      autocompleteProviders: [...this.providers.values()].map((entry) => entry.provider),
    };
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.optionEntries.keys()])
      if (key.startsWith(`${pluginId}:`)) this.optionEntries.delete(key);
    for (const key of [...this.themeEntries.keys()]) if (key.startsWith(`${pluginId}:`)) this.themeEntries.delete(key);
    for (const key of [...this.providers.keys()]) if (key.startsWith(`${pluginId}:`)) this.providers.delete(key);
  }

  clear(): void {
    this.optionEntries.clear();
    this.themeEntries.clear();
    this.providers.clear();
  }
}
