import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { IS_ATLAS_PLUGIN_INSTALL, VERSION } from "../version";

export interface VersionUpdateInfo {
  version: string;
  currentVersion: string;
  updateCommand: string;
}

interface VersionUpdateCache {
  latestVersion: string;
  lastCheckedAt: string;
  installedVersion?: string;
  source?: string;
  postponedUntil?: string;
  postponedVersion?: string;
}

export interface VersionCheckOptions {
  cacheDir?: string;
  currentVersion?: string;
  now?: () => Date;
  runAtlasCommand?: (args: string[]) => Promise<string | null>;
  fetchManifest?: () => Promise<string | null>;
}

const UPDATE_COMMAND_ARGS = ["atlas", "plugin", "upgrade", "-n", "relay", "-c", "stable"] as const;
const UPDATE_COMMAND = UPDATE_COMMAND_ARGS.join(" ");
const CHECK_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const UPDATE_FAILURE_POSTPONE_MS = 6 * 60 * 60 * 1_000;
const CACHE_FILENAME = "version-update.json";
const CACHE_SOURCE = "statlas-manifest-stable";
const RELAY_PLUGIN_MANIFEST_URL = "https://statlas.prod.atl-paas.net/atlas-cli-plugin-relay/manifest.toml";

function parseVersionParts(version: string): number[] | null {
  const [core] = version.replace(/^v/, "").split(/[+-]/, 1);
  if (!core) return null;
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

export function compareVersions(left: string, right: string): number | null {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

const MANIFEST_VERSION_PATTERN = /^\s*version\s*=\s*"([^"]+)"/m;
const MANIFEST_CHANNELS_PATTERN = /^\s*channels\s*=\s*\[([^\]]*)\]/m;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(output: string): string {
  return output.replace(ANSI_ESCAPE_PATTERN, "");
}

function latestStableVersionFromManifest(manifest: string): string | null {
  let latest: string | null = null;
  for (const block of manifest.split("[[release]]").slice(1)) {
    const version = block.match(MANIFEST_VERSION_PATTERN)?.[1];
    const channels = block.match(MANIFEST_CHANNELS_PATTERN)?.[1] ?? "";
    if (!version || !channels.includes('"stable"')) continue;
    if (!latest || (compareVersions(version, latest) ?? 0) > 0) latest = version;
  }
  return latest;
}

function installedVersionFromOutput(output: string): string | null {
  const match = stripAnsi(output).match(/^\s*relay\s+(\S+)/m);
  return match?.[1] ?? null;
}

async function readProcessText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

function atlasChildEnv(): Record<string, string | undefined> {
  return { ...process.env, ATLAS_LOG_OUTPUT: undefined };
}

// Only Atlas-managed installs are upgraded by `atlas plugin upgrade`, so they are
// the only ones whose updates come from the Atlas plugin manifest. Every other
// install (GitHub Releases, Homebrew, a source checkout) updates through its own
// channel and must not reach the Atlas manifest host or spawn `atlas`.

/** Atlas-only manifest fetch; resolves to null on every other install kind. */
async function fetchManifestForInstall(): Promise<string | null> {
  if (!IS_ATLAS_PLUGIN_INSTALL) return null;
  return await fetchRelayManifest();
}

/** Atlas-only CLI call; resolves to null on every other install kind. */
async function runAtlasForInstall(args: string[]): Promise<string | null> {
  if (!IS_ATLAS_PLUGIN_INSTALL) return null;
  return await runAtlas(args);
}

