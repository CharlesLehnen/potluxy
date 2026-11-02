#!/usr/bin/env bash
# Spin up a throwaway Postgres, load the ORIGINAL 2025 schema + legacy data, apply
# every migration twice (idempotency), then run the security tests. Finally build a
# second database from code/supabase_config.sql alone and check both schemas match.
# Usage: run_db_tests.sh [--env potluxy] [--port 54329] [--keep]
set -euo pipefail

ENV_NAME=potluxy
PORT=54329
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
DATA="$(mktemp -d)"
run() { conda run --no-capture-output -n "$ENV_NAME" "$@"; }
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(run psql -h "$DATA" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)

cleanup() {
  run pg_ctl -D "$DATA/db" -m immediate stop >/dev/null 2>&1 || true
  [[ $KEEP -eq 1 ]] && echo "Kept data dir: $DATA" || rm -rf "$DATA"
}
trap cleanup EXIT

run initdb -D "$DATA/db" -U postgres -A trust >/dev/null
run pg_ctl -D "$DATA/db" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null
"${PSQL[@]}" -d postgres -c "CREATE DATABASE potluxy_test"

DB=("${PSQL[@]}" -d potluxy_test)
"${DB[@]}" -f "$HERE/stub_supabase.sql"

# The original schema uses syntax/extensions only the hosted DB accepts.
sed -e 's/CREATE POLICY IF NOT EXISTS/CREATE POLICY/' \
    -e '/pg_cron/d' \
    "$REPO/archive/supabase_config_original_2025.sql" > "$DATA/base.sql"
"${DB[@]}" -f "$DATA/base.sql" >/dev/null
"${DB[@]}" -f "$HERE/seed_legacy.sql"

for f in "$REPO"/code/migrations/*.sql; do
  echo "Applying $(basename "$f") (twice)"
  "${DB[@]}" -f "$f" >/dev/null
  "${DB[@]}" -f "$f" >/dev/null
done

PGOPTIONS="-c client_min_messages=notice" "${DB[@]}" -o /dev/null -f "$HERE/test_security.sql" 2>&1 \
  | sed -e 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' -e '/^CONTEXT:/d'

# ---- code/supabase_config.sql must equal "original + all migrations" -------------
echo "Checking code/supabase_config.sql matches original schema + migrations"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE potluxy_fresh"
FRESH=("${PSQL[@]}" -d potluxy_fresh)
"${FRESH[@]}" -f "$HERE/stub_supabase.sql"
sed -e '/pg_cron/d' "$REPO/code/supabase_config.sql" > "$DATA/fresh.sql"
"${FRESH[@]}" -f "$DATA/fresh.sql" >/dev/null
dump() {
  run pg_dump -h "$DATA" -p "$PORT" -U postgres --schema-only --no-owner \
    -n public -n private -T 'private.backup_*' "$1" | tr -d '\r' | grep -Ev -e '^--' -e '^\\(un)?restrict ' -e '^[[:space:]]*$'
}
dump potluxy_test > "$DATA/upgraded.schema"
dump potluxy_fresh > "$DATA/fresh.schema"
if ! diff -u "$DATA/upgraded.schema" "$DATA/fresh.schema" > "$DATA/schema.diff"; then
  echo "FAIL: code/supabase_config.sql is out of sync with code/migrations/ (- upgraded, + fresh):"
  head -80 "$DATA/schema.diff"
  exit 1
fi
echo "  pass: fresh install is identical to upgraded database"
echo "ALL DB TESTS PASSED"
