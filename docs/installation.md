# Installing Relay

Relay's public install commands are draft-only until OSR approval is complete and the public GitHub repository exists.

Replace `0.1.0` with the release version you want to install. All release artifacts are expected to come from GitHub Releases and are verified with `SHA256SUMS`.

## macOS

Homebrew is the preferred macOS package-manager path:

```sh
brew tap atlassian-labs/relay
brew install relay
relay --version
```

The installer script is the direct GitHub Releases path:

```sh
export RELAY_VERSION=0.1.0
curl -fsSL https://raw.githubusercontent.com/atlassian-labs/relay/main/scripts/install.sh | bash
relay --version
```

## Linux

Use the installer script:

```sh
export RELAY_VERSION=0.1.0
curl -fsSL https://raw.githubusercontent.com/atlassian-labs/relay/main/scripts/install.sh | bash
relay --version
```

The script installs to `~/.local/share/relay` and writes the `relay` command to `~/.local/bin` by default. Override those locations when needed:

```sh
export RELAY_VERSION=0.1.0
export RELAY_INSTALL_DIR="$HOME/.local/share/relay"
export RELAY_BIN_DIR="$HOME/.local/bin"
curl -fsSL https://raw.githubusercontent.com/atlassian-labs/relay/main/scripts/install.sh | bash
```

## Windows

Use the PowerShell installer:

```powershell
$env:RELAY_VERSION = "0.1.0"
irm https://raw.githubusercontent.com/atlassian-labs/relay/main/scripts/install.ps1 | iex
relay --version
```

The script installs to `$HOME\.local\share\relay` and writes `relay.cmd` and `relay.ps1` to `$HOME\.local\bin` by default. Override those locations when needed:

```powershell
$env:RELAY_VERSION = "0.1.0"
$env:RELAY_INSTALL_DIR = "$HOME\.local\share\relay"
$env:RELAY_BIN_DIR = "$HOME\.local\bin"
irm https://raw.githubusercontent.com/atlassian-labs/relay/main/scripts/install.ps1 | iex
```

## Manual GitHub Releases Install

Download the archive and `SHA256SUMS` from the release page:

```text
https://github.com/atlassian-labs/relay/releases
```

Choose the archive for your platform:

```text
relay-v0.1.0-darwin-arm64.tar.gz
relay-v0.1.0-linux-amd64.tar.gz
relay-v0.1.0-linux-arm64.tar.gz
relay-v0.1.0-windows-amd64.tar.gz
```

Verify the checksum before installing:

```sh
shasum -a 256 relay-v0.1.0-darwin-arm64.tar.gz
grep 'relay-v0.1.0-darwin-arm64.tar.gz' SHA256SUMS
```

Extract the archive into a versioned directory and create a command shim that points Relay at its bundled assets:

```sh
mkdir -p "$HOME/.local/share/relay/releases/0.1.0/darwin-arm64" "$HOME/.local/bin"
tar -xzf relay-v0.1.0-darwin-arm64.tar.gz -C "$HOME/.local/share/relay/releases/0.1.0/darwin-arm64"
cat > "$HOME/.local/bin/relay" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
release_dir="$HOME/.local/share/relay/releases/0.1.0/darwin-arm64"
export ATLAS_PLUGIN_ASSETS="$release_dir/assets"
exec "$release_dir/relay" "$@"
SH
chmod +x "$HOME/.local/bin/relay"
```

On Windows, extract `relay-v0.1.0-windows-amd64.tar.gz` and create `relay.cmd` that sets `ATLAS_PLUGIN_ASSETS` before launching `relay.exe`.

## Specific Versions and Rollback

Install a specific version by setting `RELAY_VERSION`:

```sh
export RELAY_VERSION=0.1.0
curl -fsSL https://raw.githubusercontent.com/atlassian-labs/relay/main/scripts/install.sh | bash
```

To roll back, rerun the installer with an older version. The command shim is replaced to point at that version's release directory.

## Telemetry

The public GitHub build must use Relay's external telemetry policy before the first public release. That policy sends a stable anonymous ID stored under Relay's config directory and honors either opt-out flag:

```sh
export DO_NOT_TRACK=1
export RELAY_TELEMETRY_DISABLED=1
```

The internal Bitbucket/Atlas build keeps its internal telemetry policy until the public repository and release process are approved.
