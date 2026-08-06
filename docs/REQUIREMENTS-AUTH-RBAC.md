# Requirements — Auth & RBAC (Apache-2.0 replacement)

Governed by [CLEANROOM-PROTOCOL.md](CLEANROOM-PROTOCOL.md). Implementers must not read
`packages/server/src/enterprise/` or `IdentityManager.ts`.

## Objective

Replace the 127 commercially-licensed files with original Apache-2.0 work so Flow-Wiser
becomes **100% open source and freely redistributable** — currently 94.67% by file count,
95.58% by lines.

**Explicit goal: different and better, not equivalent.** We satisfy the same UI contract.
We do not reproduce their design, and we improve on it wherever we can.

## The UI is kept verbatim — and that is free

`packages/ui` contains **zero** commercially-licensed files. It is Apache 2.0 and we have
full rights to keep, use and modify it.

So "the same UI as the original" is not a target to engineer toward — it is the starting
point, retained unchanged. **Existing Apache-2.0 views we keep as-is:**

```
packages/ui/src/views/auth/          packages/ui/src/views/users/
packages/ui/src/views/roles/         packages/ui/src/views/organization/
packages/ui/src/views/workspace/     packages/ui/src/views/account/
```

The client already implements login, user management, role editing and workspace
switching. **We are replacing the server behind it, not the screens in front of it.**
The UI is therefore also the authoritative interface specification.

## Contract we must satisfy

Derived exclusively from Apache-2.0 sources (`docs/SPEC-AUTH-RBAC.md` carries citations):

| Source | Defines |
| --- | --- |
| `packages/ui/src/api/auth.js` | `POST /auth/login`, `POST /auth/resolve`, `GET /auth/permissions/:type`, `GET /auth/sso-success` |
| `packages/ui/src/api/role.js` | `GET|POST|PUT|DELETE /role`, `GET /auth/roles/:id`, `GET /auth/roles/name/:name` |
| `packages/ui/src/api/user.js` | `GET|PUT /user`, `GET|PUT /organizationuser` |
| `packages/ui/src/api/workspace.js`, `account.api.js`, `loginmethod.js`, `oauth2.js` | account, workspace, login-method, OAuth2 surfaces |
| `packages/server/src/routes/**` | 120 `checkPermission` / `checkAnyPermission` call sites (70 + 50, across 22 files) — middleware contract + permission vocabulary |

**The permission middleware is tiny.** The enforcement surface is ~50 LOC and **120 route
call-sites are already wired in Apache-2.0 code** (70 `checkPermission` + 50
`checkAnyPermission`, forming 65 distinct expressions across 22 files). We implement the
function; the wiring exists.

**The permission vocabulary is recoverable without touching protected files.** Scraped
independently from Apache-2.0 sources: **82** distinct permissions — **61** enforced by
route call sites, **21** appearing only in UI checks with no server enforcement. Plus 11
`feat:*` flags, which are a separate axis and not permissions.

> Those **21 unenforced permissions** — including all of `workspace:*`, `users:manage`,
> `roles:manage`, `sso:manage` — are a *defect to fix*, not a contract to reproduce. The
> client's `RBACButtons` render `null` rather than disabling, so those checks are purely
> cosmetic today. Our implementation must enforce them server-side.

## Where we intend to be better

These are independent design decisions, made deliberately and recorded here.

### 1. Credential encryption that survives host compromise
The upstream model stores the encryption key on the same filesystem as the database, so
any file-read primitive yields both. **Worse in practice:** deployments routinely run with
`FLOWISE_SECRETKEY_OVERWRITE=myencryptionkey` — the value published in `.env.example` —
making stored credentials trivially decryptable by anyone who reads the DB.

Requirements:
- Refuse to start when the key equals any known published example value.
- Support external key sources (env-injected secret, file with enforced `0400`, KMS/Vault).
- Per-credential salt; authenticated encryption (AEAD).
- A documented key-rotation path that re-encrypts in place. *(Rotation currently requires
  re-entering every credential by hand.)*

### 2. Auth that degrades safely
3.x deleted the Apache-2.0 `FLOWISE_USERNAME` auth and left only the commercial stack, so
removing that stack leaves an **unauthenticated server** — on a product with 116 published
advisories.

Requirements:
- Authentication is **always** present. Single-user mode is a supported first-class
  configuration, not an absence of auth.
- **Fail closed:** if the auth subsystem cannot initialise, refuse connections rather than
  serving unauthenticated.
- Startup refuses default/blank credentials.

### 3. Credentials referenced stably, not by bare UUID
Deleting a credential silently orphaned **37 references across 21 flows** and took down a
production chatbot with a generic "temporarily unavailable". The UI gave no warning that
flows depended on it.

Requirements:
- Deleting a credential in use warns and lists dependent flows.
- An endpoint reporting orphaned references.
- Flows surface a clear "credential missing" state instead of a runtime 500.

