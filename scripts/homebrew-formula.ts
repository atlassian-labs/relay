import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RelayReleaseArtifactMetadata, RelayReleaseManifest } from "./relay-release-package";

const HOMEBREW_VARIANT = "darwin-arm64";

type RelayHomebrewArtifact = RelayReleaseArtifactMetadata & { readonly url: string };

export interface RelayHomebrewFormulaOptions {
  readonly manifest: RelayReleaseManifest;
  readonly formulaName?: string;
  readonly desc?: string;
  readonly homepage?: string;
  readonly license?: string;
}

export interface WriteRelayHomebrewFormulaOptions extends RelayHomebrewFormulaOptions {
  readonly tapDir: string;
}

function rubyString(value: string): string {
  return JSON.stringify(value);
}

function formulaClassName(formulaName: string): string {
  return formulaName
    .split(/[^0-9A-Za-z]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function homebrewArtifact(manifest: RelayReleaseManifest): RelayHomebrewArtifact {
  const artifact = manifest.artifacts.find((entry) => entry.variant === HOMEBREW_VARIANT);
  if (!artifact) {
    throw new Error(`release manifest is missing ${HOMEBREW_VARIANT}`);
  }
  if (artifact.url === null) {
    throw new Error("Homebrew formula requires release artifact URLs; pass --release-base-url");
  }
  return { ...artifact, url: artifact.url };
}

export function renderRelayHomebrewFormula(options: RelayHomebrewFormulaOptions): string {
  const formulaName = options.formulaName ?? "relay";
  const className = formulaClassName(formulaName);
  if (className.length === 0) {
    throw new Error("formula name must contain at least one alphanumeric character");
  }

  const artifact = homebrewArtifact(options.manifest);
  return `class ${className} < Formula
  desc ${rubyString(options.desc ?? "ACP-first terminal UI")}
  homepage ${rubyString(options.homepage ?? "https://github.com/atlassian-labs/relay")}
  version ${rubyString(options.manifest.version)}
  license ${rubyString(options.license ?? "Apache-2.0")}

  on_macos do
    on_arm do
      url ${rubyString(artifact.url)}
      sha256 ${rubyString(artifact.sha256)}
    end
  end

  def install
    libexec.install "relay", "assets"
    (bin/"relay").write_env_script libexec/"relay", ATLAS_PLUGIN_ASSETS: libexec/"assets"
  end

  test do
    assert_match "relay v#{version}", shell_output("#{bin}/relay --version")
  end
end
`;
}

export function writeRelayHomebrewFormula(options: WriteRelayHomebrewFormulaOptions): string {
  const formulaName = options.formulaName ?? "relay";
  const formulaDir = path.join(options.tapDir, "Formula");
  const formulaPath = path.join(formulaDir, `${formulaName}.rb`);
  mkdirSync(formulaDir, { recursive: true });
  writeFileSync(formulaPath, renderRelayHomebrewFormula(options));
  return formulaPath;
}
