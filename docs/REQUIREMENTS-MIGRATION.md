# Requirements — Migration, Roles & Recovery

How an existing Flowise deployment becomes a Flow-Wiser deployment **without losing data
and without losing access**, and how to get back out if it goes wrong.

> **No credentials appear in this repository.** All bootstrap secrets are supplied at run
> time via environment or CLI. A password committed to a public repo is a published
> password.

---

## 1. What we are migrating from

Flowise's schema history is long and the identity layer arrived late:

| | |
| --- | --- |
| Migration chain begins | `1693835579790-Init` (September 2023) |
| Apache-2.0 migrations | 49 |
| Identity migrations (from the commercial tree) | 8 |
| A current 3.1.x database has applied | **57** |

**The `migrations` table is the version fingerprint.** Flowise records no product version
in the database; the set of applied migrations is the only reliable identifier. Detection
must read that table, not a version string.

### The two eras

| Era | Identity tables | Migration path |
| --- | --- | --- |
| **Pre-3.0** (before 2025-05-27) | **None.** Single shared login via `FLOWISE_USERNAME`/`FLOWISE_PASSWORD`; no `user`, `organization`, `workspace` or `role` tables at all | No users to carry over — bootstrap fresh |
| **3.0+** | `user`, `organization`, `organization_user`, `workspace`, `workspace_user`, `role`, `login_method`, `login_activity` | Carry the existing user(s) across as the admin/back-door account |

An upgrade tool that assumes either era exists will fail on the other. Both must be
handled, and a database from **any** point in that history must be able to move forward.

## 2. Non-negotiable: non-user data is preserved

Flows, credentials, chat history, document stores, variables, API keys, evaluations and
executions are **untouched** by identity migration. They are not re-keyed, not
re-encrypted as a side effect, and not rewritten.

Specifically: **credentials keep their existing ciphertext and their existing encryption
key.** Any change to credential encryption (`REQUIREMENTS-AUTH-RBAC.md` §9) is a separate,
explicit, resumable operation — never a silent consequence of upgrading.

Verified before and after by row counts and content hashes; the upgrade aborts on any
mismatch.

## 3. Role hierarchy

Five levels, replacing the three stock roles. Specified by the operator, 2026-08-05:

| Role | Intent |
| --- | --- |
| **super-admin** | Everything, including identity, SSO configuration, role definitions, and the recovery CLI. Break-glass. |
| **admin** | **Anything in all domains**, including **revealing stored credential values** in the UI. |
| **super-user** | Manages users. Sees **all logs** and **credential names/metadata** — but **never a credential value** in the UI. |
| **user** | Authors within assigned workspaces: creates and edits own flows, *uses* existing credentials. No user administration. |
| **read-only** | Views and executes deployed flows. No create, edit, delete, or credential access. |

### The credential-value split — a distinction upstream does not make

Flowise treats credentials as one capability: manage them and you can read them. That
conflates two very different powers, and it is why a compromised account yields every API
key at once.

Flow-Wiser separates them into distinct permissions:

| Permission | Grants |
| --- | --- |
| `credentials:view` | See that a credential exists — its **name**, type, owner, dates, and which flows reference it. **No secret material.** |
| `credentials:create` / `:update` / `:delete` | Manage the credential record, including **writing** a new secret |
| **`credentials:reveal`** | **Decrypt and display the stored secret value.** Held by **admin and super-admin only** |

`credentials:reveal` is the sharp one:

- Every use is written to the audit trail — who, which credential, when, from where.
  Reading a secret is an event, not a page view.
- It is **never implied** by any other permission. Managing, rotating, or deleting a
  credential does not require reading it.
- Writing a new secret does not grant reading the old one.

**A `super-user` can therefore administer people and audit the entire system without ever
holding the keys** — which is exactly the property missing when a single compromised
account led to a six-figure API bill.

