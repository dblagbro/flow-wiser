# Runbook — rotate encryption key / session pepper, and relocate compose secrets

**Last updated: 2026-09-16**

Operator procedure for rotating `IDENTITY_ENCRYPTION_KEY` and `FLOWISE_SESSION_PEPPER` and moving
the inline literal secrets out of `docker-compose.yml` into a `0600` `.env` (SEC-B-08). Written
after the mechanism was verified on a disposable instance; **not yet applied to production** as of
2026-09-16 (the running keyring reports `active=v1`, a single key).

Steps that touch production secrets and containers are operator-run. New key material is generated
**on the host** and must never pass through a transcript, chat, or commit.

## Why it is safe

The identity keyring supports **versioned keys** (`packages/server/src/identity/crypto/keyring.ts`):

-   `IDENTITY_ENCRYPTION_KEY` — active key material.
-   `IDENTITY_ENCRYPTION_KEY_VERSION` — version of the active key (default `1`).
-   `IDENTITY_ENCRYPTION_KEY_V<n>` — a retained key, used for **decryption only**.

A rotation keeps the old key available for decryption, so every stored credential keeps working
through the switch:

1. Move the current value to `IDENTITY_ENCRYPTION_KEY_V1`.
2. Put the new value in `IDENTITY_ENCRYPTION_KEY`, set `IDENTITY_ENCRYPTION_KEY_VERSION=2`.
3. Recreate the container. Old rows still decrypt (via V1); new writes use v2.
4. Run `credential:rotate-encryption --apply` to re-encrypt every row under v2. It round-trips each
   row (decrypt → re-encrypt → decrypt → compare) and **writes nothing if any row fails to decrypt**.
5. Once every row is on v2 (a later `credential:rotate-encryption` dry run reports "nothing to do"),
   `IDENTITY_ENCRYPTION_KEY_V1` can be removed.

`FLOWISE_SESSION_PEPPER` rotation just invalidates existing sessions (users re-login); no
re-encryption needed. `FLOWISE_SECRETKEY_OVERWRITE` (legacy credential key) is **relocated
unchanged** — changing it would break legacy-encrypted credentials.

Verified on a disposable image: the multi-version config boots
(`🔑 encryption keyring active=v2 keys=[v1:…,v2:…]`) and `credential:rotate-encryption` runs.

## Procedure

A ready-to-run script that performs all of this — backups, local key generation (fingerprints
printed, never values), `.env` relocation, compose rewrite to `${refs}`, image retag, single-service
recreate, keyring verification, and `rotate-encryption --apply` — is kept with the deployment, not in
this repo (it embeds host paths). The canonical copy for this instance was authored at
`~/.claude` scratch during the 2026-09 security pass; re-generate it from this runbook if lost.

Manual outline (single-node compose, `flowise` service):

```bash
cd /path/to/docker
cp -a .env ".env.bak-$(date +%F)" && cp -a docker-compose.yml "docker-compose.yml.bak-$(date +%F)"
sqlite3 config/Flowise/.flowise/database.sqlite ".backup 'config/Flowise/.flowise/database.sqlite.bak-$(date +%F)'"

OLD_ENC=$(grep -E '^\s*-\s*IDENTITY_ENCRYPTION_KEY=' docker-compose.yml | head -1 | sed -E 's/^[^=]*=//')
NEW_ENC=$(openssl rand -base64 32); NEW_PEP=$(openssl rand -base64 32)   # stay on this host

# append to .env (0600): new active key + retained V1 + new pepper + relocated secretkey-overwrite
# then replace the inline compose literals with ${IDENTITY_ENCRYPTION_KEY} etc.

docker compose config >/dev/null                                   # validate interpolation first
sudo docker compose up -d --force-recreate --no-deps flowise       # recreate ONLY flowise
docker logs flowise 2>&1 | grep 'encryption keyring active'        # expect active=v2 keys=[v1,v2]
docker exec flowise sh -c 'cd /usr/src/flowise/packages/server && ./bin/run credential:rotate-encryption --apply'
```

## Verify

-   `docker logs flowise | grep 'encryption keyring active'` → `active=v2 keys=[v1:…,v2:…]`.
-   Log in with the existing password (still works — pepper rotation only forces re-login).
-   `credential:rotate-encryption` (dry run) → "Every credential is already encrypted under the
    current key."

## Rollback

```bash
cp .env.bak-<date> .env && cp docker-compose.yml.bak-<date> docker-compose.yml
# if credentials look wrong, also restore the DB:
#   docker compose stop flowise && cp config/Flowise/.flowise/database.sqlite.bak-<date> config/Flowise/.flowise/database.sqlite
sudo docker compose up -d --force-recreate --no-deps flowise
```

## Related

-   `docs/bug-log.md` — SEC-B-08 (compose literal secrets), SEC-B-09 (`TRUST_PROXY`), SEC-B-10 (Docker
    credential-leak path).
-   `packages/server/src/identity/crypto/keyring.ts`, `packages/server/src/commands/credential/rotate-encryption.ts`.
