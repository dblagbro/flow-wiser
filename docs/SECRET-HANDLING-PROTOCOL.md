# Secret-handling protocol — generate, apply, seal (no plaintext in chat/logs)

**Last updated: 2026-10-03**

How secrets (encryption keys, session peppers, tokens) are generated, applied to the running
system, and backed up — **without any plaintext secret ever appearing in a chat transcript, an
agent's output, a log, or git**, while leaving a recoverable, encrypted backup that **only the
operator** can open.

## Roles and the hard boundary

-   **Operator (you):** holds a GPG **private key**. This is the one secret you guard. It never leaves
    your control (ideally a hardware token or a password manager). It is **never shared with the agent,
    ever** — the protocol is designed so it never needs to be.
-   **Agent (Claude Code):** may **seal** secrets by encrypting them to your GPG **public key** (which
    is not secret), orchestrate rotation, and verify by **fingerprint** (a SHA-256 prefix). The agent
    **must never** print, commit, or log a plaintext secret or your private key. If a task appears to
    require the agent to see a plaintext secret, the task is wrong — stop and reconsider.

Because sealing uses only your **public** key, the agent can produce an encrypted backup at any time
with **no secret input from you**. You "grant access" only by decrypting a sealed file yourself, when
you need the value.

## One-time setup (operator)

1.  Generate a keypair dedicated to this project (private key protected by a strong passphrase):

    gpg --quick-generate-key "Flow-Wiser Secrets <dblagbro@gmail.com>" rsa4096 cert,encr never

2.  Note the key id / fingerprint:

    gpg --list-keys --keyid-format=long "Flow-Wiser Secrets"

3.  Export the **public** key (safe to store in the repo or alongside the script):

    gpg --armor --export "Flow-Wiser Secrets" > /home/dblagbro/.config/flow-wiser-secrets.pub.asc

4.  **Back up the PRIVATE key** somewhere you alone control (password manager entry, hardware token,
    or an offline encrypted drive). This is the only thing standing between you and your secrets:

        gpg --armor --export-secret-keys "Flow-Wiser Secrets"   # store the output securely, offline

Give the agent only the **public** key path or recipient id. Never the private key, never the
passphrase.

## Routine rotation (what `scripts/rotate-and-seal.sh` does)

1. Generates new secret material **on the host** (`openssl rand`), held only in shell memory.
2. Applies it: writes to the `0600` `.env`, keeping the old encryption key as
   `IDENTITY_ENCRYPTION_KEY_V1` so stored credentials keep decrypting (see
   `RUNBOOK-secret-rotation.md`).
3. **Seals a backup**: pipes the new-secret bundle straight into
   `gpg --encrypt --recipient <your pubkey>` → `secrets-sealed-<timestamp>.asc` in a `0700` vault
   dir **outside** the repo. No plaintext temp file is ever written.
4. Prints **only fingerprints** (`sha256 | cut -c1-16`) so you and the agent can confirm "same key"
   without the key.
5. Recreates the container and runs `credential:rotate-encryption --apply`.

The plaintext secrets exist only in the `0600` `.env` (already the system's secret store) and inside
the sealed `.asc`. Neither the chat, the agent's output, nor git ever contains them.

## Recovery (operator, when you need a value)

    gpg --decrypt /path/to/vault/secrets-sealed-<timestamp>.asc

Only your private key (+ passphrase) opens it.

## Exposure protocol — "if I ever share the key, change it and all it unlocked"

If your GPG **private key or its passphrase** is ever exposed, disclosed, or even suspected:

1. Generate a **new** GPG keypair (new setup, above).
2. **Rotate every secret** that was ever sealed under the old key — run `rotate-and-seal.sh`, which
   mints fresh secrets and seals them to the new public key.
3. Revoke/retire the old GPG key and delete old sealed `.asc` backups (they protect now-rotated
   secrets, but retire them to avoid confusion).

Because secrets are rotated whenever the sealing key changes, a compromised unlock key never yields
anything still in use. This is the same versioned-key discipline the product's own credential
keyring uses (`identity/crypto/keyring.ts`).

## What is never done

-   No plaintext secret in chat, agent output, commit message, PR, or log — only fingerprints.
-   The agent never receives the private key or any passphrase.
-   Sealed backups and `.env` files are never committed (enforced by `.gitignore` / `.dockerignore` /
    pre-push; see AGENTS.md §9).
