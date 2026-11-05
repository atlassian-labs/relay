import type { Disposable, RelayCommand, RelayCommandDiagnostic, RelayPluginInfo } from "./types";

export interface RegisteredRelayCommand {
  readonly plugin: RelayPluginInfo;
  readonly name: string;
  readonly invocationName: string;
  readonly command: RelayCommand;
  readonly diagnostics?: readonly RelayCommandDiagnostic[];
}

export interface RelayPluginCommandRegistryListOptions {
  readonly nativeCommandNames?: ReadonlySet<string>;
  readonly agentCommandNames?: ReadonlySet<string>;
}

interface StoredRelayCommand {
  readonly plugin: RelayPluginInfo;
  readonly name: string;
  readonly command: RelayCommand;
  readonly order: number;
}

export class RelayPluginCommandRegistry {
  private readonly commands = new Map<string, StoredRelayCommand>();
  private order = 0;

  register(plugin: RelayPluginInfo, name: string, command: RelayCommand): Disposable {
    const normalized = normalizePluginCommandName(name);
    const key = `${plugin.id}:${normalized}`;
    this.commands.set(key, { plugin, name: normalized, command, order: ++this.order });
    return { dispose: () => this.commands.delete(key) };
  }

  list(options: RelayPluginCommandRegistryListOptions = {}): readonly RegisteredRelayCommand[] {
    const entries = [...this.commands.values()].toSorted((a, b) => a.name.localeCompare(b.name) || a.order - b.order);
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);

    const positions = new Map<string, number>();
    return entries.map((entry) => {
      const position = (positions.get(entry.name) ?? 0) + 1;
      positions.set(entry.name, position);
      const duplicate = (counts.get(entry.name) ?? 0) > 1;
      const invocationName = duplicate ? `${entry.name}:${position}` : entry.name;
      const diagnostics = commandDiagnostics(entry.name, invocationName, duplicate, options);
      return {
        plugin: entry.plugin,
        name: entry.name,
        invocationName,
        command: entry.command,
        ...(diagnostics.length ? { diagnostics } : {}),
      };
    });
  }

  find(name: string): RegisteredRelayCommand | undefined {
    const normalized = normalizePluginCommandName(name);
    return this.list().find((entry) => entry.invocationName === normalized);
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.commands.keys()]) if (key.startsWith(`${pluginId}:`)) this.commands.delete(key);
  }

  clear(): void {
    this.commands.clear();
  }
}

export function normalizePluginCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function commandDiagnostics(
  name: string,
  invocationName: string,
  duplicate: boolean,
  options: RelayPluginCommandRegistryListOptions,
): RelayCommandDiagnostic[] {
  const diagnostics: RelayCommandDiagnostic[] = [];
  if (duplicate) {
    diagnostics.push({
      kind: "duplicate",
      message: `Duplicate plugin command "/${name}"; invoke this registration as "/${invocationName}".`,
    });
  }
  if (options.nativeCommandNames?.has(name)) {
    diagnostics.push({
      kind: "native-conflict",
      message: `Conflicts with native Relay command "/${name}".`,
    });
  }
  if (options.agentCommandNames?.has(name)) {
    diagnostics.push({
      kind: "agent-conflict",
      message: `Conflicts with ACP-advertised command "/${name}"; plugin commands run first.`,
    });
  }
  return diagnostics;
}
