#!/usr/bin/env bash
# ============================================================
# OpenCortex Memory — Session End Hook
# ============================================================
# Fires at session end. Decides whether this session is worth
# archiving based on length and significance.
#
# Register in Claude Code settings.json:
#   hooks.Stop or hooks.SessionEnd
#
# For OpenCode, register as a plugin that fires on session close.
# ============================================================

if [ -z "${OPENCORTEX_MEMORY_INGEST_CMD:-}" ] \
  && ! command -v cortex >/dev/null 2>&1 \
  && ! command -v brain >/dev/null 2>&1; then
  exit 0
fi

PROJECT=$(basename "$(pwd)")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# ---- Find session content ----

TRANSCRIPT=""
WORK_DIR=""

# PAI MEMORY/WORK
if [ -d "$HOME/.claude/MEMORY/WORK" ]; then
  WORK_DIR=$(ls -td "$HOME/.claude/MEMORY/WORK"/*/ 2>/dev/null | head -1)
  [ -n "$WORK_DIR" ] && [ -f "${WORK_DIR}/THREAD.md" ] && TRANSCRIPT="${WORK_DIR}/THREAD.md"
fi

# Fallback: Claude projects
if [ -z "$TRANSCRIPT" ]; then
  TRANSCRIPT=$(find "$HOME/.claude/projects" -name "*.md" -mmin -30 2>/dev/null | head -1)
fi

[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && exit 0

WORD_COUNT=$(wc -w < "$TRANSCRIPT")

# ---- Decide: archive or skip ----

# Short sessions (<500 words) probably aren't worth archiving
[ "$WORD_COUNT" -lt 500 ] && exit 0

# Check if PAI already captured learnings (avoid double-capture)
# If WORK_DIR has ISC.json and META.yaml, PAI did its thing.
# We still archive the full transcript (PAI captures conclusions,
# we capture the working context that led to them).

# ---- Archive ----

if [ -n "${OPENCORTEX_MEMORY_INGEST_CMD:-}" ]; then
  bash -lc "$OPENCORTEX_MEMORY_INGEST_CMD --file $(printf '%q' "$TRANSCRIPT") --project $(printf '%q' "$PROJECT") --session-id $(printf '%q' "session-${TIMESTAMP}") --source-system opencortex-session --scope personal --tool opencode" \
    > /dev/null 2>&1 &
elif command -v cortex >/dev/null 2>&1; then
  cat "$TRANSCRIPT" | cortex memory capture - \
    -t "Session transcript: ${PROJECT}" \
    -p "$PROJECT" \
    -s personal \
    -k document \
    --source-system opencortex-session \
    --session-id "session-${TIMESTAMP}" \
    --tool opencode \
    > /dev/null 2>&1 &
else
  # Full transcript -> personal scope (background, don't block session close)
  cat "$TRANSCRIPT" | brain archive full \
    -p "$PROJECT" \
    -s "session-${TIMESTAMP}" \
    > /dev/null 2>&1 &

  # If session was significant (>2000 words), also do a rescue -> team scope
  if [ "$WORD_COUNT" -gt 2000 ]; then
    cat "$TRANSCRIPT" | brain archive rescue \
      -p "$PROJECT" \
      -s "session-${TIMESTAMP}" \
      > /dev/null 2>&1 &
  fi
fi

# Sync PAI learnings if they exist
if [ -n "$WORK_DIR" ]; then
  for f in "${WORK_DIR}"/*.md "${WORK_DIR}"/*.json; do
    [ -f "$f" ] || continue
    if command -v cortex >/dev/null 2>&1; then
      cortex memory capture - \
        -t "PAI $(basename "$f" | sed 's/\.[^.]*$//'): ${PROJECT}" \
        -s personal \
        -k finding \
        -p "$PROJECT" \
        --source-system opencortex-session \
        --session-id "session-${TIMESTAMP}" \
        --tool opencode \
        < "$f" \
        > /dev/null 2>&1 &
    elif command -v brain >/dev/null 2>&1; then
      brain capture "$(cat "$f")" \
        -t "PAI $(basename "$f" | sed 's/\.[^.]*$//'): ${PROJECT}" \
        -s personal \
        -k finding \
        -p "$PROJECT" \
        2>/dev/null &
    fi
  done
fi

exit 0
