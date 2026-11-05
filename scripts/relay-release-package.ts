#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const RELAY_RELEASE_VARIANTS = ["darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64"] as const;

export type RelayReleaseVariant = (typeof RELAY_RELEASE_VARIANTS)[number];

export interface RelayReleaseVariantTarget {
  readonly goos: string;
  readonly goarch: string;
  readonly bunTarget: string;
  readonly bunArchive: string;
  readonly bunBin: string;
  readonly exe: string;
  readonly nativePkg: string;
}

export const relayReleaseVariantTargets: Readonly<Record<RelayReleaseVariant, RelayReleaseVariantTarget>> = {
  "darwin-arm64": {
    goos: "darwin",
    goarch: "arm64",
    bunTarget: "darwin-aarch64",
    bunArchive: "bun-darwin-aarch64.zip",
    bunBin: "bun",
    exe: "",
    nativePkg: "@opentui/core-darwin-arm64",
  },
  "linux-amd64": {
    goos: "linux",
    goarch: "amd64",
    bunTarget: "linux-x64",
    bunArchive: "bun-linux-x64.zip",
    bunBin: "bun",
    exe: "",
    nativePkg: "@opentui/core-linux-x64",
  },
  "linux-arm64": {
    goos: "linux",
    goarch: "arm64",
    bunTarget: "linux-aarch64",
    bunArchive: "bun-linux-aarch64.zip",
    bunBin: "bun",
    exe: "",
    nativePkg: "@opentui/core-linux-arm64",
  },
  "windows-amd64": {
    goos: "windows",
    goarch: "amd64",
    bunTarget: "windows-x64",
    bunArchive: "bun-windows-x64.zip",
    bunBin: "bun.exe",
    exe: ".exe",
    nativePkg: "@opentui/core-win32-x64",
  },
};

export function relayGithubReleaseArchiveName(version: string, variant: RelayReleaseVariant): string {
  return `relay-v${version}-${variant}.tar.gz`;
}

export interface RelayPackageVariantOptions {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly variant: RelayReleaseVariant;
  readonly version: string;
  readonly archiveName: string;
  readonly workDirPrefix: string;
  readonly signDarwin: boolean;
}

export interface RelayReleaseMetadataOptions {
  readonly outputDir: string;
  readonly version: string;
  readonly releaseBaseUrl?: string;
}

export interface RelayReleaseArtifactMetadata {
  readonly variant: RelayReleaseVariant;
  readonly archiveName: string;
  readonly size: number;
  readonly sha256: string;
  readonly url: string | null;
}

export interface RelayReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly releaseBaseUrl: string | null;
  readonly artifacts: readonly RelayReleaseArtifactMetadata[];
}

export interface RelayReleaseValidationOptions {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly version: string;
  readonly releaseBaseUrl?: string;
  readonly smoke: boolean;
}

export interface RelayReleaseValidationSummary {
  readonly artifacts: number;
  readonly smokedVariant: RelayReleaseVariant | null;
}

