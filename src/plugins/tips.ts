import type { Disposable, RelayPluginInfo, RelayPluginTipOptions } from "./types";

export interface RegisteredRelayPluginTip {
  readonly plugin: RelayPluginInfo;
  readonly text: string;
  readonly options: RelayPluginTipOptions;
}

export class RelayPluginTipRegistry {
  private readonly tips = new Map<string, RegisteredRelayPluginTip>();
  private order = 0;

  register(plugin: RelayPluginInfo, text: string, options: RelayPluginTipOptions = {}): Disposable {
    const trimmed = text.trim();
    if (!trimmed) return { dispose: () => undefined };
    const key = `${plugin.id}:tip:${++this.order}`;
    this.tips.set(key, { plugin, text: trimmed, options });
    return { dispose: () => this.tips.delete(key) };
  }

  active(onPredicateError?: (plugin: RelayPluginInfo, error: unknown) => void): readonly RegisteredRelayPluginTip[] {
    const active: RegisteredRelayPluginTip[] = [];
    for (const tip of this.tips.values()) {
      try {
        if (tip.options.enabled?.() ?? true) active.push(tip);
      } catch (error) {
        onPredicateError?.(tip.plugin, error);
      }
    }
    return active;
  }

  list(): readonly RegisteredRelayPluginTip[] {
    return [...this.tips.values()];
  }

  clearPlugin(pluginId: string): void {
    for (const [key, tip] of this.tips) {
      if (tip.plugin.id === pluginId) this.tips.delete(key);
    }
  }

  clear(): void {
    this.tips.clear();
  }
}