async function runAtlas(args: string[]): Promise<string | null> {
  let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    process = Bun.spawn(["atlas", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: atlasChildEnv(),
    });
  } catch {
    return null;
  }

  const timeout = setTimeout(() => process.kill(), CHECK_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const [stdout, stderr] = await Promise.all([readProcessText(process.stdout), readProcessText(process.stderr)]);
    await process.exited.catch(() => undefined);
    return `${stdout}\n${stderr}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultCacheDir(): string {
  const envCacheDir = process.env.RELAY_CACHE_DIR?.trim();
  if (envCacheDir) return envCacheDir;
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome && path.isAbsolute(xdgConfigHome)) return path.join(xdgConfigHome, "relay", "cache");
  return path.join(homedir(), ".config", "relay", "cache");
}

export function versionUpdateCachePath(cacheDir = defaultCacheDir()): string {
  return path.join(cacheDir, CACHE_FILENAME);
}

export async function clearRelayVersionUpdateCache(cacheDir?: string): Promise<void> {
  await rm(versionUpdateCachePath(cacheDir), { force: true });
}

async function readVersionUpdateCache(cacheDir?: string): Promise<VersionUpdateCache | null> {
  try {
    const content = await readFile(versionUpdateCachePath(cacheDir), "utf8");
    const parsed = JSON.parse(content) as Partial<VersionUpdateCache>;
    if (typeof parsed.latestVersion !== "string" || typeof parsed.lastCheckedAt !== "string") return null;
    return {
      latestVersion: parsed.latestVersion,
      lastCheckedAt: parsed.lastCheckedAt,
      ...(typeof parsed.installedVersion === "string" ? { installedVersion: parsed.installedVersion } : {}),
      ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
      ...(typeof parsed.postponedUntil === "string" ? { postponedUntil: parsed.postponedUntil } : {}),
      ...(typeof parsed.postponedVersion === "string" ? { postponedVersion: parsed.postponedVersion } : {}),
    };
  } catch {
    return null;
  }
}

async function writeVersionUpdateCache(cache: VersionUpdateCache, cacheDir?: string): Promise<void> {
  const filePath = versionUpdateCachePath(cacheDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cache)}\n`, "utf8");
}

export async function postponeRelayVersionUpdate(
  update: VersionUpdateInfo,
  options: VersionCheckOptions = {},
): Promise<void> {
  const now = options.now?.() ?? new Date();
  await writeVersionUpdateCache(
    {
      latestVersion: update.version,
      lastCheckedAt: now.toISOString(),
      installedVersion: update.currentVersion,
      source: CACHE_SOURCE,
      postponedVersion: update.version,
      postponedUntil: new Date(now.getTime() + UPDATE_FAILURE_POSTPONE_MS).toISOString(),
    },
    options.cacheDir,
  );
}

function isCacheFresh(cache: VersionUpdateCache, now: Date): boolean {
  if (cache.source !== CACHE_SOURCE) return false;
  const checkedAt = Date.parse(cache.lastCheckedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return now.getTime() - checkedAt < CACHE_TTL_MS;
}

function isUpdatePostponed(cache: VersionUpdateCache, now: Date): boolean {
  if (cache.source !== CACHE_SOURCE) return false;
  if (cache.postponedVersion !== cache.latestVersion) return false;
  if (!cache.postponedUntil) return false;
  const postponedUntil = Date.parse(cache.postponedUntil);
  if (!Number.isFinite(postponedUntil)) return false;
  return now.getTime() < postponedUntil;
}

function updateInfoFromLatest(latestVersion: string, currentVersion: string | null): VersionUpdateInfo | null {
  if (!currentVersion || currentVersion === "dev") return null;
  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison === null || comparison <= 0) return null;
  return { version: latestVersion, currentVersion, updateCommand: UPDATE_COMMAND };
}