> Secret values remain reachable from the host via the recovery CLI (§7) and direct
> database access. That is unavoidable and not a weakness in the model: whoever holds the
> database and encryption key can already read everything. The control is about the
> **UI and API surface**, where an account compromise actually happens — and about
> ensuring that reading a secret leaves a record.

Implemented as **seeded roles composed of explicit permission grants**, not hard-coded
tiers — so a deployment can reshape them without a code change, and the hierarchy is
inspectable in the UI. Seeded roles are marked `isSystem` to refuse accidental deletion
while remaining editable.

Deny-by-default still applies underneath: a role holds exactly the permissions granted.

### Proposed hardening on top of `credentials:reveal`

Not requested; proposed because the incident that motivated this project was credential
exfiltration, and a permission alone only answers *who may*, never *how easily*.

1. **Re-authentication (sudo mode).** Revealing requires re-entering the password — or
   satisfying MFA — even for an admin already logged in, valid for a short window.
   A hijacked *session* then cannot dump credentials; the attacker needs the *credential*.
2. **Time-boxed unmask.** A revealed value displays for ~30 seconds, then re-masks.
   Bounds shoulder-surfing and stops secrets sitting on an unattended screen.
3. **Break-glass alerting.** `credentials:reveal` and every recovery-CLI invocation
   optionally emit a webhook/email. One reveal is routine; twelve at 03:00 is a signal —
   and nobody reads an audit log they are not pointed at.
4. **Effective-permissions report.** A screen answering *"who can currently reveal
   credentials?"* and *"what can this user actually do?"* Composed roles make that
   genuinely hard to eyeball, and an access-control model nobody can audit drifts.
5. **Reveal requires an MFA-satisfied session** where org policy enables MFA — using the
   `Session.mfaSatisfied` flag already modelled.

Flowise has none of these. (1), (2) and (5) are small; (3) and (4) are ordinary features.

### New UI: audit log viewer

Requested by the operator. `super-user` and above see **all logs**.

Upstream ships only `views/auth/loginActivity.jsx` — sign-ins alone. The audit trail
(`REQUIREMENTS-AUTH-RBAC.md` §10) covers far more: permission decisions, identity
administration, credential use **including every reveal**, flow and prompt changes, and
exports.

Requirements:
- Filter by actor, action, target, outcome, scope, and time range.
- **Failures visually distinct** — denied permissions and failed logins are the
  highest-value rows and should not have to be hunted for.
- Credential events link to the credential record; flow events link to the **version
  commit** (`REQUIREMENTS-VERSIONING.md`), so "who changed this prompt, when, and to what"
  is one trail rather than two.
- Export the current filter as JSON lines for external analysis.
- Never renders secret values — the audit record holds references, never material.
- Extends the existing `loginActivity` surface rather than replacing it; that screen keeps
  working as a projection over the same data.

## 4. Bootstrap and back-door accounts

At first boot after migration, one or more **super-admin** accounts are provisioned.

Requirements:
- Identities and initial password come from **environment or CLI at run time**. Never from
  a file in this repository, never a compiled-in default.
- The bootstrap **refuses to run with a weak, blank, or known-published password** — the
  same check that rejects `myencryptionkey` for the encryption key (§1 of the auth
  requirements).
- Bootstrap accounts are exempt from MFA enforcement **by design**, so a broken TOTP
  configuration cannot lock every administrator out of the instance. That exemption is
  recorded in the audit trail on every use, because a permanent MFA-exempt account is a
  standing risk that should be visible rather than forgotten.
- **Password change is forced on first interactive login** for any password-authenticated
  account, including bootstrap accounts (§6).

## 5. Migrating an existing Flowise user

For a 3.0+ database, the existing user becomes the **admin / back-door** account:

- Email, display name and account status carry across.
- **The existing password hash is carried across if its format is verifiable** (bcrypt),
  so the operator is not locked out mid-upgrade. It is then marked as requiring change on
  next login (§6). If the hash format cannot be identified, the account is migrated
  *disabled* and must be recovered via CLI — never silently left with an unverifiable
  credential.
