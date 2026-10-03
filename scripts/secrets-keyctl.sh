#!/usr/bin/env bash
# secrets-keyctl.sh — one tool for the whole GPG-sealing lifecycle.
# Implements ~/.claude/protocols/secret-handling/PROTOCOL.md.
#
# YOU run this. Your passphrase is typed to GPG directly (never passed as an argument, never seen by
# the agent). The agent only ever uses the PUBLIC key + fingerprints. Plaintext secrets never go to
# stdout here — only fingerprints and file paths.
#
# Subcommands:
#   init                 create the keypair (gpg prompts for your passphrase) + export the public key
#   status               show key fingerprint, public-key path, and sealed-backup filenames
#   backup-key [FILE]    export your PRIVATE key (armored) to a 0600 FILE you then move offline
#   rotate               run rotate-and-seal.sh (mint new secrets, apply, seal to your public key)
#   reinit               EXPOSURE PROTOCOL: make a NEW keypair, then re-run 'rotate' to re-seal all
#   reset                remove this tool's local key material (asks twice) — start over with init
#   grant VAR [TTL]      decrypt the latest sealed VAR into a transient tmpfs file for the agent to
#                        use BY REFERENCE for TTL seconds (default 300), then auto-shred. Your "approve".
#   revoke               shred all granted transient secrets now
#
# Config (env): KEY_NAME, KEY_EMAIL, PUBKEY_PATH, VAULT, GRANT_DIR
set -euo pipefail
KEY_NAME="${KEY_NAME:-Flow-Wiser Secrets}"
KEY_EMAIL="${KEY_EMAIL:-dblagbro@gmail.com}"
PUBKEY_PATH="${PUBKEY_PATH:-$HOME/.config/flow-wiser-secrets.pub.asc}"
VAULT="${VAULT:-$HOME/.flow-wiser-secrets-vault}"
GRANT_DIR="${GRANT_DIR:-${XDG_RUNTIME_DIR:-/dev/shm}/flow-wiser-grants}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fp(){ printf '%s' "$1" | sha256sum | cut -c1-16; }
command -v gpg >/dev/null || { echo "gpg required"; exit 1; }

cmd="${1:-status}"; shift || true
case "$cmd" in
  init)
    if gpg --list-keys "$KEY_NAME" >/dev/null 2>&1; then
      echo "A key for '$KEY_NAME' already exists. Use 'reinit' to rotate it, or 'reset' first."; exit 1; fi
    echo "Creating keypair for '$KEY_NAME <$KEY_EMAIL>'. GPG will prompt for YOUR passphrase."
    gpg --quick-generate-key "$KEY_NAME <$KEY_EMAIL>" rsa4096 cert,encr never
    mkdir -p "$(dirname "$PUBKEY_PATH")"
    gpg --armor --export "$KEY_NAME" > "$PUBKEY_PATH"
    echo "Public key exported: $PUBKEY_PATH"
    gpg --list-keys --with-colons "$KEY_NAME" | awk -F: '/^fpr:/{print "  fpr "$10; exit}'
    echo "NEXT: run '$0 backup-key' and store the output somewhere only you control."
    ;;
  status)
    if gpg --list-keys "$KEY_NAME" >/dev/null 2>&1; then
      echo "key: present"; gpg --list-keys --with-colons "$KEY_NAME" | awk -F: '/^fpr:/{print "  fpr "$10; exit}'
      echo "  public key file: $([ -f "$PUBKEY_PATH" ] && echo "$PUBKEY_PATH" || echo "MISSING — run init")"
    else echo "key: NONE — run '$0 init'"; fi
    echo "vault: $VAULT"
    ls -1 "$VAULT"/secrets-sealed-*.asc 2>/dev/null | sed 's#.*/#  #' || echo "  (no sealed backups yet)"
    echo "grants dir: $GRANT_DIR"; ls -1 "$GRANT_DIR" 2>/dev/null | sed 's/^/  grant: /' || true
    ;;
  backup-key)
    OUT="${1:-$HOME/${KEY_NAME// /-}-PRIVATE-$(date +%F).asc}"
    ( umask 077; gpg --armor --export-secret-keys "$KEY_NAME" > "$OUT" ); chmod 600 "$OUT"
    echo "PRIVATE key written to: $OUT"
    echo "MOVE it offline / into your password manager, then delete it from here. Never share it."
    ;;
  rotate)  GPG_RECIPIENT="$KEY_NAME" VAULT="$VAULT" "$SCRIPT_DIR/rotate-and-seal.sh" "$@" ;;
  reinit)
    echo "EXPOSURE PROTOCOL: rotating the keypair itself."
    gpg --quick-generate-key "$KEY_NAME <$KEY_EMAIL>" rsa4096 cert,encr never
    gpg --armor --export "$KEY_NAME" > "$PUBKEY_PATH"
    echo "New keypair created, public key re-exported. NOW run '$0 rotate' to re-seal every secret to"
    echo "the new key, then delete old sealed backups and retire/revoke the old key."
    ;;
  reset)
    read -r -p "Remove local key material for '$KEY_NAME'? type DELETE: " a; [ "$a" = DELETE ] || { echo aborted; exit 1; }
    read -r -p "Sure? you need your offline backup to recover sealed secrets. type YES: " b; [ "$b" = YES ] || { echo aborted; exit 1; }
    FPR=$(gpg --list-keys --with-colons "$KEY_NAME" | awk -F: '/^fpr:/{print $10; exit}')
    [ -n "$FPR" ] && gpg --batch --yes --delete-secret-and-public-key "$FPR" || echo "no key found"
    echo "removed. run '$0 init' to start over."
    ;;
  grant)
    VAR="${1:?usage: grant VAR [ttl]}"; TTL="${2:-300}"
    SEALED=$(ls -t "$VAULT"/secrets-sealed-*.asc 2>/dev/null | head -1)
    [ -n "$SEALED" ] || { echo "no sealed backup in $VAULT"; exit 1; }
    mkdir -p "$GRANT_DIR"; chmod 700 "$GRANT_DIR"
    VAL="$(gpg --decrypt "$SEALED" 2>/dev/null | awk -F= -v k="$VAR" '$1==k{sub(/^[^=]*=/,"");print;exit}')"
    [ -n "$VAL" ] || { echo "VAR '$VAR' not found in latest sealed backup"; exit 1; }
    ( umask 077; printf '%s' "$VAL" > "$GRANT_DIR/$VAR" ); chmod 600 "$GRANT_DIR/$VAR"
    ( sleep "$TTL"; shred -u "$GRANT_DIR/$VAR" 2>/dev/null || rm -f "$GRANT_DIR/$VAR" ) >/dev/null 2>&1 &
    echo "granted $VAR (fp=$(fp "$VAL")) -> $GRANT_DIR/$VAR  (auto-shred in ${TTL}s)"
    echo "agent reads BY REFERENCE only, e.g.  export $VAR=\"\$(cat $GRANT_DIR/$VAR)\"  — never printed."
    ;;
  revoke)
    if [ -d "$GRANT_DIR" ]; then find "$GRANT_DIR" -type f -exec shred -u {} \; 2>/dev/null || true; fi
    echo "all grants cleared."
    ;;
  *) grep -E '^#' "$0" | sed 's/^#\s\{0,1\}//' ;;
esac
