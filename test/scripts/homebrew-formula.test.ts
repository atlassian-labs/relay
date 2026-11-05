import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderRelayHomebrewFormula, writeRelayHomebrewFormula } from "../../scripts/homebrew-formula";
import type { RelayReleaseManifest } from "../../scripts/relay-release-package";

function manifest(
  url:
    | string
    | null = "https://github.com/atlassian-labs/relay/releases/download/v0.1.0/relay-v0.1.0-darwin-arm64.tar.gz",
): RelayReleaseManifest {
  return {
    schemaVersion: 1,
    version: "0.1.0",
    releaseBaseUrl: url === null ? null : "https://github.com/atlassian-labs/relay/releases/download/v0.1.0",
    artifacts: [
      {
        variant: "darwin-arm64",
        archiveName: "relay-v0.1.0-darwin-arm64.tar.gz",
        size: 1024,
        sha256: "a".repeat(64),
        url,
      },
    ],
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-homebrew-formula-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Relay Homebrew formula generation", () => {
  test("renders a macOS arm64 formula using release artifact metadata", () => {
    const formula = renderRelayHomebrewFormula({ manifest: manifest() });

    expect(formula).toContain("class Relay < Formula");
    expect(formula).toContain(
      'url "https://github.com/atlassian-labs/relay/releases/download/v0.1.0/relay-v0.1.0-darwin-arm64.tar.gz"',
    );
    expect(formula).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(formula).toContain('libexec.install "relay", "assets"');
    expect(formula).toContain('write_env_script libexec/"relay", ATLAS_PLUGIN_ASSETS: libexec/"assets"');
    expect(formula).toContain('assert_match "relay v#{version}"');
  });

  test("requires public release URLs", () => {
    expect(() => renderRelayHomebrewFormula({ manifest: manifest(null) })).toThrow(/release artifact URLs/);
  });

  test("writes Formula/relay.rb into a tap checkout", () => {
    withTempDir((dir) => {
      const formulaPath = writeRelayHomebrewFormula({ tapDir: dir, manifest: manifest() });

      expect(formulaPath).toBe(path.join(dir, "Formula", "relay.rb"));
      expect(readFileSync(formulaPath, "utf8")).toContain("class Relay < Formula");
    });
  });
});
