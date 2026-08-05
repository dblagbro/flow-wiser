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
| `packages/server/src/routes/**` | 142 `checkPermission` / `checkAnyPermission` call sites — middleware contract + permission vocabulary |

**The permission middleware is tiny.** The enforcement surface is ~50 LOC and **142 route
call-sites are already wired in Apache-2.0 code**. We implement the function; the wiring
exists.

**The permission vocabulary is recoverable without touching protected files.** 43 of the
~86 permission strings appear as literals in Apache-2.0 route files. The remainder are
admin/org/workspace permissions we are redesigning anyway.

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

## Non-goals (v1)

- SSO/SAML/OIDC — design for it, ship later. Basic + local accounts first.
- Multi-org tenancy — single org with multiple workspaces covers the known use case.
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
| **UI** | **0 — kept verbatim** |

~2,000–3,000 LOC, roughly 85% auth.

## Acceptance

1. All 127 files deleted; repo is 100% Apache 2.0.
2. Clean-room guard green; every requirement traces to an Apache-2.0 citation.
3. The **unmodified** Apache-2.0 UI works against the new server: login, user CRUD, role
   CRUD, workspace switch, permission-gated views.
4. All 142 existing `checkPermission` call sites enforce correctly.
5. Container builds and boots; no regression against `3.1.4-fw3`.
6. Redistributable with no licence carve-out — npm, Docker Hub, anywhere.
