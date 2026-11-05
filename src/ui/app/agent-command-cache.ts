import { createHash } from "node:crypto";
import * as path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "../../platform/fs";
import type { SlashCommand } from "../autocomplete";
import { getCacheDir } from "../../config";

const CACHE_VERSION = 1;
const CACHE_FILE = "agent-slash-commands.json";
const MAX_COMMANDS = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type CacheEntry = {
  readonly version: number;
  readonly updatedAt: number;
  readonly commands: SlashCommand[];
};

type CacheFile = {
  readonly version: number;
  readonly entries: Record<string, CacheEntry>;
};

export type AgentCommandCacheInput = {
  readonly agentName: string;
  readonly profile: string;
  readonly transport?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly shell?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocols?: readonly string[];
  readonly framing?: string;
};

function cachePath(): string {
  return path.join(getCacheDir(), CACHE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCommand(value: unknown): SlashCommand | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return null;
  return {
    name: value.name.replace(/^\/+/, ""),
    description: typeof value.description === "string" ? value.description : "",
    origin: "agent",
    kind: "unknown",
    invocation: { syntax: "slash", composable: false },
    ...(Object.prototype.hasOwnProperty.call(value, "input") ? { input: value.input } : {}),
    ...(isRecord(value.meta) ? { meta: value.meta } : {}),
  };
}

function normalizeCommands(commands: unknown): SlashCommand[] {
  if (!Array.isArray(commands)) return [];
  const byName = new Map<string, SlashCommand>();
  for (const value of commands) {
    const command = normalizeCommand(value);
    if (!command) continue;
    const key = command.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, command);
    if (byName.size >= MAX_COMMANDS) break;
  }
  return [...byName.values()];
}

function readCacheFile(): CacheFile {
  try {
    if (!existsSync(cachePath())) return { version: CACHE_VERSION, entries: {} };
    const parsed = JSON.parse(readFileSync(cachePath(), "utf-8"));
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.entries)) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return { version: CACHE_VERSION, entries: parsed.entries as Record<string, CacheEntry> };
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

function writeCacheFile(cache: CacheFile): void {
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true });
    const tempPath = `${cachePath()}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(cache)}\n`, "utf-8");
    renameSync(tempPath, cachePath());
  } catch {
    // Best-effort cache only.
  }
}

function stableStringRecord(record: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export function agentCommandCacheKey(input: AgentCommandCacheInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        agentName: input.agentName,
        profile: input.profile,
        transport: input.transport ?? "stdio",
        command: input.command ?? "",
        args: input.args ?? [],
        shell: input.shell ?? false,
        env: stableStringRecord(input.env),
        url: input.url ?? "",
        headers: stableStringRecord(input.headers),
        protocols: input.protocols ?? [],
        framing: input.framing ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export function readCachedAgentCommands(cacheKey: string | null): SlashCommand[] {
  if (!cacheKey) return [];
  const entry = readCacheFile().entries[cacheKey];
  if (
    !entry ||
    entry.version !== CACHE_VERSION ||
    !Number.isFinite(entry.updatedAt) ||
    !Array.isArray(entry.commands) ||
    Date.now() - entry.updatedAt > MAX_AGE_MS
  ) {
    return [];
  }
  return normalizeCommands(entry.commands);
}

export function writeCachedAgentCommands(cacheKey: string | null, commands: readonly SlashCommand[]): void {
  if (!cacheKey) return;
  const normalized = normalizeCommands(commands);
  const cache = readCacheFile();
  const entries = { ...cache.entries };
  if (normalized.length === 0) {
    delete entries[cacheKey];
  } else {
    entries[cacheKey] = {
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      commands: normalized,
    };
  }
  writeCacheFile({ version: CACHE_VERSION, entries });
}
