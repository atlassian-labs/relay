import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkRelayVersionUpdate,
  clearRelayVersionUpdateCache,
  compareVersions,
  getCachedRelayVersionUpdate,
  postponeRelayVersionUpdate,
  versionUpdateCachePath,
} from "../../src/platform/version-check";

function tempCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), "relay-version-cache-"));
}

function writeCache(
  cacheDir: string,
  latestVersion: string,
  lastCheckedAt: string,
  installedVersion?: string,
  source = "statlas-manifest-stable",
): void {
  writeFileSync(
    versionUpdateCachePath(cacheDir),
    `${JSON.stringify({ latestVersion, lastCheckedAt, source, ...(installedVersion ? { installedVersion } : {}) })}\n`,
    "utf8",
  );
}

function manifestRelease(version: string, channels: string[]): string {
  return `[[release]]\n  version = "${version}"\n  timestamp = 2026-07-06T00:00:00.000000000Z\n  variants = ["darwin-arm64"]\n  channels = [${channels.map((channel) => `"${channel}"`).join(", ")}]`;
}

function atlasInstalled(version: string): string {
  return `  relay        ${version}      ACP-first terminal UI for         darwin-arm64`;
}

describe("version update cache", () => {
  test("compares atlas-style versions without build metadata", () => {
    expect(compareVersions("2026.28.1176+4d80caf", "2026.26.989+6cd3cd5")).toBe(1);
    expect(compareVersions("2026.28.1176+4d80caf", "2026.28.1176+different")).toBe(0);
    expect(compareVersions("dev", "2026.28.1176+4d80caf")).toBeNull();
  });

  test("returns cached update when cached latest is newer", async () => {
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, "2026.28.1176+4d80caf", "2026-07-06T00:00:00.000Z");

    await expect(
      getCachedRelayVersionUpdate({
        cacheDir,
        currentVersion: "2026.26.989+6cd3cd5",
        now: () => new Date("2026-07-06T01:00:00.000Z"),
      }),
    ).resolves.toEqual({
      version: "2026.28.1176+4d80caf",
      currentVersion: "2026.26.989+6cd3cd5",
      updateCommand: "atlas plugin upgrade -n relay -c stable",
    });
  });

  test("does not return cached update when current version is already current", async () => {
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, "2026.28.1176+4d80caf", "2026-07-06T00:00:00.000Z");

    await expect(
      getCachedRelayVersionUpdate({
        cacheDir,
        currentVersion: "2026.28.1176+4d80caf",
        now: () => new Date("2026-07-06T01:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  test("uses fresh manifest cache without fetching manifest", async () => {
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, "2026.28.1176+4d80caf", "2026-07-06T00:00:00.000Z");

    const update = await checkRelayVersionUpdate({
      cacheDir,
      currentVersion: "2026.26.989+6cd3cd5",
      now: () => new Date("2026-07-06T11:59:00.000Z"),
      runAtlasCommand: async () => {
        throw new Error("atlas should not be called when currentVersion is provided");
      },
      fetchManifest: async () => {
        throw new Error("manifest should not be fetched while cache is fresh");
      },
    });

    expect(update?.version).toBe("2026.28.1176+4d80caf");
  });

  // The current version comes from the build's pinned version, or from the
  // cache's installedVersion when the build has none. Either way, resolving it
  // must not spawn Atlas. The cached latest is far enough ahead to report an
  // update under both, so this holds for pinned and dev builds alike.
  test("resolves the current version without calling atlas", async () => {
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, "9999.99.9999+ffffff0", "2026-07-06T00:00:00.000Z", "2026.26.989+6cd3cd5");

    const update = await getCachedRelayVersionUpdate({
      cacheDir,
      now: () => new Date("2026-07-06T01:00:00.000Z"),
      runAtlasCommand: async () => {
        throw new Error("atlas should not be called");
      },
    });

    expect(update?.version).toBe("9999.99.9999+ffffff0");
  });

  test("refreshes fresh cache from older atlas info source", async () => {
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, "2026.28.1204+61c5aa4", "2026-07-08T05:14:44.816Z", "2026.28.1204+61c5aa4", "atlas-info");

    const update = await checkRelayVersionUpdate({
      cacheDir,
      currentVersion: "2026.28.1204+61c5aa4",
      now: () => new Date("2026-07-08T05:15:00.000Z"),
      runAtlasCommand: async () => {
        throw new Error("atlas should not be called when currentVersion is provided");
      },
      fetchManifest: async () => manifestRelease("2026.28.1237+b40f413", ["stable"]),
    });

    expect(update?.version).toBe("2026.28.1237+b40f413");
    const cache = readFileSync(versionUpdateCachePath(cacheDir), "utf8");
    expect(cache).toContain("statlas-manifest-stable");
    expect(cache).toContain("2026.28.1237+b40f413");
  });

  test("refreshes empty cache using atlas installed version and latest stable manifest version", async () => {
    const cacheDir = tempCacheDir();
    const calls: string[] = [];

    const update = await checkRelayVersionUpdate({
      cacheDir,
      // "dev" stands in for a build with no pinned version, which is the only
      // case that falls through to asking Atlas for the installed version.
      currentVersion: "dev",
      now: () => new Date("2026-07-06T12:01:00.000Z"),
      runAtlasCommand: async (args) => {
        calls.push(args.join(" "));
        if (args.join(" ") === "plugin installed") return atlasInstalled("2026.26.989+6cd3cd5");
        return null;
      },
      fetchManifest: async () =>
        [manifestRelease("2026.28.1176+4d80caf", ["stable"]), manifestRelease("2026.28.1200+abcdef0", ["beta"])].join(
          "\n\n",
        ),
    });

    expect(calls).toEqual(["plugin installed"]);
    expect(update?.version).toBe("2026.28.1176+4d80caf");
    const cache = readFileSync(versionUpdateCachePath(cacheDir), "utf8");
    expect(cache).toContain("2026.28.1176+4d80caf");
    expect(cache).toContain("2026.26.989+6cd3cd5");
  });

  test("refreshes stale cache and writes latest stable manifest version", async () => {
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, "2026.28.1176+4d80caf", "2026-07-06T00:00:00.000Z");

    const update = await checkRelayVersionUpdate({
      cacheDir,
      currentVersion: "2026.26.989+6cd3cd5",
      now: () => new Date("2026-07-06T12:01:00.000Z"),
      runAtlasCommand: async () => {
        throw new Error("atlas should not be called when currentVersion is provided");
      },
      fetchManifest: async () =>
        [manifestRelease("2026.29.1199+beta000", ["beta"]), manifestRelease("2026.29.1200+abcdef0", ["stable"])].join(
          "\n\n",
        ),
    });

    expect(update?.version).toBe("2026.29.1200+abcdef0");
    expect(readFileSync(versionUpdateCachePath(cacheDir), "utf8")).toContain("2026.29.1200+abcdef0");
  });

  test("postpones failed update prompts for six hours", async () => {
    const cacheDir = tempCacheDir();

    await postponeRelayVersionUpdate(
      {
        version: "2026.28.1176+4d80caf",
        currentVersion: "2026.26.989+6cd3cd5",
        updateCommand: "atlas plugin upgrade -n relay -c stable",
      },
      { cacheDir, now: () => new Date("2026-07-06T00:00:00.000Z") },
    );

    const update = await checkRelayVersionUpdate({
      cacheDir,
      currentVersion: "2026.26.989+6cd3cd5",
      now: () => new Date("2026-07-06T05:59:00.000Z"),
      runAtlasCommand: async () => {
        throw new Error("atlas should not be called while update is postponed");
      },
      fetchManifest: async () => {
        throw new Error("manifest should not be fetched while update is postponed");
      },
    });

    expect(update).toBeNull();
    const cache = JSON.parse(readFileSync(versionUpdateCachePath(cacheDir), "utf8")) as Record<string, unknown>;
    expect(cache.postponedUntil).toBe("2026-07-06T06:00:00.000Z");
    expect(cache.postponedVersion).toBe("2026.28.1176+4d80caf");
  });

  test("returns postponed update after six hours", async () => {
    const cacheDir = tempCacheDir();

    await postponeRelayVersionUpdate(
      {
        version: "2026.28.1176+4d80caf",
        currentVersion: "2026.26.989+6cd3cd5",
        updateCommand: "atlas plugin upgrade -n relay -c stable",
      },
      { cacheDir, now: () => new Date("2026-07-06T00:00:00.000Z") },
    );

    const update = await checkRelayVersionUpdate({
      cacheDir,
      currentVersion: "2026.26.989+6cd3cd5",
      now: () => new Date("2026-07-06T06:01:00.000Z"),
      runAtlasCommand: async () => {
        throw new Error("atlas should not be called when currentVersion is provided");
      },
      fetchManifest: async () => {
        throw new Error("manifest should not be fetched while cache is fresh");
      },
    });

    expect(update?.version).toBe("2026.28.1176+4d80caf");
  });

  // Public installs (GitHub Releases, Homebrew, source checkouts) update through
  // their own channel, so they must never reach the Atlas plugin manifest host or
  // spawn the Atlas CLI. The test process is not an Atlas plugin install, so the
  // real default providers short-circuit here.
  test("reports no update on a non-Atlas install without fetching the manifest", async () => {
    const cacheDir = tempCacheDir();
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    // Spy rather than relying on the request failing: a blocked network would
    // return null too, which would make this assertion vacuous.
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requested.push(String(input));
        throw new Error("manifest must not be fetched on a non-Atlas install");
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      // No fetchManifest/runAtlasCommand injection: the real defaults run.
      const update = await checkRelayVersionUpdate({
        cacheDir,
        currentVersion: "2026.26.989+6cd3cd5",
        now: () => new Date("2026-07-06T12:01:00.000Z"),
      });

      expect(update).toBeNull();
      expect(requested).toEqual([]);
      expect(existsSync(versionUpdateCachePath(cacheDir))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("clears cached update state", async () => {
    const cacheDir = tempCacheDir();
    const cachePath = versionUpdateCachePath(cacheDir);
    writeCache(cacheDir, "2026.28.1176+4d80caf", "2026-07-06T00:00:00.000Z", "2026.26.989+6cd3cd5");

    expect(existsSync(cachePath)).toBe(true);
    await clearRelayVersionUpdateCache(cacheDir);

    expect(existsSync(cachePath)).toBe(false);
    await expect(clearRelayVersionUpdateCache(cacheDir)).resolves.toBeUndefined();
  });
});