- Existing role assignments map onto the new hierarchy: the org owner becomes
  **super-admin**, other members become **user** unless their grants indicate otherwise.
  The mapping is written to the audit trail and printed in the dry-run report.

## 6. Password change enforcement — and why SSO is different

- Any account authenticating by **password** is flagged `mustChangePassword` after
  migration or bootstrap. The flag blocks all authenticated routes except the
  change-password endpoint until cleared.
- Accounts authenticating via **SSO (Google, Azure, GitHub, Auth0) are not flagged.** Their
  credential lives with the identity provider, which enforces its own rotation, complexity
  and MFA policy. Forcing a local password change on an SSO-only account is meaningless —
  there is no local password — and would create one where none should exist.
- An account may hold both; the flag then applies only to its password path.

## 7. Recovery — CLI and back-end

Every identity operation must be performable **without a working UI and without a working
login**, because the failure modes that need recovery are exactly the ones that break both.

Commands (run against the data directory, on the host or `docker exec`):

```
flow-wiser admin:create --email <e> --role super-admin      # password prompted, never argv
flow-wiser admin:reset-password --email <e>
flow-wiser admin:list
flow-wiser admin:unlock --email <e>                          # clear lockout / failed attempts
flow-wiser mfa:disable --email <e>                           # lost authenticator device
flow-wiser sso:disable                                       # provider outage lockout
flow-wiser session:revoke-all
flow-wiser doctor                                            # diagnose schema/identity state
```

Requirements:
- Passwords are **prompted, never accepted as arguments** — argv leaks into shell history
  and the process table.
- Every recovery command writes an audit record. Break-glass that leaves no trace is
  indistinguishable from an intrusion.
- The CLI requires filesystem access to the data directory. That is the security boundary:
  whoever holds the database can already read everything, so CLI recovery grants no
  authority they did not already possess.

## 8. "That upgrade failed" — rollback

Assume every upgrade can fail, because at some point one will.

Requirements:

1. **Automatic pre-upgrade backup.** The database is copied and integrity-checked *before*
   any migration runs. The upgrade aborts if the backup or its verification fails —
   no backup, no upgrade.
2. **Dry run by default.** `--dry-run` reports exactly what would change — migrations to
   apply, users to create or map, roles to seed — and writes nothing.
3. **Transactional where the engine allows it.** SQLite and Postgres support
   transactional DDL; migrations run inside one so a failure rolls back cleanly. MySQL and
   MariaDB do not, so those paths rely on the backup and are documented as such rather
   than pretending otherwise.
4. **Additive, non-destructive.** New identity tables are added alongside the old ones.
   The originals are not dropped by the upgrade. Dropping them is a separate, later,
   explicitly-invoked step once the operator is satisfied.
5. **Documented restore**, tested as part of the release:
   ```
   docker compose stop flowise
   cp <backup> <data-dir>/database.sqlite
   # revert the image tag
   docker compose up -d --force-recreate --no-deps flowise
   ```
6. **Forward-only from any version.** A database from any point since
   `1693835579790-Init` (September 2023) must reach current. Where a step needs data
   transformation rather than schema change, a standalone script is provided rather than
   hiding it inside a migration.

## 9. Acceptance

1. A **pre-3.0** database (no identity tables) upgrades, bootstraps super-admins, and
   preserves every flow, credential and message.
2. A **3.1.x** database upgrades with its existing user carried across as admin, able to
   log in and forced to change password.
3. Non-user row counts and content hashes are **identical** before and after, on both paths.
4. `--dry-run` accurately predicts both outcomes without writing.
5. A deliberately failed upgrade restores cleanly from the automatic backup.
6. Every recovery command works with the UI down and no valid session.
7. All of the above verified on **all four database engines**.
