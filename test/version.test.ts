import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const roots: string[] = [];

function temporaryRoot(): string {
  const root = resolve(tmpdir(), `relay-version-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

async function buildVersion(embeddedVersion?: string, printInstallKind = false): Promise<string> {
  const root = temporaryRoot();
  const entrypoint = resolve(root, "entry.ts");
  const outdir = resolve(root, "dist");
  const versionModule = JSON.stringify(resolve(repoRoot, "src/version.ts"));
  writeFileSync(
    entrypoint,
    printInstallKind
      ? `import { IS_ATLAS_PLUGIN_INSTALL } from ${versionModule};\nconsole.log(IS_ATLAS_PLUGIN_INSTALL);\n`
      : `import { VERSION } from ${versionModule};\nconsole.log(VERSION);\n`,
  );
  writeFileSync(resolve(root, ".relay-version"), "2026.99.1+runtime\n");

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    ...(embeddedVersion === undefined ? {} : { define: { __RELAY_VERSION__: JSON.stringify(embeddedVersion) } }),
  });
  expect(result.success).toBe(true);
  const output = result.outputs.find((file) => file.kind === "entry-point");
  if (!output) throw new Error("version test build did not produce an entry point");
  return output.path;
}

function runVersion(entrypoint: string, atlasPluginVersion?: string, releaseVersion?: string): string {
  const env = { ...process.env };
  delete env.RELAY_ATLAS_PLUGIN_VERSION;
  delete env.RELAY_RELEASE_VERSION;
  if (atlasPluginVersion !== undefined) env.RELAY_ATLAS_PLUGIN_VERSION = atlasPluginVersion;
  if (releaseVersion !== undefined) env.RELAY_RELEASE_VERSION = releaseVersion;

  const result = Bun.spawnSync({
    cmd: [process.execPath, entrypoint],
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString().trim();
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("version resolution", () => {
  test("uses the embedded release instead of the runtime marker", async () => {
    const entrypoint = await buildVersion("2026.42.7+embedded");
    expect(runVersion(entrypoint)).toBe("2026.42.7+embedded");
  });

  test("does not read the runtime marker when the embedded release is dev", async () => {
    const entrypoint = await buildVersion("dev");
    expect(runVersion(entrypoint)).toBe("dev");
  });

  test("prefers the Atlas shim version over the embedded release", async () => {
    const entrypoint = await buildVersion("2026.42.7+embedded");
    expect(runVersion(entrypoint, "2026.43.1+atlas")).toBe("2026.43.1+atlas");
  });

  test("uses the runtime marker when no build release is defined", async () => {
    const entrypoint = await buildVersion();
    expect(runVersion(entrypoint)).toBe("2026.99.1+runtime");
  });

  test("only identifies versions supplied by the Atlas shim as Atlas installs", async () => {
    const entrypoint = await buildVersion("2026.42.7+embedded", true);
    expect(runVersion(entrypoint)).toBe("false");
    expect(runVersion(entrypoint, "2026.43.1+atlas")).toBe("true");
  });

  test("uses the public shim version without identifying an Atlas install", async () => {
    const versionEntrypoint = await buildVersion("2026.42.7+embedded");
    expect(runVersion(versionEntrypoint, undefined, "0.1.0")).toBe("0.1.0");
    const installKindEntrypoint = await buildVersion("2026.42.7+embedded", true);
    expect(runVersion(installKindEntrypoint, undefined, "0.1.0")).toBe("false");
  });
});
