#!/usr/bin/env bash
# PostToolUse: auto-format an edited web file with Biome.
# Format-only (no lint rewrites) so edits stay predictable and match CI/biome.json.
# Always exits 0 — formatting is best-effort and must never block a tool call.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty')"

[ -z "$file" ] && exit 0

# Only touch files inside the web app (matches biome.json's scope).
case "$file" in
  *apps/web/*) ;;
  *) exit 0 ;;
esac

# Only formats file types Biome handles.
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

bunx --bun @biomejs/biome format --write "$file" >/dev/null 2>&1 || true
exit 0
