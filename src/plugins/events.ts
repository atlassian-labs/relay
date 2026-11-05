import type { Disposable, RelayEventHandler, RelayPluginEvent } from "./types";

type HandlerEntry = {
  readonly pluginId: string;
  readonly handler: RelayEventHandler<RelayPluginEvent["type"]>;
};

export class RelayPluginEventBus {
  private readonly handlers = new Map<RelayPluginEvent["type"], HandlerEntry[]>();

  on<E extends RelayPluginEvent["type"]>(pluginId: string, type: E, handler: RelayEventHandler<E>): Disposable {
    const entries = this.handlers.get(type) ?? [];
    const entry: HandlerEntry = {
      pluginId,
      handler: handler as unknown as RelayEventHandler<RelayPluginEvent["type"]>,
    };
    entries.push(entry);
    this.handlers.set(type, entries);
    return {
      dispose: () => {
        const current = this.handlers.get(type);
        if (!current) return;
        const next = current.filter((item) => item !== entry);
        if (next.length === 0) this.handlers.delete(type);
        else this.handlers.set(type, next);
      },
    };
  }

  entries(type: RelayPluginEvent["type"]): readonly HandlerEntry[] {
    return this.handlers.get(type) ?? [];
  }

  hasAny(types: readonly RelayPluginEvent["type"][]): boolean {
    return types.some((type) => this.handlers.has(type));
  }

  clearPlugin(pluginId: string): void {
    for (const [type, entries] of this.handlers) {
      const next = entries.filter((entry) => entry.pluginId !== pluginId);
      if (next.length === 0) this.handlers.delete(type);
      else this.handlers.set(type, next);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
