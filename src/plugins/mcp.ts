import type { Disposable, RelayMcpServerConfig, RelayMcpStatus, RelayPluginInfo } from "./types";

export interface RelayMcpServerEntry {
  readonly plugin: RelayPluginInfo;
  readonly server: RelayMcpServerConfig;
}

export class RelayPluginMcpRegistry {
  private readonly servers = new Map<string, RelayMcpServerEntry>();
  private activeSnapshot: readonly RelayMcpServerConfig[] | null = null;

  addServer(plugin: RelayPluginInfo, server: RelayMcpServerConfig): Disposable {
    const key = serverKey(plugin.id, server.name);
    this.servers.set(key, { plugin, server: cloneServer(server) });
    return { dispose: () => this.servers.delete(key) };
  }

  removeServer(plugin: RelayPluginInfo, name: string): boolean {
    return this.servers.delete(serverKey(plugin.id, name));
  }

  listServers(): readonly RelayMcpServerConfig[] {
    return [...this.servers.values()].map((entry) => cloneServer(entry.server));
  }

  listServerEntries(): readonly RelayMcpServerEntry[] {
    return [...this.servers.values()].map((entry) => ({ plugin: entry.plugin, server: cloneServer(entry.server) }));
  }

  markApplied(servers: readonly RelayMcpServerConfig[] = this.listServers()): void {
    this.activeSnapshot = servers.map(cloneServer);
  }

  clearApplied(): void {
    this.activeSnapshot = null;
  }

  status(): RelayMcpStatus {
    const pendingServers = this.listServers();
    const activeServers = this.activeSnapshot?.map(cloneServer) ?? [];
    return {
      restartNeeded: this.activeSnapshot !== null && !sameServerList(activeServers, pendingServers),
      applied: this.activeSnapshot !== null,
      activeServers,
      pendingServers,
    };
  }

  clearPlugin(pluginId: string): void {
    for (const key of [...this.servers.keys()]) if (key.startsWith(`${pluginId}:`)) this.servers.delete(key);
  }

  clear(): void {
    this.servers.clear();
    this.activeSnapshot = null;
  }
}

function serverKey(pluginId: string, serverName: string): string {
  return `${pluginId}:${serverName}`;
}

function cloneServer(server: RelayMcpServerConfig): RelayMcpServerConfig {
  return {
    name: server.name,
    command: server.command,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
  };
}

function normalizedServer(server: RelayMcpServerConfig): string {
  return JSON.stringify({
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: Object.fromEntries(Object.entries(server.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right))),
  });
}

function sameServerList(left: readonly RelayMcpServerConfig[], right: readonly RelayMcpServerConfig[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = left.map(normalizedServer).toSorted();
  const normalizedRight = right.map(normalizedServer).toSorted();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
