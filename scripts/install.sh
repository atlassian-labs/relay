#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install Relay from a GitHub Release artifact.

Required:
  RELAY_VERSION=0.1.0

Optional:
  RELAY_GITHUB_REPO=atlassian-labs/relay
  RELAY_RELEASE_BASE_URL=https://github.com/<owner>/<repo>/releases/download/v<version>
  RELAY_INSTALL_DIR=$HOME/.local/share/relay
  RELAY_BIN_DIR=$HOME/.local/bin
USAGE
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

variant() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64) printf 'darwin-arm64\n' ;;
    Linux:x86_64|Linux:amd64) printf 'linux-amd64\n' ;;
    Linux:aarch64|Linux:arm64) printf 'linux-arm64\n' ;;
    *) fail "unsupported platform: $os $arch" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "sha256sum or shasum is required"
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

version="${RELAY_VERSION:-}"
version="${version#v}"
[[ -n "$version" ]] || fail "RELAY_VERSION is required, for example RELAY_VERSION=0.1.0"
[[ "$version" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail "RELAY_VERSION must be a semantic version"

need curl
need tar
need awk

repo="${RELAY_GITHUB_REPO:-atlassian-labs/relay}"
base_url="${RELAY_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download/v${version}}"
base_url="${base_url%/}"
install_dir="${RELAY_INSTALL_DIR:-$HOME/.local/share/relay}"
bin_dir="${RELAY_BIN_DIR:-$HOME/.local/bin}"
variant="$(variant)"
archive="relay-v${version}-${variant}.tar.gz"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

curl -fsSL "$base_url/$archive" -o "$tmp/$archive"
curl -fsSL "$base_url/SHA256SUMS" -o "$tmp/SHA256SUMS"

expected="$(awk -v file="$archive" '$2 == file { print $1 }' "$tmp/SHA256SUMS")"
[[ -n "$expected" ]] || fail "checksum for $archive was not found in SHA256SUMS"
actual="$(sha256 "$tmp/$archive")"
[[ "$actual" == "$expected" ]] || fail "checksum mismatch for $archive"

payload="$tmp/payload"
release_dir="$install_dir/releases/$version/$variant"
mkdir -p "$payload" "$bin_dir" "$(dirname "$release_dir")"
tar -xzf "$tmp/$archive" -C "$payload"
rm -rf "$release_dir"
mv "$payload" "$release_dir"

cat > "$bin_dir/relay" <<SH
#!/usr/bin/env bash
set -euo pipefail
export ATLAS_PLUGIN_ASSETS="$release_dir/assets"
exec "$release_dir/relay" "\$@"
SH
chmod +x "$bin_dir/relay" "$release_dir/relay"

printf 'Installed Relay %s to %s\n' "$version" "$bin_dir/relay"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add this to your shell config: export PATH="%s:$PATH"\n' "$bin_dir" ;;
esac

"$bin_dir/relay" --version
