import * as crypto from "node:crypto";
import * as path from "node:path";
import { getConfigDir } from "../config";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "../platform/fs";
import { nowMs } from "../platform/time";
import type { RelayPluginInfo, RelayPluginJsonValue } from "./types";

export interface PersistentPluginStorageOptions {
  readonly plugin: RelayPluginInfo;
  readonly recordError: (message: string, cause?: unknown) => void;
}

type StorageDocument = Record<string, RelayPluginJsonValue>;

const STORAGE_FILE_NAME = "storage.json";
const BUNDLED_PLUGIN_ID_PREFIX = "bundled:";

export class PersistentPluginStorage {
  private loaded = false;
  private values: StorageDocument = {};

  constructor(private readonly options: PersistentPluginStorageOptions) {}

  get(key: string): RelayPluginJsonValue | undefined {
    this.ensureLoaded();
    return this.values[key];
  }

  set(key: string, value: RelayPluginJsonValue): void {
    this.ensureLoaded();
    if (!isRelayPluginJsonValue(value)) {
      this.options.recordError(`relay.storage.persisted.set("${key}") requires a JSON-serializable value`);
      return;
    }
    this.values[key] = value;
    this.flush();
  }

  delete(key: string): void {
    this.ensureLoaded();
    if (!(key in this.values)) return;
    delete this.values[key];
    this.flush();
  }

  clear(): void {
    this.ensureLoaded();
    if (Object.keys(this.values).length === 0) return;
    this.values = {};
    this.flush();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const storageFile = persistentPluginStorageFilePath(this.options.plugin);
    if (!existsSync(storageFile)) {
      this.values = {};
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(storageFile, "utf-8")) as unknown;
      const document = parseStorageDocument(parsed);
      if (!document) {
        this.values = {};
        this.options.recordError("Persisted plugin storage file must contain a JSON object");
        return;
      }
      this.values = document;
    } catch (error) {
      this.values = {};
      this.options.recordError("Failed to read persisted plugin storage", error);
    }
  }

  private flush(): void {
    const storageFile = persistentPluginStorageFilePath(this.options.plugin);
    const storageDir = path.dirname(storageFile);
    const tempFile = path.join(storageDir, `${STORAGE_FILE_NAME}.${process.pid}.${nowMs()}.tmp`);
    try {
      mkdirSync(storageDir, { recursive: true });
      writeFileSync(tempFile, `${JSON.stringify(this.values, null, 2)}\n`, "utf-8");
      renameSync(tempFile, storageFile);
    } catch (error) {
      try {
        rmSync(tempFile, { force: true });
      } catch {}
      this.options.recordError("Failed to write persisted plugin storage", error);
    }
  }
}

export function persistentPluginStorageFilePath(plugin: RelayPluginInfo): string {
  const bundledPluginId = bundledPluginStorageId(plugin);
  if (bundledPluginId) return path.join(getConfigDir(), "bundled", bundledPluginId, "data", STORAGE_FILE_NAME);
  return path.join(getConfigDir(), "plugin-data", safePersistentPluginStorageId(plugin), STORAGE_FILE_NAME);
}

function bundledPluginStorageId(plugin: RelayPluginInfo): string | null {
  if (!plugin.id.startsWith(BUNDLED_PLUGIN_ID_PREFIX)) return null;
  const id = plugin.id.slice(BUNDLED_PLUGIN_ID_PREFIX.length);
  return safePathSegment(id) || "plugin";
}

function safePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safePersistentPluginStorageId(plugin: RelayPluginInfo): string {
  const name = safePathSegment(plugin.name) || "plugin";
  const hash = crypto.createHash("sha256").update(plugin.id).digest("hex").slice(0, 12);
  return `${name}-${hash}`;
}

function parseStorageDocument(value: unknown): StorageDocument | null {
  if (!isRecord(value)) return null;
  const result: StorageDocument = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRelayPluginJsonValue(entry)) return null;
    result[key] = entry;
  }
  return result;
}

export function isRelayPluginJsonValue(value: unknown, seen: Set<object> = new Set()): value is RelayPluginJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (seen.has(value)) return false;
      seen.add(value);
      const valid = Array.isArray(value)
        ? value.every((entry) => isRelayPluginJsonValue(entry, seen))
        : isJsonObject(value) && Object.values(value).every((entry) => isRelayPluginJsonValue(entry, seen));
      seen.delete(value);
      return valid;
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
