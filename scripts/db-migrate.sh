#!/usr/bin/env bash
# Apply the repository's canonical schema baseline to a Supabase/Postgres database.
#
# The baseline is the source of truth for a new self-hosted installation. Do not
# replace this with `supabase db push`: the earliest migrations are historical
# stubs and a fresh project would appear to migrate while remaining incomplete.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"

URL="${SUPABASE_DB_URL:-}"
if [ -z "$URL" ]; then
  for file in "$ROOT/.env.local" "$ROOT/.env"; do
    if [ -f "$file" ]; then
      URL="$(grep -E '^SUPABASE_DB_URL=' "$file" | head -1 | cut -d= -f2- || true)"
      [ -n "$URL" ] && break
    fi
  done
fi

if [ -z "$URL" ]; then
  echo "FATAL: SUPABASE_DB_URL ausente (configure no ambiente, .env.local ou .env)" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "FATAL: psql não está instalado ou não está no PATH" >&2
  exit 1
fi
if [ ! -f "$BASELINE" ]; then
  echo "FATAL: baseline ausente: $BASELINE" >&2
  exit 1
fi

echo "==> habilitando extensões necessárias"
psql "$URL" -v ON_ERROR_STOP=1 -q -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'

echo "==> aplicando supabase/baseline.sql"
psql "$URL" -v ON_ERROR_STOP=1 -f "$BASELINE"
echo "==> schema pi-native-crm aplicado"
