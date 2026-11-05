import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectRelayReleaseManifest,
  formatSha256Sums,
  relayGithubReleaseArchiveName,
  relayReleaseVariantTargets,
  RELAY_RELEASE_VARIANTS,
  type RelayReleaseVariant,
  validateRelayReleaseArtifacts,
  writeRelayReleaseMetadata,
} from "../../scripts/relay-release-package";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-release-package-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hostVariant(): RelayReleaseVariant {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-amd64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(`unsupported test host: ${process.platform} ${process.arch}`);
}

function writeFixtureFile(root: string, filePath: string, content = "fixture"): void {
  const target = path.join(root, filePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function createFixtureArchive(
  dir: string,
  version: string,
  variant: RelayReleaseVariant,
  options: { readonly omitted?: readonly string[]; readonly smokeable?: boolean } = {},
): string {
  const target = relayReleaseVariantTargets[variant];
  const archiveName = relayGithubReleaseArchiveName(version, variant);
  const source = path.join(dir, `source-${variant}`);
  const entries = [
    `relay${target.exe}`,
    `assets/bin/${target.bunBin}`,
    "assets/app/dist/index.js",
    "assets/app/package.json",
    "assets/app/bun.lock",
    "assets/app/node_modules/@opentui/core/package.json",
    `assets/app/node_modules/${target.nativePkg}/package.json`,
  ];

  for (const entry of entries) {
    if (options.omitted?.includes(entry)) continue;
    const content =
      entry === `relay${target.exe}` && options.smokeable
        ? `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) printf 'relay v${version}\\n' ;;
  --help) printf 'Usage: relay [options]\\n' ;;
  *) exit 64 ;;
esac
`
        : "fixture";
    writeFixtureFile(source, entry, content);
  }
  chmodSync(path.join(source, `relay${target.exe}`), 0o755);

  const result = spawnSync("tar", ["-C", source, "-czf", path.join(dir, archiveName), "."], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stdout}${result.stderr}`);
  }
  writeRelayReleaseMetadata({ outputDir: dir, version });
  return archiveName;
}

describe("Relay release packaging contract", () => {
  test("defines the initial open-source distribution variants", () => {
    expect(RELAY_RELEASE_VARIANTS).toEqual(["darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64"]);
  });

  test("maps every variant to a Bun runtime, Go target, and OpenTUI native package", () => {
    for (const variant of RELAY_RELEASE_VARIANTS) {
      const target = relayReleaseVariantTargets[variant];

      expect(target.goos).toBeTruthy();
      expect(target.goarch).toBeTruthy();
      expect(target.bunArchive).toEndWith(".zip");
      expect(target.nativePkg).toStartWith("@opentui/core-");
    }
  });

  test("builds the shim as a public distribution, not an Atlas plugin", () => {
    // The shim only marks Atlas installs (which run the Atlas update check) for
    // its default distribution, so public archives must opt out explicitly.
    const packager = readFileSync("scripts/relay-release-package.ts", "utf8");
    expect(packager).toContain("-X main.Distribution=github");
  });

  test("uses versioned GitHub Release archive names", () => {
    expect(relayGithubReleaseArchiveName("0.1.0", "linux-amd64")).toBe("relay-v0.1.0-linux-amd64.tar.gz");
  });

  test("collects local release metadata before public URLs exist", () => {
    withTempDir((dir) => {
      const archiveName = relayGithubReleaseArchiveName("0.1.0", "linux-amd64");
      writeFileSync(path.join(dir, archiveName), "relay archive");

      const manifest = collectRelayReleaseManifest({ outputDir: dir, version: "0.1.0" });

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.releaseBaseUrl).toBeNull();
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]).toMatchObject({
        variant: "linux-amd64",
        archiveName,
        size: "relay archive".length,
        url: null,
      });
      expect(manifest.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  test("formats SHA256SUMS in release variant order", () => {
    withTempDir((dir) => {
      const darwinArchive = relayGithubReleaseArchiveName("0.1.0", "darwin-arm64");
      const linuxArchive = relayGithubReleaseArchiveName("0.1.0", "linux-arm64");
      writeFileSync(path.join(dir, linuxArchive), "linux");
      writeFileSync(path.join(dir, darwinArchive), "darwin");

      const lines = formatSha256Sums(collectRelayReleaseManifest({ outputDir: dir, version: "0.1.0" }))
        .trim()
        .split("\n");

      expect(lines.map((line) => line.split("  ")[1])).toEqual([darwinArchive, linuxArchive]);
    });
  });

  test("writes checksums and a release manifest with optional public URLs", () => {
    withTempDir((dir) => {
      const archiveName = relayGithubReleaseArchiveName("0.1.0", "linux-amd64");
      writeFileSync(path.join(dir, archiveName), "relay archive");

      const manifest = writeRelayReleaseMetadata({
        outputDir: dir,
        version: "0.1.0",
        releaseBaseUrl: "https://github.com/atlassian-labs/relay/releases/download/v0.1.0/",
      });

      const manifestJson = JSON.parse(readFileSync(path.join(dir, "release-manifest.json"), "utf8")) as typeof manifest;
      const artifactSha = readFileSync(path.join(dir, `${archiveName}.sha256`), "utf8").trim();
      const shaSums = readFileSync(path.join(dir, "SHA256SUMS"), "utf8");

      expect(manifest.artifacts[0]?.url).toBe(
        `https://github.com/atlassian-labs/relay/releases/download/v0.1.0/${archiveName}`,
      );
      expect(manifestJson).toEqual(manifest);
      expect(artifactSha).toMatch(/^[a-f0-9]{64}$/);
      expect(shaSums).toContain(`  ${archiveName}`);
    });
  });

  test("validates release archive metadata and layout without smoke tests", () => {
    withTempDir((dir) => {
      createFixtureArchive(dir, "0.1.0", "linux-amd64");

      const summary = validateRelayReleaseArtifacts({
        repoRoot: dir,
        outputDir: dir,
        version: "0.1.0",
        smoke: false,
      });

      expect(summary).toEqual({ artifacts: 1, smokedVariant: null });
    });
  });

  test("fails validation when an archive is missing bundled assets", () => {
    withTempDir((dir) => {
      createFixtureArchive(dir, "0.1.0", "linux-amd64", { omitted: ["assets/app/dist/index.js"] });

      expect(() =>
        validateRelayReleaseArtifacts({
          repoRoot: dir,
          outputDir: dir,
          version: "0.1.0",
          smoke: false,
        }),
      ).toThrow(/missing required entries/);
    });
  });

  test("fails validation when release metadata is stale", () => {
    withTempDir((dir) => {
      createFixtureArchive(dir, "0.1.0", "linux-amd64");
      writeFileSync(path.join(dir, "SHA256SUMS"), "stale\n");

      expect(() =>
        validateRelayReleaseArtifacts({
          repoRoot: dir,
          outputDir: dir,
          version: "0.1.0",
          smoke: false,
        }),
      ).toThrow(/SHA256SUMS/);
    });
  });

  test("smokes the host-supported release archive", () => {
    withTempDir((dir) => {
      const variant = hostVariant();
      createFixtureArchive(dir, "0.1.0", variant, { smokeable: true });

      const summary = validateRelayReleaseArtifacts({
        repoRoot: dir,
        outputDir: dir,
        version: "0.1.0",
        smoke: true,
      });

      expect(summary).toEqual({ artifacts: 1, smokedVariant: variant });
    });
  });
});
