import { getConfig } from "../../config";
import { runEffect } from "../../effect/runtime";
import { discoverRelayPlugins, loadRelayPluginsEffect, PluginRunner } from "../../plugins";
import type { LoadedRelayPlugin, RelayPluginInfo } from "../../plugins";
import type { RelayPluginEntry } from "../../plugins/loader";

export interface RelayPluginLoadDiagnostic {
  readonly entry: RelayPluginEntry;
  readonly message: string;
  readonly cause?: unknown;
}

export interface PreparedRelayPlugins {
  readonly plugins: readonly LoadedRelayPlugin[];
  readonly diagnostics: readonly RelayPluginLoadDiagnostic[];
}

function formatPluginCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function formatPluginLoadFailures(diagnostics: readonly RelayPluginLoadDiagnostic[]): string {
  const details = diagnostics.map((diagnostic) => {
    const cause = diagnostic.cause === undefined ? "" : `: ${formatPluginCause(diagnostic.cause)}`;
    return `${diagnostic.entry.name}${cause}`;
  });
  return `Plugin reload validation failed; keeping the previous runtime. ${details.join("; ")}`;
}

export async function prepareRelayPlugins(
  cwd: string,
  addConfigWarningBlock: (content: string) => void,
): Promise<PreparedRelayPlugins> {
  const discovery = discoverRelayPlugins({ cwd, config: getConfig() });
  for (const warning of discovery.warnings) addConfigWarningBlock(warning);
  return runEffect(loadRelayPluginsEffect(discovery.entries));
}

export async function registerPreparedRelayPlugins(
  runner: PluginRunner,
  prepared: PreparedRelayPlugins,
): Promise<boolean> {
  let successful = true;
  for (const diagnostic of prepared.diagnostics) {
    const plugin: RelayPluginInfo = {
      id: diagnostic.entry.id,
      name: diagnostic.entry.name,
      path: diagnostic.entry.path,
      ...(diagnostic.entry.description ? { description: diagnostic.entry.description } : {}),
      ...(diagnostic.entry.author ? { author: diagnostic.entry.author } : {}),
    };
    runner.recordError(plugin, diagnostic.message, diagnostic.cause);
  }

  for (const plugin of prepared.plugins) {
    if (!(await runner.register(plugin))) successful = false;
  }
  return successful && prepared.diagnostics.length === 0;
}

export async function startPreparedRelayPlugins(runner: PluginRunner, cwd: string): Promise<void> {
  await runner.emit({ type: "relay:start", cwd });
  await runner.emit({ type: "ui:mount" });
}

export async function activatePreparedRelayPlugins(
  runner: PluginRunner,
  cwd: string,
  prepared: PreparedRelayPlugins,
): Promise<void> {
  await registerPreparedRelayPlugins(runner, prepared);
  await startPreparedRelayPlugins(runner, cwd);
}

export async function initializeRelayPlugins(
  runner: PluginRunner,
  cwd: string,
  addConfigWarningBlock: (content: string) => void,
): Promise<void> {
  const prepared = await prepareRelayPlugins(cwd, addConfigWarningBlock);
  await activatePreparedRelayPlugins(runner, cwd, prepared);
}
