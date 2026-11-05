#!/usr/bin/env bun

import path from "node:path";
import { parseArgs } from "node:util";
import { writeRelayHomebrewFormula } from "./homebrew-formula";
import {
  collectRelayReleaseManifest,
  packageRelayVariant,
  relayGithubReleaseArchiveName,
  RELAY_RELEASE_VARIANTS,
  type RelayReleaseVariant,
  validateRelayReleaseArtifacts,
  writeRelayReleaseMetadata,
} from "./relay-release-package";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(repoRoot, "dist", "github-release");

function usage(): never {
  console.error(`usage:
  bun run scripts/github-release.ts variants
  bun run scripts/github-release.ts package --variant=<variant> --version=<version> [--release-base-url=<url>]
  bun run scripts/github-release.ts metadata --version=<version> [--release-base-url=<url>]
  bun run scripts/github-release.ts validate --version=<version> [--release-base-url=<url>] [--skip-smoke]
  bun run scripts/github-release.ts homebrew-formula --version=<version> --release-base-url=<url> [--tap-dir=<dir>] [--formula-name=<name>]`);
  process.exit(64);
}

function parseOptionArgs(options: Record<string, { type: "string" | "boolean" }>) {
  return parseArgs({ args: process.argv.slice(3), options, allowPositionals: false }).values;
}

function requireString(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    console.error(`error: --${name} is required`);
    process.exit(64);
  }
  return value;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseVariant(input: string): RelayReleaseVariant {
  if ((RELAY_RELEASE_VARIANTS as readonly string[]).includes(input)) return input as RelayReleaseVariant;
  console.error(
    `error: unsupported variant ${JSON.stringify(input)}; expected one of ${RELAY_RELEASE_VARIANTS.join(", ")}`,
  );
  process.exit(64);
}

const command = process.argv[2];
if (command === "variants") {
  console.log(RELAY_RELEASE_VARIANTS.join(" "));
} else if (command === "package") {
  const values = parseOptionArgs({
    variant: { type: "string" },
    version: { type: "string" },
    "release-base-url": { type: "string" },
  });
  const variant = parseVariant(requireString(values.variant, "variant"));
  const version = requireString(values.version, "version");
  await packageRelayVariant({
    repoRoot,
    outputDir: distDir,
    variant,
    version,
    archiveName: relayGithubReleaseArchiveName(version, variant),
    workDirPrefix: "relay-github-release",
    signDarwin: process.env.RELAY_CODESIGN === "1",
  });
  writeRelayReleaseMetadata({
    outputDir: distDir,
    version,
    releaseBaseUrl: optionalString(values["release-base-url"]),
  });
} else if (command === "metadata") {
  const values = parseOptionArgs({
    version: { type: "string" },
    "release-base-url": { type: "string" },
  });
  writeRelayReleaseMetadata({
    outputDir: distDir,
    version: requireString(values.version, "version"),
    releaseBaseUrl: optionalString(values["release-base-url"]),
  });
} else if (command === "validate") {
  const values = parseOptionArgs({
    version: { type: "string" },
    "release-base-url": { type: "string" },
    "skip-smoke": { type: "boolean" },
  });
  const summary = validateRelayReleaseArtifacts({
    repoRoot,
    outputDir: distDir,
    version: requireString(values.version, "version"),
    releaseBaseUrl: optionalString(values["release-base-url"]),
    smoke: values["skip-smoke"] !== true,
  });
  console.log(`validate: checked ${summary.artifacts} artifact(s)`);
  console.log(
    summary.smokedVariant === null
      ? "validate: no host-supported artifact smoke test ran"
      : `validate: smoke tested ${summary.smokedVariant}`,
  );
} else if (command === "homebrew-formula") {
  const values = parseOptionArgs({
    version: { type: "string" },
    "release-base-url": { type: "string" },
    "tap-dir": { type: "string" },
    "formula-name": { type: "string" },
  });
  const version = requireString(values.version, "version");
  const formulaPath = writeRelayHomebrewFormula({
    tapDir: optionalString(values["tap-dir"]) ?? path.join(repoRoot, "dist", "homebrew-tap"),
    formulaName: optionalString(values["formula-name"]),
    manifest: collectRelayReleaseManifest({
      outputDir: distDir,
      version,
      releaseBaseUrl: requireString(values["release-base-url"], "release-base-url"),
    }),
  });
  console.log(`homebrew: wrote ${path.relative(repoRoot, formulaPath)}`);
} else {
  usage();
}
