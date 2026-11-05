#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "path";
import solidPlugin from "@opentui/solid/bun-plugin";
import {
  opentuiNativePackagesFromPackageJson,
  type PackageJsonWithOptionalDependencies,
} from "./opentui-native-packages";
import { pluginRuntimeDependencies } from "./plugin-runtime-dependencies";

const repoRoot = resolve(import.meta.dirname, "..");
const bundledPluginsDir = resolve(repoRoot, "src", "plugins", "bundled");
const relayPluginSdkDir = resolve(repoRoot, "packages", "relay-plugin-sdk");
const relayPluginSdkDistDir = resolve(relayPluginSdkDir, "dist");
const relayPluginSdkTsconfig = resolve(relayPluginSdkDir, "tsconfig.json");

process.chdir(repoRoot);

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly stdio?: "inherit" | "ignore" } = {},
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

interface RelayContribCheckout {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

async function installBundledPluginDependencies(pluginNames: readonly string[]): Promise<readonly string[]> {
  const installDirectories: string[] = [];
  const registryOverride = process.env.RELAY_PLUGIN_NPM_REGISTRY?.trim();

  try {
    for (const pluginName of pluginNames) {
      const pluginDir = resolve(bundledPluginsDir, pluginName);
      const packageJsonPath = resolve(pluginDir, "package.json");
      if (!existsSync(packageJsonPath)) continue;

      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
      const dependencies = pluginRuntimeDependencies(packageJson);
      if (Object.keys(dependencies).length === 0) continue;

      const installDir = await mkdtemp(resolve(tmpdir(), `relay-plugin-${pluginName}-`));
      installDirectories.push(installDir);
      await writeFile(
        resolve(installDir, "package.json"),
        `${JSON.stringify({ name: `relay-bundled-${pluginName}-dependencies`, private: true, dependencies }, null, 2)}\n`,
      );

      // TODO: Remove this npmjs fallback once Atlassian Artifactory maintains a proxy for @pierre/diffs and its dependencies.
      const registry =
        registryOverride ?? (dependencies["@pierre/diffs"] !== undefined ? "https://registry.npmjs.org" : undefined);
      const args = ["install", "--production"];
      if (registry) args.push(`--registry=${registry}`);
      process.stdout.write(`Installing isolated dependencies for bundled plugin ${pluginName}\n`);
      run(process.execPath, args, { cwd: installDir });

      const pluginNodeModules = resolve(pluginDir, "node_modules");
      await rm(pluginNodeModules, { recursive: true, force: true });
      await symlink(
        resolve(installDir, "node_modules"),
        pluginNodeModules,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    return installDirectories;
  } catch (error) {
    await Promise.all(installDirectories.map((dir) => rm(dir, { recursive: true, force: true })));
    throw error;
  }
}

async function buildRelayPluginSdk(): Promise<void> {
  await rm(relayPluginSdkDistDir, { recursive: true, force: true });
  run("tsgo", ["-p", relayPluginSdkTsconfig]);
  process.stdout.write("Built Relay plugin SDK into packages/relay-plugin-sdk/dist/\n");
}

async function copyBundledPluginRuntimeAssets(): Promise<void> {
  const distBundledDir = resolve("dist", "bundled");
  await rm(distBundledDir, { recursive: true, force: true });
  await mkdir(distBundledDir, { recursive: true });

  const entries = await readdir(bundledPluginsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const sourceDir = resolve(bundledPluginsDir, entry.name);
    const targetDir = resolve(distBundledDir, entry.name);
    await cp(sourceDir, targetDir, { recursive: true });
    await rm(resolve(targetDir, "node_modules"), { recursive: true, force: true });
    await rm(resolve(targetDir, "goals"), { recursive: true, force: true });
  }
}

async function buildRelay(): Promise<void> {
  const opentuiCorePackageJson = JSON.parse(
    await readFile(resolve("node_modules/@opentui/core/package.json"), "utf8"),
  ) as PackageJsonWithOptionalDependencies;
  const opentuiNativePackages = opentuiNativePackagesFromPackageJson(opentuiCorePackageJson);
  const relayVersion = (await readFile(resolve(repoRoot, ".relay-version"), "utf8")).trim();

  const result = await Bun.build({
    entrypoints: ["./src/index.ts", "./src/plugin.ts"],
    outdir: "./dist",
    target: "bun",
    define: { __RELAY_VERSION__: JSON.stringify(relayVersion) },
    plugins: [solidPlugin],
    external: opentuiNativePackages,
    sourcemap: "external",
    naming: "[dir]/[name].[ext]",
  });

  if (!result.success) {
    for (const log of result.logs) {
      const message = log.message || "build failed";
      process.stderr.write(message + "\n");
    }
    throw new Error("build failed");
  }

  await copyBundledPluginRuntimeAssets();
  await rm(resolve("dist", "skills"), { recursive: true, force: true });

  // The tree-sitter parser worker is loaded at runtime via `new Worker(...)` so
  // the bundler can't see it. Copy it into dist/ so it sits next to the bundle
  // where opentui expects to find it via import.meta.url.
  await copyFile(resolve("node_modules/@opentui/core/parser.worker.js"), resolve("dist/parser.worker.js"));

  // Copy the web dashboard shell assets and bundle the browser client next to the server bundle.
  await cp(resolve("src/web/static"), resolve("dist/static"), { recursive: true });
  const webClientResult = await Bun.build({
    entrypoints: [resolve("src/web/client/main.ts")],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "inline",
    write: false,
  } as Parameters<typeof Bun.build>[0]);
  if (!webClientResult.success) {
    for (const log of webClientResult.logs) process.stderr.write((log.message || "web client build failed") + "\n");
    throw new Error("web client build failed");
  }
  const webClientOutput =
    webClientResult.outputs.find((file) => file.kind === "entry-point") ?? webClientResult.outputs[0];
  if (!webClientOutput) {
    process.stderr.write("web client build failed: no output produced\n");
    throw new Error("web client build failed: no output produced");
  }
  await Bun.write(resolve("dist/static/client.js"), webClientOutput);

  // Copy notification sound files into dist/sounds/ so they're available at runtime.
  const soundsSrcDir = resolve("src/sounds");
  const soundsDistDir = resolve("dist/sounds");
  await mkdir(soundsDistDir, { recursive: true });
  const soundFiles = await readdir(soundsSrcDir);
  for (const file of soundFiles) {
    if (file.endsWith(".wav")) {
      await copyFile(resolve(soundsSrcDir, file), resolve(soundsDistDir, file));
    }
  }

  process.stdout.write("Built Relay into dist/\n");
}

await buildRelayPluginSdk();

await buildRelay();
