#!/usr/bin/env bash
# ============================================================
# Brain Trust — Incremental Artifact Sync Hook
# ============================================================
# Syncs new/changed files from PAI MEMORY and Claude projects
# to BrainTrust (S3 + DB artifacts + text entries).
#
# Designed to run at session end and pre-compaction.
# Non-blocking: all work runs in background.
#
# Register alongside existing hooks in settings.json:
#   hooks.Stop and hooks.Notification (compact matcher)
#
# Requires: brain CLI configured with S3_BUCKET + BT_RAW_KEY
# ============================================================

set -euo pipefail

# bail if brain not available or not configured
command -v brain &>/dev/null || exit 0
[ -f "$HOME/.braintrust/config" ] || exit 0
source "$HOME/.braintrust/config"
[ -n "${S3_BUCKET:-}" ] || exit 0
[ -n "${BT_RAW_KEY:-}" ] || exit 0

# ---- Config ----
SYNC_MARKER="$HOME/.braintrust/.last-sync"
PROJECT=$(basename "$(pwd)" 2>/dev/null || echo "unknown")
LOG="$HOME/.braintrust/sync.log"
MAX_FILES=50  # cap per hook invocation to keep it fast

H=(-H "apikey: ${BT_RAW_KEY}" -H "Authorization: Bearer ${BT_KEY}" -H "Content-Type: application/json" -H "Prefer: return=minimal")

# ---- Helpers ----
sha_file() { shasum -a 256 "$1" | awk '{print $1}'; }
log_msg() { echo "$(date +%Y-%m-%dT%H:%M:%S) $1" >> "$LOG"; }

# Preflight: silently skip the entire hook if AWS creds are missing/expired.
# Without this, S3 uploads would fail unnoticed and the sync marker would still
# advance (silently dropping files until the next backfill).
if command -v aws >/dev/null 2>&1; then
  aws_sts_args=()
  [ -n "${AWS_PROFILE:-}" ] && aws_sts_args+=(--profile "$AWS_PROFILE")
  if ! aws sts get-caller-identity "${aws_sts_args[@]}" >/dev/null 2>&1; then
    log_msg "sync-hook: skipping (AWS creds unavailable; run 'aws sso login' to re-enable)"
    exit 0
  fi
fi

