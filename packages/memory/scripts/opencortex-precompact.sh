#!/usr/bin/env bash
# ============================================================
# OpenCortex Memory — Pre-Compaction Hook (Claude Code)
# ============================================================
# Register in ~/.claude/settings.json under hooks.Notification:
#
#   "hooks": {
#     "Notification": [{
#       "matcher": "compact",
#       "hooks": [{
#         "type": "command",
#         "command": "bash ~/.claude/hooks/opencortex-precompact.sh"
#       }]
#     }]
#   }
#
# Also register as a Stop hook for session-end archival:
#
#   "hooks": {
#     "Stop": [{
#       "hooks": [{
#         "type": "command",
#         "command": "bash ~/.claude/hooks/opencortex-session-end.sh '$TRANSCRIPT'"
#       }]
#     }]
#   }
#
# ============================================================

# ---- Pre-compaction: save what's about to be crushed ----

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT=$(basename "$(pwd)")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Check if brain is available
command -v brain &>/dev/null || exit 0

# Find the current session transcript
TRANSCRIPT=""

# PAI MEMORY/WORK — most reliable source
if [ -d "$HOME/.claude/MEMORY/WORK" ]; then
  LATEST_WORK=$(ls -td "$HOME/.claude/MEMORY/WORK"/*/ 2>/dev/null | head -1)
  if [ -n "$LATEST_WORK" ] && [ -f "${LATEST_WORK}/THREAD.md" ]; then
    TRANSCRIPT="${LATEST_WORK}/THREAD.md"
  fi
fi

# Claude Code projects directory — fallback
if [ -z "$TRANSCRIPT" ] && [ -d "$HOME/.claude/projects" ]; then
  TRANSCRIPT=$(find "$HOME/.claude/projects" -name "*.md" -type f -mmin -10 2>/dev/null | head -1)
fi

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  # No transcript found — archive what we can via auto
  brain archive auto 2>/dev/null &
  exit 0
fi

WORD_COUNT=$(wc -w < "$TRANSCRIPT")

# Only archive if substantial (>500 words of context worth saving)
if [ "$WORD_COUNT" -lt 500 ]; then
  exit 0
fi

# Run rescue in background (don't block the compaction)
cat "$TRANSCRIPT" | brain archive rescue \
  -p "$PROJECT" \
  -s "precompact-${TIMESTAMP}" \
  > /dev/null 2>&1 &

# Log it
brain log "Pre-compaction archive: ${PROJECT} (${WORD_COUNT} words)" \
  --type milestone \
  -p "$PROJECT" \
  2>/dev/null &

exit 0
