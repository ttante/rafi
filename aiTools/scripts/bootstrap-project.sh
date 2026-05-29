#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bootstrap-project.sh [target-repo] [options]

Copies shared AI agent rules and starter documentation into a project repo.

Arguments:
  target-repo        Target repository path. Defaults to the current directory.

Options:
  --force           Overwrite existing target files.
  --no-docs         Copy agent instruction files only.
  --no-copilot      Skip .github/copilot-instructions.md.
  -h, --help        Show this help.

By default, existing files are skipped so user work is not overwritten.
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_ROOT="."
FORCE=false
COPY_DOCS=true
COPY_COPILOT=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
    --no-docs)
      COPY_DOCS=false
      shift
      ;;
    --no-copilot)
      COPY_COPILOT=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      TARGET_ROOT="$1"
      shift
      ;;
  esac
done

TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"

copy_file() {
  local source_path="$1"
  local relative_target="$2"
  local target_path="$TARGET_ROOT/$relative_target"

  if [[ -e "$target_path" && "$FORCE" != true ]]; then
    echo "skip  $relative_target"
    return
  fi

  mkdir -p "$(dirname "$target_path")"
  cp "$source_path" "$target_path"
  echo "copy  $relative_target"
}

copy_agent_files() {
  copy_file "$SOURCE_ROOT/agent-files/AGENTS.md" "AGENTS.md"
  copy_file "$SOURCE_ROOT/agent-files/CLAUDE.md" "CLAUDE.md"
  copy_file "$SOURCE_ROOT/agent-files/GEMINI.md" "GEMINI.md"

  if [[ "$COPY_COPILOT" == true ]]; then
    copy_file "$SOURCE_ROOT/agent-files/.github/copilot-instructions.md" ".github/copilot-instructions.md"
  fi
}

copy_docs() {
  copy_file "$SOURCE_ROOT/CHANGELOG.md" "CHANGELOG.md"
  copy_file "$SOURCE_ROOT/.env.example" ".env.example"

  while IFS= read -r source_path; do
    local relative_path="${source_path#$SOURCE_ROOT/}"
    copy_file "$source_path" "$relative_path"
  done < <(find "$SOURCE_ROOT/docs" -type f | sort)
}

echo "Bootstrapping AI project rules into: $TARGET_ROOT"
copy_agent_files

if [[ "$COPY_DOCS" == true ]]; then
  copy_docs
fi

echo "Done."
