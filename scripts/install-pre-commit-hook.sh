#!/usr/bin/env bash
set -euo pipefail

if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "pre-commit hook not installed: not inside a Git worktree" >&2
  exit 0
fi

readonly repo_root
readonly tracked_hook="${repo_root}/scripts/hooks/pre-commit"

if [[ ! -x "${tracked_hook}" ]]; then
  echo "pre-commit hook template is missing or not executable: ${tracked_hook}" >&2
  exit 1
fi

if [[ "$(git -C "${repo_root}" config --get core.hooksPath || true)" == "scripts/hooks" ]]; then
  exit 0
fi

git -C "${repo_root}" config core.hooksPath scripts/hooks
printf 'pre-commit hooks path set to scripts/hooks\n'
printf 'pre-commit hook uses tracked file %s\n' "${tracked_hook}"
