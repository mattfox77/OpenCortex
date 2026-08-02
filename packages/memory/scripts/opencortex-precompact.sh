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

# Check if memory capture is available
if ! command -v cortex >/dev/null 2>&1; then
  exit 0
fi

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
  exit 0
fi

WORD_COUNT=$(wc -w < "$TRANSCRIPT")

# Only archive if substantial (>500 words of context worth saving)
if [ "$WORD_COUNT" -lt 500 ]; then
  exit 0
fi

cat "$TRANSCRIPT" | cortex memory capture - \
  -t "Pre-compaction archive: ${PROJECT}" \
  -p "$PROJECT" \
  -s personal \
  -k document \
  --source-system opencortex-precompact \
  --session-id "precompact-${TIMESTAMP}" \
  --tool claude-code \
  > /dev/null 2>&1 &

exit 0
