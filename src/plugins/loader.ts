import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { createJiti } from "jiti/static";
import type { Config } from "../config";
import { getConfigDir } from "../config";
import { RelayError } from "../effect/errors";
import { existsSync, readFileSync, readdirSync, statSync, type Stats } from "../platform/fs";
import { BUNDLED_RELAY_PLUGINS } from "./bundled";
import type { LoadedRelayPlugin, RelayPluginFactory, RelayPluginInfo } from "./types";

export type RelayPluginSource = "bundled" | "global" | "workspace" | "config";

export interface RelayPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: RelayPluginSource;
  readonly description?: string;
  readonly author?: string;
}

export interface RelayPluginDiscoveryResult {
  readonly entries: RelayPluginEntry[];
  readonly warnings: string[];
}

export interface RelayPluginListEntry extends RelayPluginEntry {
  readonly enabled: boolean;
}

export interface RelayPluginListResult {
  readonly entries: RelayPluginListEntry[];
  readonly warnings: string[];
}

type RelayPackageConfig = {
  readonly plugin?: unknown;
  readonly plugins?: unknown;
  readonly description?: unknown;
  readonly author?: unknown;
};

const SUPPORTED_PLUGIN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
let pluginLoadGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pluginNameFromPath(filePath: string): string {
  const parsed = path.parse(filePath);
  return parsed.name === "index" ? path.basename(parsed.dir) : parsed.name;
}

function normalizeWorkspace(value: string): string {
  return path.resolve(value);
}

function resolveConfiguredPath(configuredPath: string, cwd: string): string {
  const expanded =
    configuredPath === "~" || configuredPath.startsWith("~/")
      ? path.join(os.homedir(), configuredPath.slice(2))
      : configuredPath;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

interface PackagePluginMetadata {
  readonly targets: string[];
  readonly description?: string;
  readonly author?: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function packagePluginMetadata(packageJsonPath: string): PackagePluginMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
  } catch {
    return { targets: [] };
  }
  if (!isRecord(parsed)) return { targets: [] };
  const relay = isRecord(parsed.relay) ? (parsed.relay as RelayPackageConfig) : undefined;
  const plugin = relay?.plugin ?? parsed["relay.plugin"];
  const plugins = relay?.plugins ?? parsed["relay.plugins"];
  const targets = [
    ...(typeof plugin === "string" ? [plugin] : []),
    ...(Array.isArray(plugins) ? plugins.filter((item): item is string => typeof item === "string") : []),
  ];
  const description = stringField(relay?.description ?? parsed.description);
  const authorValue = relay?.author ?? parsed.author;
  const author = stringField(isRecord(authorValue) ? authorValue.name : authorValue);
  return { targets, description, author };
}

function entryForFile(filePath: string, source: RelayPluginSource): RelayPluginEntry | null {
  if (!SUPPORTED_PLUGIN_EXTENSIONS.has(path.extname(filePath))) return null;
  const resolved = path.resolve(filePath);
  const name = pluginNameFromPath(resolved);
  return { id: `${source}:${resolved}`, name, path: resolved, source };
}

function entriesForDirectory(dirPath: string, source: RelayPluginSource): RelayPluginEntry[] {
  const packageJsonPath = path.join(dirPath, "package.json");
  if (existsSync(packageJsonPath)) {
    const metadata = packagePluginMetadata(packageJsonPath);
    if (metadata.targets.length > 0) {
      return metadata.targets
        .map((target, index) => {
          const filePath = path.resolve(dirPath, target);
          const entry = entryForFile(filePath, source);
          return entry
            ? {
                ...entry,
                id: `${source}:${dirPath}:${index}`,
                name: pluginNameFromPath(filePath),
                ...(metadata.description ? { description: metadata.description } : {}),
                ...(metadata.author ? { author: metadata.author } : {}),
              }
            : null;
        })
        .filter((entry): entry is RelayPluginEntry => entry !== null);
    }
  }

  for (const filename of ["index.ts", "index.tsx", "index.js", "index.mjs"]) {
    const filePath = path.join(dirPath, filename);
    if (existsSync(filePath)) {
      const entry = entryForFile(filePath, source);
      return entry ? [entry] : [];
    }
  }

  return [];
}

function entriesForPath(pluginPath: string, source: RelayPluginSource): RelayPluginEntry[] {
  let stat: Stats;
  try {
    stat = statSync(pluginPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    const entry = entryForFile(pluginPath, source);
    return entry ? [entry] : [];
  }
  if (stat.isDirectory()) return entriesForDirectory(pluginPath, source);
  return [];
}

function entriesInPluginRoot(rootPath: string, source: RelayPluginSource): RelayPluginEntry[] {
  let children: Array<{ readonly name: string }>;
  try {
    children = readdirSync(rootPath, { withFileTypes: true, encoding: "utf-8" }) as Array<{ readonly name: string }>;
  } catch {
    return [];
  }
  return children
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => entriesForPath(path.join(rootPath, entry.name), source));
}

function bundledEntries(): RelayPluginEntry[] {
  return BUNDLED_RELAY_PLUGINS.map((plugin) => ({
    id: `bundled:${plugin.id}`,
    name: plugin.name,
    path: path.join("bundled", plugin.id, plugin.script),
    source: "bundled",
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.author ? { author: plugin.author } : {}),
  }));
}

function isWorkspaceTrusted(cwd: string, trustedWorkspaces: readonly string[]): boolean {
  const normalizedCwd = normalizeWorkspace(cwd);
  return trustedWorkspaces.some((workspace) => normalizeWorkspace(workspace) === normalizedCwd);
}

