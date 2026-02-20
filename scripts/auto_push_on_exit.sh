#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/Users/bailey/Codex Projects/bb-course-intel-extension"
LOCK_DIR="/tmp/bb_course_intel_auto_push.lock"
LOG_FILE="/tmp/bb_course_intel_auto_push.log"

{
  if [[ -d "$LOCK_DIR" ]]; then
    exit 0
  fi
  mkdir "$LOCK_DIR"
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

  if [[ ! -d "$REPO_DIR/.git" ]]; then
    exit 0
  fi

  cd "$REPO_DIR"

  # Skip if there is nothing to commit.
  if [[ -z "$(git status --porcelain)" ]]; then
    exit 0
  fi

  git add -A
  git commit -m "auto-sync: $(date '+%Y-%m-%d %H:%M:%S %z')" || exit 0
  git push origin main
} >>"$LOG_FILE" 2>&1
