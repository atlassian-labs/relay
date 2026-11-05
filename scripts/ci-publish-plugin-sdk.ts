import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

type PackageJson = Record<string, unknown> & {
  name?: string;
  version?: string;
};

const repoRoot = resolve(import.meta.dirname, "..");
const sdkDir = resolve(repoRoot, "packages", "relay-plugin-sdk");
const sdkPackageJsonPath = resolve(sdkDir, "package.json");
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const allowedDistTags = new Set(["latest", "next", "beta"]);

function readPackageJson(path: string): PackageJson {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as PackageJson;
}

function requireVersion(version: string, label: string): void {
  if (!semverPattern.test(version)) {
    throw new Error(`${label} must be a valid semantic version, for example 1.2.3 or 1.2.3-beta.1`);
  }
}

function nextPatchVersion(version: string): string | null {
  const match = semverPattern.exec(version);
  if (!match || match[4] || match[5]) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

function writePackageVersion(packageJson: PackageJson, version: string): void {
  writeFileSync(sdkPackageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function main(): void {
  const packageJson = readPackageJson(sdkPackageJsonPath);
  if (packageJson.name !== "@atlassian/relay-plugin-sdk") {
    throw new Error(`Unexpected SDK package name: ${packageJson.name ?? "<missing>"}`);
  }
  if (!packageJson.version) {
    throw new Error("SDK package.json is missing a version");
  }
  requireVersion(packageJson.version, "Current package.json version");

  const requestedVersion = process.env.SDK_VERSION?.trim();
  const suggestedNextPatch = nextPatchVersion(packageJson.version);
  if (!requestedVersion) {
    const suggestion = suggestedNextPatch ? ` or next patch ${suggestedNextPatch}` : "";
    throw new Error(
      `Set SDK_VERSION to publish @atlassian/relay-plugin-sdk. Current version is ${packageJson.version}${suggestion}.`,
    );
  }
  requireVersion(requestedVersion, "SDK_VERSION");

  const distTag = process.env.NPM_DIST_TAG?.trim() || "latest";
  if (!allowedDistTags.has(distTag)) {
    throw new Error(`NPM_DIST_TAG must be one of: ${[...allowedDistTags].join(", ")}`);
  }

  process.stdout.write(`Publishing @atlassian/relay-plugin-sdk@${requestedVersion} with dist-tag ${distTag}.\n`);
  process.stdout.write(`Package.json currently has ${packageJson.version}.`);
  if (suggestedNextPatch) {
    process.stdout.write(` Suggested next patch is ${suggestedNextPatch}.`);
  }
  process.stdout.write("\n");

  writePackageVersion(packageJson, requestedVersion);
  run("bun", ["run", "build:plugin-sdk"], repoRoot);

  const publishArgs = ["publish", "--tag", distTag, "--access", "restricted"];
  if (process.env.PUBLISH_DRY_RUN === "true") {
    publishArgs.push("--dry-run");
  }
  run("npm", publishArgs, sdkDir);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
