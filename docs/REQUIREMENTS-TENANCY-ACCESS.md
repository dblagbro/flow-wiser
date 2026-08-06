# Requirements — Tenancy, Access Model & Registration

Full access-control model, tenant movement, and self-service sign-up.
Companion to [REQUIREMENTS-AUTH-RBAC.md](REQUIREMENTS-AUTH-RBAC.md) and
[REQUIREMENTS-MIGRATION.md](REQUIREMENTS-MIGRATION.md).

---

## 1. The two axes

Every authority decision is the intersection of **scope** (which tenants) and
**capability** (what may be done). Conflating them is what produces "admin" roles that
accidentally grant everything.

| Axis | Values |
| --- | --- |
| **Scope** | instance-wide · single organization · assigned workspaces |
| **Capability** | view · change · reveal secrets · administer identity |

The critical property: **`super-user` is instance-wide in *scope* but read-only in
*capability*** for everything except user administration. Seeing everywhere and changing
everywhere are different powers, and upstream has no way to express that.

## 2. Access matrix

`R` = read · `W` = create/update/delete · `—` = no access

| Domain | super-admin | admin | super-user | org-admin | user | read-only |
| --- | --- | --- | --- | --- | --- | --- |
| **Scope** | instance | instance | **instance** | **own org** | workspaces | workspaces |
| Flows / agentflows | R W | R W | **R only** | R W (own org) | R W (own work) | R (execute) |
| Credential **records** (names, type, usage) | R W | R W | **R only** | R W (own org) | R (use) | — |
| Credential **values** (`credentials:reveal`) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Tools / assistants / doc stores / variables | R W | R W | **R only** | R W (own org) | R W (own work) | R |
| Users & role assignment | R W | R W | **R W** | R W (own org) | — | — |
| Role **definitions** (editing grants) | R W | R W | R only | — | — | — |
| Organizations / tenancy | R W | R W | R only | R (own) | — | — |
| **Move a resource between tenants** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Audit log | R (all) | R (all) | **R (all)** | R (own org) | — | — |
| SSO configuration | R W | R W | R only | R W (own org) | — | — |
| Encryption keys / rotation | R W | — | — | — | — | — |
| Recovery CLI | ✅ | — | — | — | — | — |
| MFA exemption | ✅ | — | — | — | — | — |

### Why `super-user` is shaped this way

It is the **auditor-plus-user-administrator**: total visibility, no authority over content.

- Sees every flow, every credential *name*, every log, in every organization.
- Manages users and role assignments instance-wide.
- **Cannot change a flow, cannot reveal a secret, cannot move a tenant.**

That is a genuinely useful separation of duties — someone who can investigate an incident
across the whole instance and fix access, without being able to alter the evidence or
extract the secrets. Auditing and mutation should not be the same grant.

### `admin` vs `super-admin`

Both are instance-wide and both can reveal credentials. `super-admin` additionally holds
the things that could destroy or silently subvert the instance: **encryption key
management and rotation, the recovery CLI, and MFA exemption.** Break-glass powers sit
one level above day-to-day omnipotence, so the account you use daily is not the account
that can rewrite the security substrate.

## 3. Tenant assignment and movement

### The tenant tag

Each tenant-scoped resource carries `organizationId` written directly on the row
(see `REQUIREMENTS-MIGRATION.md` §3a). **That column is the tenant tag.** Moving a
resource between tenants means re-stamping it.

Single-valued, not multi-valued: a resource belongs to exactly **one** organization.
Multi-org visibility is a *sharing* concern (§3.3), deliberately kept separate — a
resource with two owners has no unambiguous answer to "whose data was breached?"

### 3.1 Moving resources

`POST /tenancy/move` — **super-admin and admin only.**

Requirements:
- Moves a **workspace** (with everything in it) or **individual resources**.
- **Transactional.** Every affected row is re-stamped in one transaction, or none is.
  A partial move leaves resources orphaned in a tenant nobody administers.
- **Referential integrity checked first, and the move refused if it would break.** A flow
  referencing a credential that is *not* moving would silently break on arrival — the
  pre-flight names exactly what would break and requires `--force` to proceed anyway.