detect_tool() {
  case "$1" in
    */MEMORY/WORK/*) echo "pai-algorithm" ;;
    */MEMORY/LEARNING/*) echo "pai-learning" ;;
    */MEMORY/STATE/*) echo "pai-state" ;;
    */MEMORY/VOICE/*) echo "pai-voice" ;;
    */.claude/projects/*/subagents/*) echo "claude-subagent" ;;
    */.claude/projects/*) echo "claude-code" ;;
    *) echo "pai" ;;
  esac
}

detect_repo() {
  echo "$1" | grep -oE '\.claude/projects/[^/]+' | head -1 | sed 's|.*-||'
}

# ---- Find new files since last sync ----
FIND_ARGS=(-type f)
if [ -f "$SYNC_MARKER" ]; then
  FIND_ARGS+=(-newer "$SYNC_MARKER")
fi

NEW_FILES=()
while IFS= read -r f; do
  [ -f "$f" ] && NEW_FILES+=("$f")
done < <(
  { find "$HOME/.claude/MEMORY" "${FIND_ARGS[@]}" 2>/dev/null
    find "$HOME/.claude/projects" -name "*.jsonl" "${FIND_ARGS[@]}" 2>/dev/null
  } | head -n "$MAX_FILES"
)

if [ ${#NEW_FILES[@]} -eq 0 ]; then
  touch "$SYNC_MARKER"
  exit 0
fi

log_msg "sync-hook: ${#NEW_FILES[@]} new files found for project=${PROJECT}"

# ---- Sync in background ----
(
  set +e  # don't exit on errors in background sync
  synced=0
  skipped=0
  failed=0
  DATE_PATH=$(date +%Y/%m/%d)

  for file in "${NEW_FILES[@]}"; do
    sha=$(sha_file "$file")
    size=$(wc -c < "$file" | tr -d ' ')
    mime=$(file --brief --mime-type "$file" 2>/dev/null || echo "application/octet-stream")
    tool=$(detect_tool "$file")
    repo=$(detect_repo "$file")
    basename_f=$(basename "$file")

    # dedup
    dup=$(curl -sf "${BT_URL}/artifacts?source_system=eq.pai&sha256=eq.${sha}&select=id&limit=1" "${H[@]}" 2>/dev/null || echo "[]")
    dup_id=$(echo "$dup" | jq -r '.[0].id // empty' 2>/dev/null)
    if [ -n "$dup_id" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    # S3 upload
    s3_key="${S3_PREFIX:-artifacts}/${OWNER_ID}/${PROJECT}/pai/${DATE_PATH}/${sha}-${basename_f}"
    s3_uri="s3://${S3_BUCKET}/${s3_key}"

    s3_err=$(aws s3api put-object \
      --bucket "$S3_BUCKET" --key "$s3_key" --body "$file" \
      --content-type "$mime" --server-side-encryption "aws:kms" \
      --region "${S3_REGION:-us-east-1}" \
      $([ -n "${AWS_PROFILE:-}" ] && echo "--profile ${AWS_PROFILE}") 2>&1 1>/dev/null) || {
      failed=$((failed + 1))
      log_msg "sync-hook: s3 put-object failed [${basename_f}]: $(printf '%s' "$s3_err" | tr '\n' ' ' | head -c 240)"
      continue
    }

    # artifact record
    curl -sf "${BT_URL}/artifacts" "${H[@]}" \
      -d "$(jq -n \
        --arg ss "pai" --arg sp "$file" --arg pj "$PROJECT" --arg sc "personal" \
        --arg o "$OWNER_ID" --arg sh "$sha" --arg mt "$mime" \
        --arg su "$s3_uri" --arg sk "$s3_key" --argjson sz "$size" \
        --arg tn "$tool" --arg rp "${repo:-}" \
        '{source_system:$ss,source_path:$sp,project:$pj,scope:$sc,
          owner_id:$o,sha256:$sh,size_bytes:$sz,mime_type:$mt,
          storage_uri:$su,storage_key:$sk,tool_name:$tn,
          repo:(if $rp=="" then null else $rp end),
          meta:{source_path:$sp}}')" >/dev/null 2>&1 || true

    # text index
    case "$file" in *.md|*.txt|*.json|*.jsonl|*.yaml|*.yml|*.sh|*.ts|*.js)
      snippet=$(python3 -c "import pathlib,sys; p=pathlib.Path(sys.argv[1]); b=p.read_bytes()[:12000]; print(b.decode('utf-8','replace'))" "$file" 2>/dev/null)
      [ -n "$snippet" ] && curl -sf "${BT_URL}/entries" "${H[@]}" \
        -d "$(jq -n \
          --arg c "$snippet" --arg t "$basename_f" \
          --arg k "document" --arg p "$PROJECT" --arg s "personal" --arg o "$OWNER_ID" \
          --arg h "$sha" --arg ss "pai" --arg tn "$tool" --arg sp "$file" \
          --arg rp "${repo:-}" \
          '{content:$c,title:$t,kind:$k,scope:$s,owner_id:$o,author:"agent",content_hash:$h,
            source_system:$ss,tool_name:$tn,
            repo:(if $rp=="" then null else $rp end),
            project:$p,meta:{source_path:$sp}}')" >/dev/null 2>&1 || true
      ;;
    esac

    synced=$((synced + 1))
  done

  log_msg "sync-hook: synced=${synced} skipped=${skipped} failed=${failed}"

  # update sync marker — only advance when every upload succeeded.
  # Otherwise we'd silently skip the failed files on the next run.
  if [ "$failed" -eq 0 ]; then
    touch "$SYNC_MARKER"
  else
    log_msg "sync-hook: marker NOT advanced (${failed} failure(s)); will retry next run"
  fi

) &

exit 0