export function discoverRelayPlugins(options: {
  readonly cwd: string;
  readonly config: Config;
}): RelayPluginDiscoveryResult {
  if (!options.config.plugins.enabled) return { entries: [], warnings: [] };
  const result = listRelayPlugins(options);
  return { entries: result.entries.filter((entry) => entry.enabled), warnings: result.warnings };
}

export function listRelayPlugins(options: { readonly cwd: string; readonly config: Config }): RelayPluginListResult {
  const warnings: string[] = [];
  const config = options.config.plugins;

  const entries: RelayPluginEntry[] = [];
  entries.push(...bundledEntries());
  entries.push(...entriesInPluginRoot(path.join(getConfigDir(), "plugins"), "global"));
  for (const configuredPath of config.paths) {
    entries.push(...entriesForPath(resolveConfiguredPath(configuredPath, options.cwd), "config"));
  }

  const workspacePluginRoot = path.join(options.cwd, ".relay", "plugins");
  if (existsSync(workspacePluginRoot)) {
    if (config.allow_project_plugins || isWorkspaceTrusted(options.cwd, config.trusted_workspaces)) {
      entries.push(...entriesInPluginRoot(workspacePluginRoot, "workspace"));
    } else {
      warnings.push(`Workspace plugins found at ${workspacePluginRoot}, but project plugins are not enabled.`);
    }
  }

  const disabled = new Set(config.disabled);
  return {
    entries: entries.map((entry) => ({
      ...entry,
      enabled: config.enabled && !disabled.has(entry.id),
    })),
    warnings,
  };
}

async function loadRelayPluginInternal(entry: RelayPluginEntry): Promise<LoadedRelayPlugin> {
  if (entry.source === "bundled") {
    const bundled = BUNDLED_RELAY_PLUGINS.find((plugin) => `bundled:${plugin.id}` === entry.id);
    if (!bundled) throw new Error(`Unknown bundled Relay plugin ${entry.id}`); // effect-shape-allow: plugin loader validates internal bundled plugin registry.
    const info: RelayPluginInfo = {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.author ? { author: entry.author } : {}),
    };
    return { info, factory: bundled.factory };
  }

  // Bundle the local source graph for every load. The generated module gets a
  // unique id while package imports stay external and resolve from the plugin's
  // directory. This avoids Bun's non-evictable native ESM cache for both the
  // entrypoint and its transitive source files.
  const generation = ++pluginLoadGeneration;
  const build = await Bun.build({
    entrypoints: [entry.path],
    format: "esm",
    packages: "external",
    plugins: [
      {
        name: `relay-plugin-fresh-source-${generation}`,
        setup(builder) {
          builder.onLoad({ filter: /\.(?:js|mjs|ts|tsx)$/u }, (args) => {
            const extension = path.extname(args.path);
            const loader = extension === ".ts" ? "ts" : extension === ".tsx" ? "tsx" : "js";
            return { contents: readFileSync(args.path, "utf-8"), loader };
          });
        },
      },
    ],
    sourcemap: "inline",
    target: "bun",
  });
  if (!build.success || build.outputs.length === 0) {
    throw new Error(build.logs.map((log) => log.message).join("\n") || `Failed to build Relay plugin ${entry.path}`); // effect-shape-allow: plugin loader reports compiler diagnostics.
  }
  const source = await build.outputs[0]!.text();
  const jiti = createJiti(entry.path, { fsCache: false, moduleCache: false, tryNative: false });
  const moduleNamespace = (await jiti.evalModule(source, {
    async: true,
    filename: `${entry.path}.relay-${generation}.mjs`,
    id: `${entry.path}.relay-${generation}.mjs`,
  })) as Record<string, unknown>;
  const moduleFactory = moduleNamespace.default ?? moduleNamespace;
  if (typeof moduleFactory !== "function") {
    throw new Error(`Relay plugin ${entry.path} must export a default function`); // effect-shape-allow: plugin loader validates external module shape.
  }
  const factory = moduleFactory as RelayPluginFactory;
  const info: RelayPluginInfo = {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.author ? { author: entry.author } : {}),
  };
  return { info, factory };
}

async function loadRelayPluginsInternal(entries: readonly RelayPluginEntry[]): Promise<{
  readonly plugins: LoadedRelayPlugin[];
  readonly diagnostics: Array<{ readonly entry: RelayPluginEntry; readonly message: string; readonly cause?: unknown }>;
}> {
  const plugins: LoadedRelayPlugin[] = [];
  const diagnostics: Array<{ readonly entry: RelayPluginEntry; readonly message: string; readonly cause?: unknown }> =
    [];
  for (const entry of entries) {
    try {
      plugins.push(await loadRelayPluginInternal(entry));
    } catch (error) {
      diagnostics.push({ entry, message: `Failed to load plugin ${entry.name}`, cause: error });
    }
  }
  return { plugins, diagnostics };
}

export function loadRelayPluginEffect(entry: RelayPluginEntry): Effect.Effect<LoadedRelayPlugin, RelayError> {
  return Effect.tryPromise({
    try: () => loadRelayPluginInternal(entry),
    catch: (cause) => new RelayError({ message: `Failed to load plugin ${entry.name}`, cause }),
  });
}

export function loadRelayPluginsEffect(entries: readonly RelayPluginEntry[]): Effect.Effect<
  {
    readonly plugins: LoadedRelayPlugin[];
    readonly diagnostics: Array<{
      readonly entry: RelayPluginEntry;
      readonly message: string;
      readonly cause?: unknown;
    }>;
  },
  RelayError
> {
  return Effect.tryPromise({
    try: () => loadRelayPluginsInternal(entries),
    catch: (cause) => new RelayError({ message: "Failed to load plugins", cause }),
  });
}
