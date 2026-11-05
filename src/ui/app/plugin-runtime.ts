import type { AcpLaunchOptions } from "../../acp/client";
import { PluginRunner } from "../../plugins";
import type { RelayMcpServerConfig, RelayPluginEvent } from "../../plugins";
import { PLUGIN_BLOCK_EVENT_TYPES } from "./plugin-events";

let pluginRunner: PluginRunner | null = null;
let nativeEventHandler: ((event: RelayPluginEvent) => void) | null = null;
let appliedPluginMcpSnapshot: readonly RelayMcpServerConfig[] | null = null;

export function getPluginRunner(): PluginRunner | null {
  return pluginRunner;
}

export function setPluginRunner(runner: PluginRunner | null): void {
  pluginRunner = runner;
}

export function setNativeEventHandler(handler: ((event: RelayPluginEvent) => void) | null): void {
  nativeEventHandler = handler;
}

export function emitPluginEvent(event: RelayPluginEvent): void {
  nativeEventHandler?.(event);
  const runner = pluginRunner;
  if (!runner) return;
  void runner.emit(event);
}

/** True when a native handler or loaded plugin could observe block-transition events. */
export function hasPluginBlockEventListeners(): boolean {
  return nativeEventHandler !== null || (pluginRunner?.hasListeners(PLUGIN_BLOCK_EVENT_TYPES) ?? false);
}

export function activePluginMcpServers(): readonly RelayMcpServerConfig[] {
  return pluginRunner?.mcpServers() ?? [];
}

export function currentPluginMcpAppliedSnapshot(): readonly RelayMcpServerConfig[] | null {
  return appliedPluginMcpSnapshot;
}

export function resetPluginMcpAppliedSnapshot(): void {
  appliedPluginMcpSnapshot = null;
  pluginRunner?.mcp.clearApplied();
}

export function withPluginMcpServers<T extends AcpLaunchOptions>(
  opts: T,
): T & { readonly mcpServers: readonly RelayMcpServerConfig[] } {
  const mcpServers = activePluginMcpServers();
  pluginRunner?.mcp.markApplied(mcpServers);
  appliedPluginMcpSnapshot = mcpServers;
  return { ...opts, mcpServers };
}

export function disposePluginRunner(runner: PluginRunner): void {
  runner.dispose();
  if (pluginRunner === runner) pluginRunner = null;
}

export async function shutdownPluginRunner(runner: PluginRunner, reason: "quit" | "reload" | "error"): Promise<void> {
  try {
    await runner.emitLifecycleSequenceByPlugin([{ type: "ui:unmount" }, { type: "relay:shutdown", reason }]);
  } finally {
    disposePluginRunner(runner);
  }
}