### 4. RBAC with real scoping
- Roles composed of explicit permission grants; no implicit super-role beyond one
  bootstrap owner.
- Deny-by-default: unknown permission → denied.
- Permission checks emit structured audit events (who, what, allowed/denied, when).
- Workspace scoping enforced **server-side on every query**, never by client-supplied ID.

### 5. Sessions that can be revoked
- Server-side session records, individually and bulk revocable.
- Rotation on privilege change.
- Visible active-session list per user with revoke.

### 6. Operable by default
- Structured audit log for auth events, on by default.
- Health endpoint reporting auth subsystem state.
- First-run bootstrap that generates a strong password and forces a change.

### 7. Multi-user and SSO are v1 requirements, not later additions

**Corrected 2026-08-05.** An earlier draft made SSO a v1 non-goal, inferred from the
operator running a single user. That inference was wrong: the single user reflected a
belief that Flowise did not support more, not a preference. Multi-user, RBAC and SSO —
**Google specifically** — are all wanted.

This is a much smaller lift than it appears, because **the SSO client is already built
and Apache 2.0**:

```
packages/ui/src/views/auth/ssoConfig.jsx      provider configuration screen
packages/ui/src/views/auth/ssoSuccess.jsx     post-redirect callback handling
packages/ui/src/views/auth/register.jsx       invite redemption
packages/ui/src/views/auth/verify-email.jsx   email verification
packages/ui/src/views/auth/loginActivity.jsx  sign-in audit view
packages/ui/src/api/loginmethod.js            GET/PUT /loginmethod, POST /loginmethod/test
```

Providers the UI already knows: **google, azure, github, auth0**. The spec pins the
server endpoints (§ `/loginmethod`, `/loginmethod/default`, `/loginmethod/test`,
`/auth/sso-success`) and the `sso:manage` permission.

So SSO is **server-side work only** — no new UI, no redesign. Google first, the other
three behind the same interface.

Requirements:
- OAuth2/OIDC authorization-code flow **with PKCE**.
- Provider config stored per-organization; `clientSecret` in its own `select: false`
  column so the `'********'` placeholder never round-trips (spec F-14).
- Local accounts and SSO coexist — SSO must never be the only way in, or a provider
  outage locks everyone out.
- Just-in-time provisioning is **opt-in per provider**, defaulting off. An SSO login for
  an unknown email is rejected unless JIT is explicitly enabled, so configuring a
  consumer provider does not silently grant the internet an account.
- Email from the provider is trusted **only** when the provider asserts it verified.

### 8. MFA — genuinely net-new

**Flowise has no MFA at all.** Verified: no `mfa`, `totp`, `two-factor` or
`authenticator` reference anywhere in `packages/ui/src/**` or the Apache-2.0 server
routes. There is nothing to reimplement and nothing to be clean-room about — this is
additive.

Requirements:
- **TOTP** (RFC 6238) as the baseline second factor: enrolment with QR provisioning URI,
  verification, and single-use recovery codes stored hashed.
- Enforcement is **policy-driven**: off / optional / required-per-role / required-org-wide.
- MFA is evaluated **after** primary auth (local or SSO) and before a session is issued,
  so a session never exists in a half-authenticated state.
- Recovery codes are shown once, stored hashed, and individually consumable.
- Re-authentication required to disable MFA or regenerate codes.
- WebAuthn/passkeys designed for behind the same factor interface, built after TOTP.

This needs **new UI** — an enrolment screen and a challenge step. That is *adding a
feature*, not redesigning: existing screens keep their appearance and behaviour, and the
challenge slots into the existing login flow.

### 9. Encryption at rest

**Stated plainly: "hacker proof" is not achievable, and claiming it would be dishonest.**
Encryption at rest defends against a specific, real threat — an attacker who obtains the
*data* without obtaining the *running process*: a stolen disk or VM image, a leaked
backup or snapshot, a misconfigured volume mount, a file-read vulnerability. It does
**not** defend against an attacker with code execution on the running host, because the
process must be able to decrypt in order to work, so anything the process can read, that
attacker can read. This is why §8 (MFA) and the `vm2` sandbox-escape work matter: they
reduce the chance of that far worse compromise.

Being specific about what is protected and from whom is the difference between security
and security theatre.

**Threat model addressed:** stolen disk/VM/backup, leaked snapshot, exposed volume,
arbitrary-file-read, database file exfiltrated over a path-traversal bug.
**Not addressed by encryption alone:** RCE, a compromised admin account, a malicious
operator with host access.

Requirements:

- **Sensitive fields encrypted at the application layer**, not merely at the volume:
  credentials, SSO client secrets, MFA/TOTP seeds and recovery codes, API keys, session
  refresh secrets, and any flow node input marked secret. AEAD (AES-256-GCM or
  XChaCha20-Poly1305), unique nonce per record, per-record salt.