async function fetchRelayManifest(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(RELAY_PLUGIN_MANIFEST_URL, {
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLatestRelayVersion(fetchManifest: () => Promise<string | null>): Promise<string | null> {
  const manifest = await fetchManifest();
  if (!manifest) return null;
  return latestStableVersionFromManifest(manifest);
}

async function fetchInstalledRelayVersion(
  runAtlasCommand: (args: string[]) => Promise<string | null>,
): Promise<string | null> {
  const installedOutput = await runAtlasCommand(["plugin", "installed"]);
  if (!installedOutput) return null;
  return installedVersionFromOutput(installedOutput);
}

export async function getInstalledRelayVersion(options: VersionCheckOptions = {}): Promise<string | null> {
  return await fetchInstalledRelayVersion(options.runAtlasCommand ?? runAtlasForInstall);
}

function currentRelayVersionFromCache(options: VersionCheckOptions, cache: VersionUpdateCache | null): string | null {
  if (options.currentVersion !== undefined) return options.currentVersion === "dev" ? null : options.currentVersion;
  if (VERSION !== "dev") return VERSION;
  return cache?.installedVersion ?? null;
}

async function resolveCurrentRelayVersion(
  options: VersionCheckOptions,
  cache: VersionUpdateCache | null = null,
): Promise<string | null> {
  const cachedVersion = currentRelayVersionFromCache(options, cache);
  if (cachedVersion) return cachedVersion;
  return await fetchInstalledRelayVersion(options.runAtlasCommand ?? runAtlasForInstall);
}

export async function refreshRelayVersionUpdateCache(
  options: VersionCheckOptions = {},
): Promise<VersionUpdateInfo | null> {
  const runAtlasCommand = options.runAtlasCommand ?? runAtlasForInstall;
  const fetchManifest = options.fetchManifest ?? fetchManifestForInstall;
  const [currentVersion, latestVersion] = await Promise.all([
    resolveCurrentRelayVersion({ ...options, runAtlasCommand }),
    fetchLatestRelayVersion(fetchManifest),
  ]);
  if (!latestVersion) return null;

  await writeVersionUpdateCache(
    {
      latestVersion,
      lastCheckedAt: (options.now?.() ?? new Date()).toISOString(),
      source: CACHE_SOURCE,
      ...(currentVersion ? { installedVersion: currentVersion } : {}),
    },
    options.cacheDir,
  );
  return updateInfoFromLatest(latestVersion, currentVersion);
}

export async function getCachedRelayVersionUpdate(
  options: VersionCheckOptions = {},
): Promise<VersionUpdateInfo | null> {
  const now = options.now?.() ?? new Date();
  const cache = await readVersionUpdateCache(options.cacheDir);
  if (!cache || !isCacheFresh(cache, now) || isUpdatePostponed(cache, now)) return null;
  const currentVersion = await resolveCurrentRelayVersion(options, cache);
  return updateInfoFromLatest(cache.latestVersion, currentVersion);
}

export async function checkRelayVersionUpdate(options: VersionCheckOptions = {}): Promise<VersionUpdateInfo | null> {
  const now = options.now?.() ?? new Date();
  const cache = await readVersionUpdateCache(options.cacheDir);
  if (cache && isCacheFresh(cache, now)) {
    if (isUpdatePostponed(cache, now)) return null;
    const currentVersion = await resolveCurrentRelayVersion(options, cache);
    return updateInfoFromLatest(cache.latestVersion, currentVersion);
  }

  const refreshedUpdate = await refreshRelayVersionUpdateCache({ ...options, now: () => now });
  if (refreshedUpdate) return refreshedUpdate;
  if (!cache || cache.source !== CACHE_SOURCE) return null;
  const currentVersion = await resolveCurrentRelayVersion(options, cache);
  return updateInfoFromLatest(cache.latestVersion, currentVersion);
}

export async function runRelayVersionUpdate(): Promise<number> {
  const process = Bun.spawn([...UPDATE_COMMAND_ARGS], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: atlasChildEnv(),
  });
  return await process.exited;
}

function relayShimName(): string {
  const configuredShim = process.env.RELAY_ATLAS_PLUGIN_SHIM?.trim();
  if (configuredShim) return configuredShim;
  return process.platform === "win32" ? "relay.exe" : "relay";
}

export async function relaunchRelay(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const process = Bun.spawn([relayShimName(), ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await process.exited;
}
