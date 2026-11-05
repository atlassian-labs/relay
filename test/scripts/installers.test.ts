import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const tempRoots: string[] = [];

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "relay-installers-test-"));
  tempRoots.push(root);
  return root;
}

function hostVariant(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-amd64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(`unsupported test host: ${process.platform} ${process.arch}`);
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): CommandResult {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeFixtureRelease(root: string, version = "0.1.0", checksum = "actual"): string {
  const variant = hostVariant();
  const releaseDir = path.join(root, "release");
  const sourceDir = path.join(root, "source");
  const archive = `relay-v${version}-${variant}.tar.gz`;
  mkdirSync(path.join(sourceDir, "assets"), { recursive: true });
  writeFileSync(
    path.join(sourceDir, "relay"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version)
    printf 'relay v${version}\\n'
    ;;
  check-assets)
    test -d "\${ATLAS_PLUGIN_ASSETS:-}"
    printf '%s\\n' "$ATLAS_PLUGIN_ASSETS"
    ;;
  *)
    exit 64
    ;;
esac
`,
  );
  chmodSync(path.join(sourceDir, "relay"), 0o755);
  mkdirSync(releaseDir, { recursive: true });

  const archivePath = path.join(releaseDir, archive);
  const tar = run("tar", ["-C", sourceDir, "-czf", archivePath, "relay", "assets"], process.env);
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr}`);

  const sum = checksum === "actual" ? sha256(archivePath) : "0".repeat(64);
  writeFileSync(path.join(releaseDir, "SHA256SUMS"), `${sum}  ${archive}\n`);
  return releaseDir;
}

function writeFakeCurl(root: string): string {
  const binDir = path.join(root, "fixture-bin");
  const curlPath = path.join(binDir, "curl");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [ -z "$out" ] || [ -z "$url" ]; then
  printf 'fake curl expected URL and -o output\\n' >&2
  exit 2
fi
case "$url" in
  file://*)
    cp "\${url#file://}" "$out"
    ;;
  *)
    printf 'fake curl only supports file:// URLs: %s\\n' "$url" >&2
    exit 2
    ;;
esac
`,
  );
  chmodSync(curlPath, 0o755);
  return binDir;
}

function installEnv(root: string, releaseDir: string, version = "v0.1.0"): NodeJS.ProcessEnv {
  const fixtureBin = writeFakeCurl(root);
  return {
    ...process.env,
    HOME: path.join(root, "home"),
    PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
    RELAY_BIN_DIR: path.join(root, "bin"),
    RELAY_INSTALL_DIR: path.join(root, "install"),
    RELAY_RELEASE_BASE_URL: `file://${releaseDir}`,
    RELAY_VERSION: version,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("public release installers", () => {
  test("install.sh prints help without requiring release configuration", () => {
    const result = run("bash", ["scripts/install.sh", "--help"], process.env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("RELAY_VERSION=0.1.0");
    expect(result.stdout).toContain("RELAY_RELEASE_BASE_URL");
  });

  test("install.sh rejects invalid versions before downloading", () => {
    const root = tempRoot();
    const result = run("bash", ["scripts/install.sh"], { ...process.env, RELAY_VERSION: "../0.1.0" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("RELAY_VERSION must be a semantic version");
    expect(existsSync(path.join(root, "release"))).toBe(false);
  });

  test("install.sh installs a checksum-verified local release and writes an asset-aware shim", () => {
    const root = tempRoot();
    const releaseDir = writeFixtureRelease(root);
    const env = installEnv(root, releaseDir);

    const install = run("bash", ["scripts/install.sh"], env);

    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("Installed Relay 0.1.0");
    expect(install.stdout).toContain("relay v0.1.0");

    const relay = path.join(root, "bin", "relay");
    const shim = run(relay, ["check-assets"], env);
    expect(shim.exitCode).toBe(0);
    expect(shim.stdout.trim()).toBe(path.join(root, "install", "releases", "0.1.0", hostVariant(), "assets"));
  });

  test("install.sh rejects checksum mismatches", () => {
    const root = tempRoot();
    const releaseDir = writeFixtureRelease(root, "0.1.0", "bad");

    const result = run("bash", ["scripts/install.sh"], installEnv(root, releaseDir));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
  });

  test("install.ps1 keeps the Windows checksum and shim contract", () => {
    const script = readFileSync("scripts/install.ps1", "utf8");

    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script).toContain("ATLAS_PLUGIN_ASSETS");
    expect(script).toContain("exit /b %ERRORLEVEL%");
    expect(script).toContain("RELAY_VERSION must be a semantic version");
  });
});
