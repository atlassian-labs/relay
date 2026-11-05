#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected="$(tr -d '[:space:]' < "$repo_root/.bun-version")"

if [[ -z "$expected" ]]; then
  echo "error: .bun-version is empty" >&2
  exit 1
fi

bun_version() {
  "$1" --version 2>/dev/null | tr -d '\r\n' || true
}

use_bun() {
  local bun_bin="$1"
  shift
  local bun_dir
  bun_dir="$(dirname "$bun_bin")"
  export PATH="$bun_dir:$PATH"
  exec "$bun_bin" "$@"
}

candidates=()
if [[ -n "${BUN_BIN:-}" ]]; then
  candidates+=("$BUN_BIN")
fi
if command -v bun >/dev/null 2>&1; then
  candidates+=("$(command -v bun)")
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
candidates+=("$BUN_INSTALL/bin/bun")

for candidate in "${candidates[@]}"; do
  if [[ -x "$candidate" && "$(bun_version "$candidate")" == "$expected" ]]; then
    use_bun "$candidate" "$@"
  fi
done

if [[ "${RELAY_BUN_AUTO_INSTALL:-0}" != "1" ]]; then
  actual="$(command -v bun >/dev/null 2>&1 && bun --version 2>/dev/null || true)"
  echo "Relay requires Bun $expected; current runtime is Bun ${actual:-not found}." >&2
  echo "Install it with: curl -fsSL https://bun.sh/install | bash -s -- bun-v$expected" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Relay requires Bun $expected and could not auto-install it because curl is unavailable." >&2
  echo "Install it with: curl -fsSL https://bun.sh/install | bash -s -- bun-v$expected" >&2
  exit 1
fi

echo "Relay requires Bun $expected; installing pinned runtime into $BUN_INSTALL..." >&2
curl -fsSL https://bun.sh/install | bash -s -- "bun-v$expected"

pinned_bun="$BUN_INSTALL/bin/bun"
if [[ ! -x "$pinned_bun" || "$(bun_version "$pinned_bun")" != "$expected" ]]; then
  echo "error: installed Bun does not match required version $expected" >&2
  echo "found: $pinned_bun -> $(bun_version "$pinned_bun")" >&2
  exit 1
fi

use_bun "$pinned_bun" "$@"
