#!/usr/bin/env bash
#
# rotate-and-seal.sh — rotate secrets, apply them, and leave an encrypted backup only YOU can open.
#
# Implements docs/SECRET-HANDLING-PROTOCOL.md. No plaintext secret is ever printed; stdout carries
# fingerprints (sha256 prefixes) and status only. The recoverable backup is encrypted to your GPG
# PUBLIC key, so running this needs no secret from you.
#
# Prereqs (one-time): see docs/SECRET-HANDLING-PROTOCOL.md "One-time setup". You need a GPG keypair;
# this script uses only the public key (recipient).
#
# Usage:
#   GPG_RECIPIENT="Flow-Wiser Secrets" ./scripts/rotate-and-seal.sh            # rotate enc key + pepper
#   GPG_RECIPIENT=... ROTATE=pepper    ./scripts/rotate-and-seal.sh            # pepper only
#
set -euo pipefail

# ---- config (override via env) ----
DOCKER_DIR="${DOCKER_DIR:-/home/dblagbro/docker}"
COMPOSE="${COMPOSE:-$DOCKER_DIR/docker-compose.yml}"
ENVF="${ENVF:-$DOCKER_DIR/.env}"
DB="${DB:-$DOCKER_DIR/config/Flowise/.flowise/database.sqlite}"
SERVICE="${SERVICE:-flowise}"
VAULT="${VAULT:-$HOME/.flow-wiser-secrets-vault}"       # 0700, OUTSIDE any git repo
GPG_RECIPIENT="${GPG_RECIPIENT:?set GPG_RECIPIENT to your GPG key id/email (public key must be imported)}"
ROTATE="${ROTATE:-all}"                                 # all | key | pepper
STAMP="$(date +%Y-%m-%dT%H%M%S)"
fp() { printf '%s' "$1" | sha256sum | cut -c1-16; }     # fingerprint, never the value

echo "== preconditions =="
command -v gpg >/dev/null || { echo "gpg not found"; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found"; exit 1; }
gpg --list-keys "$GPG_RECIPIENT" >/dev/null 2>&1 || { echo "GPG public key for '$GPG_RECIPIENT' not imported"; exit 1; }
[ -f "$ENVF" ] || { echo ".env not found at $ENVF"; exit 1; }
mkdir -p "$VAULT"; chmod 700 "$VAULT"

echo "== backups =="
cp -a "$ENVF" "$ENVF.bak-$STAMP"
[ -f "$COMPOSE" ] && cp -a "$COMPOSE" "$COMPOSE.bak-$STAMP" || true
if command -v sqlite3 >/dev/null && [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$DB.bak-$STAMP'"
  echo "  db backup integrity: $(sqlite3 "$DB.bak-$STAMP" 'PRAGMA integrity_check;' | head -1)"
fi

echo "== read current (not printed) =="
cur_val() { grep -E "^$1=" "$ENVF" | head -1 | sed -E "s/^[^=]*=//" ; }
OLD_ENC="$(cur_val IDENTITY_ENCRYPTION_KEY || true)"
# fall back to compose inline literal if not yet relocated to .env
if [ -z "${OLD_ENC:-}" ] && [ -f "$COMPOSE" ]; then
  OLD_ENC="$(grep -E '^\s*-\s*IDENTITY_ENCRYPTION_KEY=' "$COMPOSE" | head -1 | sed -E 's/^[^=]*=//' || true)"
fi

echo "== generate new secrets (host memory only) =="
NEW_PEP="$(openssl rand -base64 32)"
if [ "$ROTATE" = "pepper" ]; then NEW_ENC=""; else NEW_ENC="$(openssl rand -base64 32)"; fi

echo "== write .env (0600) =="
umask 077
if [ -n "${NEW_ENC:-}" ]; then
  sed -i -E '/^(IDENTITY_ENCRYPTION_KEY|IDENTITY_ENCRYPTION_KEY_VERSION|IDENTITY_ENCRYPTION_KEY_V1)=/d' "$ENVF"
  {
    echo "# rotation $STAMP — encryption key (old retained as V1 for decryption)"
    echo "IDENTITY_ENCRYPTION_KEY=$NEW_ENC"
    echo "IDENTITY_ENCRYPTION_KEY_VERSION=2"
    [ -n "${OLD_ENC:-}" ] && echo "IDENTITY_ENCRYPTION_KEY_V1=$OLD_ENC"
  } >> "$ENVF"
fi
sed -i -E '/^FLOWISE_SESSION_PEPPER=/d' "$ENVF"
echo "FLOWISE_SESSION_PEPPER=$NEW_PEP" >> "$ENVF"
chmod 600 "$ENVF"

echo "== seal an encrypted backup to your GPG public key (only you can open) =="
SEALED="$VAULT/secrets-sealed-$STAMP.asc"
{
  echo "Flow-Wiser sealed secrets — $STAMP"
  [ -n "${NEW_ENC:-}" ] && echo "IDENTITY_ENCRYPTION_KEY=$NEW_ENC"
  [ -n "${NEW_ENC:-}" ] && echo "IDENTITY_ENCRYPTION_KEY_VERSION=2"
  [ -n "${OLD_ENC:-}" ] && echo "IDENTITY_ENCRYPTION_KEY_V1=$OLD_ENC"
  echo "FLOWISE_SESSION_PEPPER=$NEW_PEP"
} | gpg --batch --yes --armor --encrypt --recipient "$GPG_RECIPIENT" --output "$SEALED"
chmod 600 "$SEALED"

echo "== fingerprints (safe to share; not the values) =="
[ -n "${NEW_ENC:-}" ] && echo "  IDENTITY_ENCRYPTION_KEY (v2) fp=$(fp "$NEW_ENC")"
[ -n "${OLD_ENC:-}" ] && echo "  IDENTITY_ENCRYPTION_KEY_V1 (old) fp=$(fp "$OLD_ENC")"
echo "  FLOWISE_SESSION_PEPPER        fp=$(fp "$NEW_PEP")"
echo "  sealed backup: $SEALED"

echo "== recreate the container =="
( cd "$DOCKER_DIR" && docker compose config >/dev/null && sudo docker compose up -d --force-recreate --no-deps "$SERVICE" )

echo "== verify + migrate credentials to the new key =="
sleep 8
docker logs "$SERVICE" 2>&1 | grep -i 'encryption keyring active' | tail -1 | sed 's/^/  /'
if [ -n "${NEW_ENC:-}" ]; then
  docker exec "$SERVICE" sh -c 'cd /usr/src/flowise/packages/server && ./bin/run credential:rotate-encryption --apply' || \
    echo "  NOTE: run credential:rotate-encryption --apply once healthy"
fi

cat <<DONE

== DONE ==
Rotated: $([ -n "${NEW_ENC:-}" ] && echo "IDENTITY_ENCRYPTION_KEY (v2, old kept as V1), " )FLOWISE_SESSION_PEPPER
Sealed backup (only your GPG key opens it): $SEALED
Recover with:  gpg --decrypt "$SEALED"
Rollback:      cp "$ENVF.bak-$STAMP" "$ENVF" $( [ -f "$COMPOSE" ] && echo "&& cp \"$COMPOSE.bak-$STAMP\" \"$COMPOSE\"" ) \
                 && (cd "$DOCKER_DIR" && sudo docker compose up -d --force-recreate --no-deps "$SERVICE")
DONE