function run(
  repoRoot: string,
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandOutput(
  repoRoot: string,
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function normalizedBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function bunVersion(): string {
  const version = process.env.BUN_VERSION;
  if (version !== undefined && version.length > 0) return version;
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return "1.3.14";
  return result.stdout.trim();
}

export function collectRelayReleaseManifest(options: RelayReleaseMetadataOptions): RelayReleaseManifest {
  const releaseBaseUrl = normalizedBaseUrl(options.releaseBaseUrl);
  const files = existsSync(options.outputDir) ? new Set(readdirSync(options.outputDir)) : new Set<string>();
  const artifacts = RELAY_RELEASE_VARIANTS.flatMap((variant): RelayReleaseArtifactMetadata[] => {
    const archiveName = relayGithubReleaseArchiveName(options.version, variant);
    if (!files.has(archiveName)) return [];

    const archivePath = path.join(options.outputDir, archiveName);
    return [
      {
        variant,
        archiveName,
        size: statSync(archivePath).size,
        sha256: sha256File(archivePath),
        url: releaseBaseUrl === null ? null : `${releaseBaseUrl}/${archiveName}`,
      },
    ];
  });

  return { schemaVersion: 1, version: options.version, releaseBaseUrl, artifacts };
}

export function formatSha256Sums(manifest: RelayReleaseManifest): string {
  return (
    manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.archiveName}`).join("\n") +
    (manifest.artifacts.length === 0 ? "" : "\n")
  );
}

export function writeRelayReleaseMetadata(options: RelayReleaseMetadataOptions): RelayReleaseManifest {
  mkdirSync(options.outputDir, { recursive: true });
  const manifest = collectRelayReleaseManifest(options);
  for (const artifact of manifest.artifacts) {
    writeFileSync(path.join(options.outputDir, `${artifact.archiveName}.sha256`), `${artifact.sha256}\n`);
  }
  writeFileSync(path.join(options.outputDir, "SHA256SUMS"), formatSha256Sums(manifest));
  writeFileSync(path.join(options.outputDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function hostRelayReleaseVariant(): RelayReleaseVariant | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-amd64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-amd64";
  return null;
}

function requiredArchiveEntries(variant: RelayReleaseVariant): readonly string[] {
  const target = relayReleaseVariantTargets[variant];
  return [
    `relay${target.exe}`,
    `assets/bin/${target.bunBin}`,
    "assets/app/dist/index.js",
    "assets/app/package.json",
    "assets/app/bun.lock",
    "assets/app/node_modules/@opentui/core/package.json",
    `assets/app/node_modules/${target.nativePkg}/package.json`,
  ];
}

function archiveEntries(repoRoot: string, archivePath: string): Set<string> {
  const output = commandOutput(repoRoot, "tar", ["-tzf", archivePath]);
  return new Set(
    output
      .split("\n")
      .map((entry) => entry.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
      .filter((entry) => entry.length > 0),
  );
}

function validateReleaseMetadata(options: RelayReleaseValidationOptions, manifest: RelayReleaseManifest): void {
  const actualShaSums = readFileSync(path.join(options.outputDir, "SHA256SUMS"), "utf8");
  if (actualShaSums !== formatSha256Sums(manifest)) {
    throw new Error("SHA256SUMS does not match release artifacts");
  }

  const manifestPath = path.join(options.outputDir, "release-manifest.json");
  const actualManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (JSON.stringify(actualManifest) !== JSON.stringify(manifest)) {
    throw new Error("release-manifest.json does not match release artifacts");
  }

  for (const artifact of manifest.artifacts) {
    const shaPath = path.join(options.outputDir, `${artifact.archiveName}.sha256`);
    if (readFileSync(shaPath, "utf8") !== `${artifact.sha256}\n`) {
      throw new Error(`${artifact.archiveName}.sha256 does not match release artifact`);
    }
  }
}

function validateArchiveLayout(repoRoot: string, artifact: RelayReleaseArtifactMetadata, outputDir: string): void {
  const entries = archiveEntries(repoRoot, path.join(outputDir, artifact.archiveName));
  const missing = requiredArchiveEntries(artifact.variant).filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(`${artifact.archiveName} is missing required entries: ${missing.join(", ")}`);
  }
}

function smokeRelayArchive(options: RelayReleaseValidationOptions, artifact: RelayReleaseArtifactMetadata): void {
  const target = relayReleaseVariantTargets[artifact.variant];
  const work = mkdtempSync(path.join(tmpdir(), `relay-release-smoke-${artifact.variant}-`));
  try {
    commandOutput(options.repoRoot, "tar", ["-xzf", path.join(options.outputDir, artifact.archiveName), "-C", work]);
    const home = path.join(work, "home");
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      ATLAS_PLUGIN_ASSETS: path.join(work, "assets"),
      DO_NOT_TRACK: "1",
      HOME: home,
      RELAY_TELEMETRY_DISABLED: "1",
      XDG_CONFIG_HOME: path.join(home, ".config"),
    };
    const relay = path.join(work, `relay${target.exe}`);
    const versionOutput = commandOutput(options.repoRoot, relay, ["--version"], { env });
    if (!versionOutput.includes(`relay v${options.version}`)) {
      throw new Error(`${artifact.archiveName} --version returned ${JSON.stringify(versionOutput.trim())}`);
    }
    const helpOutput = commandOutput(options.repoRoot, relay, ["--help"], { env });
    if (!helpOutput.includes("Usage:")) {
      throw new Error(`${artifact.archiveName} --help did not print usage`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function validateRelayReleaseArtifacts(options: RelayReleaseValidationOptions): RelayReleaseValidationSummary {
  const manifest = collectRelayReleaseManifest({
    outputDir: options.outputDir,
    version: options.version,
    releaseBaseUrl: options.releaseBaseUrl,
  });
  if (manifest.artifacts.length === 0) {
    throw new Error(`no release artifacts found in ${options.outputDir} for version ${options.version}`);
  }

  validateReleaseMetadata(options, manifest);
  for (const artifact of manifest.artifacts) {
    validateArchiveLayout(options.repoRoot, artifact, options.outputDir);
  }

  const hostVariant = hostRelayReleaseVariant();
  const hostArtifact = manifest.artifacts.find((artifact) => artifact.variant === hostVariant);
  if (options.smoke && hostArtifact) {
    smokeRelayArchive(options, hostArtifact);
  }

  return {
    artifacts: manifest.artifacts.length,
    smokedVariant: options.smoke && hostArtifact ? hostArtifact.variant : null,
  };
}

async function downloadBun(repoRoot: string, variant: RelayReleaseVariant, targetDir: string): Promise<void> {
  const target = relayReleaseVariantTargets[variant];
  const version = bunVersion();
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${target.bunArchive}`;
  const zipPath = path.join(targetDir, target.bunArchive);
  console.log(`package: downloading Bun ${version} for ${variant}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status} ${await response.text()}`);
  }
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  run(repoRoot, "unzip", ["-q", zipPath, "-d", targetDir]);

  const extractedDir = path.join(targetDir, `bun-${target.bunTarget}`);
  const source = path.join(extractedDir, target.bunBin);
  const destDir = path.join(targetDir, "bin");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, path.join(destDir, target.bunBin));
  chmodSync(path.join(destDir, target.bunBin), 0o755);
  rmSync(zipPath, { force: true });
  rmSync(extractedDir, { recursive: true, force: true });
}

