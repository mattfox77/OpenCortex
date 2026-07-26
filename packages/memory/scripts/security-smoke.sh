#!/usr/bin/env bash
# ============================================================
# Brain Trust Security Smoke Test
# ============================================================
# Validates baseline policy behavior against local compose stack:
# - owner insert allowed
# - cross-owner insert denied
# - personal-row visibility isolation
# - provision denied for non-admin key
#
# Usage:
#   ./security-smoke.sh
#   ./security-smoke.sh --bt-dir /opt/braintrust
# ============================================================

set -euo pipefail

BT_DIR="/opt/braintrust"
DB_CONTAINER_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bt-dir) BT_DIR="$2"; shift 2 ;;
    --db-container) DB_CONTAINER_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--bt-dir /opt/braintrust] [--db-container CONTAINER]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

[ -f "${BT_DIR}/config/server.env" ] || { echo "Missing ${BT_DIR}/config/server.env" >&2; exit 1; }

source "${BT_DIR}/config/server.env"

if [ -n "${DB_CONTAINER_OVERRIDE}" ]; then
  DB_CONTAINER="${DB_CONTAINER_OVERRIDE}"
elif docker compose version >/dev/null 2>&1; then
  DB_CONTAINER=$(cd "${BT_DIR}" && docker compose ps -q db)
else
  echo "Docker compose unavailable. Use --db-container CONTAINER." >&2
  exit 1
fi

[ -n "${DB_CONTAINER}" ] || { echo "Database container not found. Is compose up?" >&2; exit 1; }

run_sql() {
  docker exec -i "${DB_CONTAINER}" \
    psql -q -v ON_ERROR_STOP=1 -U "${BT_DB_USER}" -d braintrust -tAc "$1"
}

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1" >&2
}

check_success() {
  local name="$1"
  local sql="$2"
  if run_sql "$sql" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_failure() {
  local name="$1"
  local sql="$2"
  if run_sql "$sql" >/dev/null 2>&1; then
    fail "$name"
  else
    pass "$name"
  fi
}

RAND=$(date +%s)
OWNER_A="smoke_owner_a_${RAND}"
OWNER_B="smoke_owner_b_${RAND}"
MEMBER_KEY_A="smoke-key-a-${RAND}"
MEMBER_KEY_B="smoke-key-b-${RAND}"
ADMIN_KEY="smoke-admin-key-${RAND}"
ENTRY_A_TITLE="smoke-row-a-${RAND}"
ENTRY_B_TITLE="smoke-row-b-${RAND}"

cleanup() {
  run_sql "DELETE FROM entries WHERE owner_id IN ('${OWNER_A}', '${OWNER_B}')" >/dev/null 2>&1 || true
  run_sql "DELETE FROM keys WHERE owner_id IN ('${OWNER_A}', '${OWNER_B}')" >/dev/null 2>&1 || true
}
trap cleanup EXIT

run_sql "INSERT INTO keys (hash, owner_id, name, role)
  VALUES
    (encode(digest('${MEMBER_KEY_A}', 'sha256'), 'hex'), '${OWNER_A}', 'Smoke Member A', 'member'),
    (encode(digest('${MEMBER_KEY_B}', 'sha256'), 'hex'), '${OWNER_B}', 'Smoke Member B', 'member'),
    (encode(digest('${ADMIN_KEY}', 'sha256'), 'hex'), '${OWNER_A}', 'Smoke Admin', 'admin')"

run_sql "INSERT INTO entries (content, title, kind, scope, owner_id, author, review)
  VALUES
    ('seed a', '${ENTRY_A_TITLE}', 'finding', 'personal', '${OWNER_A}', 'user', 'approved'),
    ('seed b', '${ENTRY_B_TITLE}', 'finding', 'personal', '${OWNER_B}', 'user', 'approved')"

check_success "owner insert allowed" "
BEGIN;
SET LOCAL ROLE braintrust_api;
SELECT set_config('request.headers', '{\"apikey\":\"${MEMBER_KEY_A}\"}', true);
INSERT INTO entries (content, title, kind, scope, owner_id, author, review)
VALUES ('ok', 'smoke-insert-ok-${RAND}', 'finding', 'personal', '${OWNER_A}', 'user', 'approved');
ROLLBACK;"

check_failure "cross-owner insert denied" "
BEGIN;
SET LOCAL ROLE braintrust_api;
SELECT set_config('request.headers', '{\"apikey\":\"${MEMBER_KEY_A}\"}', true);
INSERT INTO entries (content, title, kind, scope, owner_id, author, review)
VALUES ('deny', 'smoke-insert-deny-${RAND}', 'finding', 'personal', '${OWNER_B}', 'user', 'approved');
ROLLBACK;"

VISIBLE_RAW=$(run_sql "
BEGIN;
SET LOCAL ROLE braintrust_api;
SELECT set_config('request.headers', '{\"apikey\":\"${MEMBER_KEY_A}\"}', true);
SELECT count(*)
FROM entries
WHERE title IN ('${ENTRY_A_TITLE}', '${ENTRY_B_TITLE}')
  AND scope = 'personal';
ROLLBACK;")

VISIBLE_COUNT=$(printf "%s\n" "${VISIBLE_RAW}" | awk 'END{print}' | tr -d '[:space:]')

if [ "${VISIBLE_COUNT}" = "1" ]; then
  pass "personal visibility isolated"
else
  echo "  observed personal visibility count: ${VISIBLE_COUNT}" >&2
  fail "personal visibility isolated"
fi

check_failure "member cannot provision" "
BEGIN;
SET LOCAL ROLE braintrust_api;
SELECT set_config('request.headers', '{\"apikey\":\"${MEMBER_KEY_A}\"}', true);
SELECT provision('smoke-new-${RAND}', 'Smoke New', 'member');
ROLLBACK;"

echo ""
echo "Security smoke summary: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi

exit 0