- **Audited as a first-class event**: actor, resource ids, source org, destination org,
  count, and outcome. Moving data between tenants is among the highest-consequence
  operations in the system.
- **Dry-run by default**, reporting the full set of rows that would change.
- Credentials do **not** re-encrypt on move — same instance, same key.

### 3.2 Users across tenants

A user may belong to several organizations, with a **different role in each**
(`OrganizationUser` already models this). The session carries the *active* organization;
`POST /workspace/switch` re-issues the permission set, which is why permissions are
workspace-scoped rather than global.

Removing a user from an organization revokes only that org's grants, and every session
bound to that org is revoked immediately — not on next login.

### 3.3 Sharing (explicitly deferred)

Making one resource visible to multiple organizations without moving it is **not in v1**.
It multiplies the tenancy surface, and the leak modes are subtle. Recorded here so it is
a decision rather than an omission.

## 4. Self-service registration

Requested by the operator: sign-up creates a **request**, the applicant receives an email
explaining how approval works, and on approval they join a tenant group.

### Flow

```
1. Applicant submits sign-up            email + name + (optional) requested organization
2. Server creates a PENDING registration    no account, no session, no permissions
3. Applicant receives acknowledgement    "here is how approval works, expect X"
4. Reviewers notified                    super-admin / admin / super-user, and the
                                         org-admin of any requested organization
5. Approve  -> account created, tenant + role assigned, invite email sent
   Reject   -> applicant notified, request retained for audit
6. First login  -> forced password set/change (§6 of REQUIREMENTS-MIGRATION)
                   MFA enrolment if org policy requires it
```

### Requirements

- **A pending registration is not an account.** It cannot authenticate, holds no
  permissions, and occupies no tenant until approved. Registration must never be a path
  to a usable identity.
- **Self-service sign-up is off by default**, enabled per-instance and optionally
  restricted to an **email domain allowlist**. An internet-facing instance with open
  sign-up is a queue-flooding vector at best.
- **The applicant requests; they do not choose.** They may *nominate* an organization;
  the assignment is made by the approver. Otherwise "select the tenant group" becomes
  self-service entry into any tenant.
- **Approval assigns both organization and role**, defaulting to the lowest useful role
  (`user`) rather than inheriting anything from the request.
- **Rate-limited and abuse-resistant**: per-IP and per-domain throttling, and the response
  is identical whether or not the email is already registered — a differing response is an
  account-enumeration oracle.
- **Email verification is required before a request is queued**, so reviewers are not
  triaging unverified addresses.
- **Every transition is audited** — submitted, verified, approved, rejected, expired —
  with the deciding actor recorded.
- **Requests expire** (default 30 days) and are retained after decision for audit.
- Rejection reveals nothing about why, to the applicant.

## 5. Users section (UI)

The Apache-2.0 UI already ships `packages/ui/src/views/users/` and
`packages/ui/src/views/roles/`. **We extend them; we do not replace them.**

Additions:
- **Pending registrations** queue — approve/reject with organization and role assignment.
- **Per-user detail**: organizations and role in each, active sessions with revoke, MFA
  status, last login, `mustChangePassword` state.
- **Effective permissions** for a selected user — the flattened result of their roles in
  the active organization. Composed roles are hard to reason about, and an access model
  nobody can inspect drifts toward permissive.
- **Tenant column** in the user list, since users may span organizations.
- Actions gated by the matrix in §2 — `super-user` sees every control it may use, and
  controls it may not are **disabled with a reason**, not hidden. Silently missing
  controls teach people the system is broken; disabled ones teach them the model.

## 6. Acceptance

1. A `super-user` can read every flow in every organization and change **none** of them.
2. A `super-user` can create a user and assign a role, in any organization.
3. A `super-user` is refused `credentials:reveal` — audited as a denial.
4. An `org-admin` in A cannot see, list, or reference any resource in B; attempts are
   audited as failures rather than returning empty.
5. Moving a workspace A→B re-stamps every resource transactionally; a forced move with
   broken references is recorded with what broke.
6. A pending registration cannot authenticate, and identical responses are returned for
   known and unknown emails.
7. Approval assigns organization and role, and first login forces a password change.