function installProductionDependencies(repoRoot: string, appDir: string, variant: RelayReleaseVariant): void {
  const target = relayReleaseVariantTargets[variant];
  // npm --os/--cpu do not reliably cross-install optional platform-specific
  // packages, so the release packager installs and prunes native modules itself.
  run(
    repoRoot,
    "npm",
    ["install", "--omit=dev", "--include=optional", "--legacy-peer-deps", "--registry=https://registry.npmjs.org"],
    { cwd: appDir },
  );

  const corePkg = JSON.parse(
    readFileSync(path.join(appDir, "node_modules", "@opentui", "core", "package.json"), "utf8"),
  ) as { readonly version: string };
  const coreVersion = corePkg.version;

  run(
    repoRoot,
    "npm",
    [
      "install",
      "--no-save",
      "--force",
      "--legacy-peer-deps",
      "--registry=https://registry.npmjs.org",
      `${target.nativePkg}@${coreVersion}`,
    ],
    { cwd: appDir },
  );

  const allNativePkgs = Object.values(relayReleaseVariantTargets).map((entry) => entry.nativePkg);
  for (const pkg of allNativePkgs) {
    if (pkg === target.nativePkg) continue;
    const pkgDir = path.join(appDir, "node_modules", ...pkg.split("/"));
    if (existsSync(pkgDir)) {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  }
}

const APPLE_TEAM_ID = "UPXU4CQZ5P";
const APPLE_SIGNING_IDENTITY = `Developer ID Application: Atlassian Pty Ltd (${APPLE_TEAM_ID})`;
const NOTARY_TIMEOUT_MINUTES = "15";

function signDarwinBinary(repoRoot: string, binaryPath: string): void {
  console.log("package: signing darwin-arm64 binary with Developer ID (Hancock)");
  run(repoRoot, "codesign", ["--force", "--options", "runtime", "--sign", APPLE_SIGNING_IDENTITY, binaryPath]);
  run(repoRoot, "codesign", ["--verify", "--verbose", binaryPath]);
}

function notarizeDarwinBinary(repoRoot: string, binaryPath: string, workDir: string): void {
  const keyId = process.env.NOTARY_KEY_ID;
  const issuerId = process.env.NOTARY_ISSUER_ID;
  const keyContent = process.env.NOTARY_KEY_CONTENT;
  if (!keyId || !issuerId || !keyContent) {
    console.log("package: skipping notarization (NOTARY_KEY_ID/NOTARY_ISSUER_ID/NOTARY_KEY_CONTENT not set)");
    return;
  }

  console.log("package: notarizing darwin-arm64 binary with Apple notary service");
  const keyPath = path.join(workDir, `AuthKey_${keyId}.p8`);
  const zipPath = path.join(workDir, "relay-notarize.zip");
  writeFileSync(keyPath, keyContent);
  try {
    run(repoRoot, "/usr/bin/ditto", ["-c", "-k", "--keepParent", binaryPath, zipPath]);
    run(repoRoot, "xcrun", [
      "notarytool",
      "submit",
      zipPath,
      "--key-id",
      keyId,
      "--issuer",
      issuerId,
      "--key",
      keyPath,
      "--wait",
      "--timeout",
      NOTARY_TIMEOUT_MINUTES,
    ]);
  } finally {
    if (existsSync(keyPath)) unlinkSync(keyPath);
    if (existsSync(zipPath)) unlinkSync(zipPath);
  }
}

export async function packageRelayVariant(options: RelayPackageVariantOptions): Promise<void> {
  const target = relayReleaseVariantTargets[options.variant];
  mkdirSync(options.outputDir, { recursive: true });
  run(options.repoRoot, "bun", ["run", "build"]);

  const work = mkdtempSync(path.join(tmpdir(), `${options.workDirPrefix}-${options.variant}-`));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  const appDir = path.join(work, "assets", "app");
  mkdirSync(appDir, { recursive: true });
  cpSync(path.join(options.repoRoot, "dist"), path.join(appDir, "dist"), { recursive: true });
  copyFileSync(path.join(options.repoRoot, "package.json"), path.join(appDir, "package.json"));
  copyFileSync(path.join(options.repoRoot, "bun.lock"), path.join(appDir, "bun.lock"));
  installProductionDependencies(options.repoRoot, appDir, options.variant);
  await downloadBun(options.repoRoot, options.variant, path.join(work, "assets"));

  const shimPath = path.join(work, `relay${target.exe}`);
  run(
    options.repoRoot,
    "go",
    [
      "build",
      "-trimpath",
      `-ldflags=-s -w -X main.Version=${options.version} -X main.Distribution=github`,
      "-o",
      shimPath,
      path.join(options.repoRoot, "cmd", "relay"),
    ],
    {
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
    },
  );
  chmodSync(shimPath, 0o755);

  if (options.variant === "darwin-arm64" && options.signDarwin) {
    signDarwinBinary(options.repoRoot, shimPath);
    notarizeDarwinBinary(options.repoRoot, shimPath, work);
  }

  const archivePath = path.join(options.outputDir, options.archiveName);
  const isGnuTar = process.platform !== "darwin";
  const tarArgs = isGnuTar
    ? ["-C", work, "--owner=0", "--group=0", "--no-xattrs", "-czf", archivePath, `relay${target.exe}`, "assets"]
    : ["-C", work, "-czf", archivePath, `relay${target.exe}`, "assets"];
  run(options.repoRoot, "tar", tarArgs);

  const archiveBytes = readFileSync(archivePath);
  const sha = createHash("sha256").update(archiveBytes).digest("hex");
  writeFileSync(`${archivePath}.sha256`, `${sha}\n`);
  const sizeMb = (statSync(archivePath).size / 1024 / 1024).toFixed(1);
  console.log(`package: done — ${path.relative(options.repoRoot, archivePath)} (${sizeMb} MB)`);
}
