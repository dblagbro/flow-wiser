#!/usr/bin/env bash
# Flow-Wiser — advisory guard for high-risk paths.
#
# Reads a Claude Code PreToolUse hook payload on stdin and warns when a tool call
# targets a path that carries a hard rule. See docs/CLEANROOM-PROTOCOL.md and
# .claude/rules/.
#
# ADVISORY BY DESIGN: always exits 0, so it can never block legitimate work or
# wedge a session. The authoritative enforcement is .githooks/pre-commit (verified
# active) and the CI clean-room guard.
#
# To make it blocking once you are satisfied with its behaviour, change the
# `exit 0` in the licensed-path branch to `exit 2`.
set -uo pipefail

payload=$(cat 2>/dev/null || true)
[ -z "$payload" ] && exit 0

# Extract the target path without requiring jq to be present.
path=""
if command -v jq >/dev/null 2>&1; then
  path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)
fi
if [ -z "$path" ]; then
  path=$(printf '%s' "$payload" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//' || true)
fi
[ -z "$path" ] && exit 0

case "$path" in
  *packages/server/src/enterprise/*|*packages/server/src/IdentityManager.ts)
    cat >&2 <<EOF

  ⚠  CLEAN-ROOM RULE — $path

  This path carries FlowiseAI's Commercial License. Never read, edit, summarise or
  pass it to a model. Deletion is permitted; modification is not.

  The prohibition applies on every branch, tag and historical commit, and is not
  retired by the files being absent from the working tree.

  See docs/CLEANROOM-PROTOCOL.md and docs/decisions/ADR-0002-no-reverse-engineering.md

EOF
    exit 0
    ;;
  *flowise-credentials-backup-*|*/.env|*.sqlite|*.sqlite3|*.pem|*.key)
    cat >&2 <<EOF

  ⚠  SECRET MATERIAL — $path

  Do not read, copy, move, print or commit this file. Report the path only.
  See AGENTS.md §9.

EOF
    exit 0
    ;;
esac

exit 0
