import type {
  Disposable,
  RelayMessageRenderer,
  RelayMessageRendererContext,
  RelayMessageRendererOutput,
  RelayPluginInfo,
  RelayToolDisplayPolicy,
  RelayToolRenderer,
  RelayToolRendererContext,
  RelayToolRendererOutput,
} from "./types";

export interface RelayToolPolicyEntry {
  readonly plugin: RelayPluginInfo;
  readonly toolName: string;
  readonly policy: RelayToolDisplayPolicy;
}

export interface RelayToolRendererEntry {
  readonly plugin: RelayPluginInfo;
  readonly renderer: RelayToolRenderer;
  readonly order: number;
}

export interface RelayMessageRendererEntry {
  readonly plugin: RelayPluginInfo;
  readonly renderer: RelayMessageRenderer;
  readonly order: number;
}

export class RelayPluginRendererRegistry {
  private readonly policies = new Map<string, RelayToolPolicyEntry>();
  private readonly renderers = new Map<string, RelayToolRendererEntry>();
  private readonly messageRenderers = new Map<string, RelayMessageRendererEntry>();
  private order = 0;

  setDisplayPolicy(plugin: RelayPluginInfo, toolName: string, policy: RelayToolDisplayPolicy | undefined): Disposable {
    const key = `${plugin.id}:${toolName}`;
    if (policy === undefined) this.policies.delete(key);
    else this.policies.set(key, { plugin, toolName, policy });
    return { dispose: () => this.policies.delete(key) };
  }

  registerRenderer(plugin: RelayPluginInfo, renderer: RelayToolRenderer): Disposable {
    const key = `${plugin.id}:renderer:${++this.order}`;
    this.renderers.set(key, { plugin, renderer, order: this.order });
    return { dispose: () => this.renderers.delete(key) };
  }

  registerMessageRenderer(plugin: RelayPluginInfo, renderer: RelayMessageRenderer): Disposable {
    const key = `${plugin.id}:message-renderer:${++this.order}`;
    this.messageRenderers.set(key, { plugin, renderer, order: this.order });
    return { dispose: () => this.messageRenderers.delete(key) };
  }

  policyFor(toolName: string): RelayToolDisplayPolicy | undefined {
    const entries = [...this.policies.values()].filter((entry) => entry.toolName === toolName);
    return entries.at(-1)?.policy;
  }

  render(ctx: RelayToolRendererContext): RelayToolRendererOutput | null {
    for (const entry of [...this.renderers.values()].toSorted((a, b) => a.order - b.order)) {
      const names = entry.renderer.toolNames;
      if (names && !names.includes(ctx.toolName)) continue;
      const call = entry.renderer.renderCall?.(ctx) ?? undefined;
      const result = entry.renderer.renderResult?.(ctx) ?? undefined;
      if (call || result)
        return {
          ...(call ? { call } : {}),
          ...(result ? { result } : {}),
          ...(entry.renderer.canToggle !== undefined ? { canToggle: entry.renderer.canToggle } : {}),
        };
    }
    return null;
  }

  hasMessageRenderer(blockType: string): boolean {
    return [...this.messageRenderers.values()].some((entry) => {
      const blockTypes = entry.renderer.blockTypes;
      return !blockTypes || blockTypes.includes(blockType);
    });
  }

  renderMessage(ctx: RelayMessageRendererContext): RelayMessageRendererOutput | null {
    for (const entry of [...this.messageRenderers.values()].toSorted((a, b) => a.order - b.order)) {
      const blockTypes = entry.renderer.blockTypes;
      if (blockTypes && !blockTypes.includes(ctx.blockType)) continue;
      const output = entry.renderer.render(ctx);
      if (output) return output;
    }
    return null;
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.policies.keys()]) if (key.startsWith(`${pluginId}:`)) this.policies.delete(key);
    for (const key of [...this.renderers.keys()]) if (key.startsWith(`${pluginId}:`)) this.renderers.delete(key);
    for (const key of [...this.messageRenderers.keys()])
      if (key.startsWith(`${pluginId}:`)) this.messageRenderers.delete(key);
  }

  clear(): void {
    this.policies.clear();
    this.renderers.clear();
    this.messageRenderers.clear();
  }
}