- **Whole-database encryption supported** where the engine allows it — SQLCipher for
  SQLite, TDE or an encrypted volume for Postgres/MySQL — documented as a deployment
  option rather than assumed.
- **The key must be able to live outside the host.** The current model keeps the key on
  the same filesystem as the database, so one file-read yields both. Support
  env-injected secrets, a key file with enforced `0400`, and external KMS/Vault.
  Refuse to start on any published example key value (see §1).
- **Key rotation without re-entering every credential** — re-encrypt in place, with a
  key version recorded per record so rotation is resumable and auditable.
- **Hashes are not encryption.** Passwords and recovery codes are hashed (argon2id or
  bcrypt), never encrypted; they are never decryptable, by us or anyone.
- **Encrypted values never appear in logs, audit records, API responses, or error
  messages.** Redaction is enforced centrally, not per call site.
- Backups inherit encryption — a plaintext backup of an encrypted database defeats
  the entire control.

### 10. Audit — who did what, when

**This is the point of RBAC and versioning, not a side effect.** Access control without a
record answers "was this allowed?" but never "who did it, and when?" — which is the
question that actually matters after an incident. Versioning already answers it for flow
and prompt changes; this extends the same guarantee to everything else.

One unified, queryable audit trail covering:

| Domain | Recorded |
| --- | --- |
| Authentication | login success/failure (+ reason), logout, SSO login and provider, MFA challenge outcome, password change, session issue/refresh/revoke |
| Authorization | every permission decision — subject, permission, allow/deny, reason, route, workspace |
| Identity administration | user invite/create/suspend/delete, role create/modify/delete **with the permission delta**, workspace membership and role changes, SSO configuration changes |
| Credentials | create, update, delete, and **each decryption for use** — with flow and node context, never the value |
| Flows and prompts | create, update, delete, deploy, restore — cross-referenced to the version commit (see `REQUIREMENTS-VERSIONING.md`) |
| Data access | export, import, bulk read of chat history |

Every record carries: **who** (subject id, type, session), **what** (action, target type
and id), **when** (UTC, monotonic ordering), **where** (source IP, user agent, route),
**which scope** (organization, workspace), and **outcome** (success/failure + reason).

Requirements:
- **Append-only.** No API mutates or deletes audit records. Retention/archival is an
  operator action, distinct from ordinary deletion.
- **Failures are audited as loudly as successes** — a failed login and a denied
  permission are the highest-value records in the file.
- **Never contains secrets.** Credential values, tokens, MFA seeds and password hashes
  are recorded by reference, never by value.
- **Queryable in the UI** — the Apache-2.0 `views/auth/loginActivity.jsx` already exists
  as a starting surface; extend it to the wider trail rather than building a new one.
- **Structured and exportable** (JSON lines) so it can ship to an external SIEM, since an
  audit log that only lives on the compromised host has limited forensic value.
- **Audit failure is visible.** If the audit sink is unavailable, that fact is itself
  recorded and surfaced — silently losing the trail is worse than losing the request.

## Non-goals (v1)

- SAML — OIDC/OAuth2 covers Google, Azure, GitHub and Auth0. SAML only if an
  identity provider requires it.
- WebAuthn/passkeys — designed for, built after TOTP lands.
- Multi-org tenancy — one org with multiple workspaces covers the known use case;
  the schema supports more.
- Feature-flag licensing/quotas — Flow-Wiser has nothing to gate.

## Scope estimate

| Component | LOC |
| --- | --- |
| Auth (accounts, sessions, hashing, bootstrap) | ~800 |
| Entities + migrations ×4 engines | ~400 |
| Permission middleware | ~50 |
| Permission catalog (clean-room from routes) | ~200 |
| Role/user services + routes | ~300 |
| Rework the 61 importing files | mechanical |
| SSO — OIDC/OAuth2 + PKCE, 4 providers (§7) | ~500 |
| MFA — TOTP, recovery codes, policy (§8) | ~400 |
| Encryption at rest — AEAD, key sources, rotation (§9) | ~400 |
| Audit trail — unified, append-only (§10) | ~300 |
| **UI for existing screens** | **0 — kept verbatim** |
| **UI for MFA** | ~200 — net-new, additive |

~3,500–4,500 LOC. Larger than the original estimate because SSO, MFA, encryption
at rest and audit moved from "later" into v1.

## Acceptance

1. All 127 files deleted; repo is 100% Apache 2.0.
2. Clean-room guard green; every requirement traces to an Apache-2.0 citation.
3. The **unmodified** Apache-2.0 UI works against the new server: login, user CRUD, role
   CRUD, workspace switch, permission-gated views.
4. All 120 existing `checkPermission` call sites enforce correctly.
5. Container builds and boots; no regression against `3.1.4-fw3`.
6. Redistributable with no licence carve-out — npm, Docker Hub, anywhere.
