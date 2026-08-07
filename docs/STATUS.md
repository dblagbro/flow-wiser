# Status — building in the open

**Last updated: 2026-08-06**

This project is developed in public, including the unfinished parts. Work-in-progress is
pushed as it is written, before it compiles or runs.

That is deliberate, for three reasons:

1. **Honesty.** A fork that claims "100% open source, coming soon" and shows nothing is
   asking for trust it hasn't earned. You can read every line and judge for yourself.
2. **The clean-room record.** Independent creation is a defence you *prove* with a paper
   trail. Every commit is timestamped, attributed, and public — the specification landed
   before the implementation, and the git history shows it.
3. **Contribution.** You cannot help with work you cannot see.

---

## What actually works right now

**`3.1.4-fw4` is released and is the build to deploy.** It is Apache-2.0-only, it boots,
and a fresh install works. Earlier entries on this page said the Apache-2.0 work "does not
run. It is not deployable." That was true when written and is no longer true.

| Thing | State |
| --- | --- |
| **`3.1.4-fw4` — Apache-2.0-only** | ✅ **Released.** Built from source at `dblagbro/flow-wiser` |
| The 127 commercially licensed files | ✅ Deleted, and the build fails if any trace returns |
| Authentication, sessions, SSO login methods | ✅ Shipped |
| MFA — TOTP + hashed recovery codes | ✅ Shipped. Upstream had none |
| RBAC — 82 permissions, server-side, deny-by-default | ✅ Shipped |
| Multi-tenancy — organisations, workspaces, tenant key | ✅ Shipped |
| Audit trail, encryption at rest with key rotation | ✅ Shipped |
| Recovery CLI — nine commands, `/dev/tty` passwords only | ✅ Shipped |
| Migration from an existing Flowise 3.x database | ✅ Shipped, verified against a production copy |
| Fresh install on SQLite / Postgres / MySQL / MariaDB | ✅ Fixed and verified |
| Docker image version pinning | ✅ Fixed and shipped |
| `connect-sqlite3` boot crash (upstream #6688) | ✅ Root-caused, fixed, reported upstream — and now unreachable, the file that threw is deleted |
| `NODE_VERSION=24` unbuildable default | ✅ Fixed |
| `vm2` 3.11.2 → 3.11.5 (6 critical sandbox escapes) | ✅ Fixed in the source tree as of `fw4`; before that, only in the npm-install Dockerfile |
| Upstream archive (347 PRs, 698 issues, 116 advisories) | ✅ Captured before the 2026-08-10 lock |

## What is not done

| Thing | State | Notes |
| --- | --- | --- |
| Five identity-administration endpoints | ⬜ `501` with a reason | `/user`, `/role`, `/organization`, `/organizationuser`, `/audit`. No call site exists in the Apache-2.0 client, so building them would mean inventing behaviour |
| Forgotten-password flow | ⬜ `501` | No transactional email path in this build, so no token can be issued. The forced-password-change flow through the same URL does work |
| Chatflow version history | ⬜ Designed, not built | [REQUIREMENTS-VERSIONING.md](REQUIREMENTS-VERSIONING.md) |
| ReAct Agent + AWS Bedrock nodes | ⚠️ Non-fatal load failures | Inherited upstream dependency drift. The server runs; those two nodes do not load |
| `vm2` | ⚠️ Pinned, not replaced | A fresh escape in essentially every release line. `isolated-vm`, or disabling custom-code nodes on internet-facing deployments, is the real fix |
| MySQL migrations | ⚠️ Verified by inspection | No MySQL image will unpack on the build host. Byte-identical to the MariaDB files modulo collation; MariaDB is executed |

---

## How we are doing this legally

Full detail in [CLEANROOM-PROTOCOL.md](CLEANROOM-PROTOCOL.md). In short:

**We do not reverse engineer anything, and we never read the proprietary files.**

We do not have to. `packages/ui` is **100% Apache 2.0** and contains the complete HTTP
contract — every endpoint, payload and response. The Apache-2.0 route files contain 120
permission call sites defining the middleware contract. The entire specification is
derivable from code we already have full rights to read, copy and modify.

The specification's provenance was verified independently: **349 citations, every one
from an Apache-2.0 tree.** Exactly one enterprise path appears, once, as a module
*specifier* observed in an Apache-2.0 import — never as content.

**Enforced mechanically**, not by good intentions: `.githooks/pre-commit` and a CI
workflow reject any commit that *modifies* `packages/server/src/enterprise/` or
`IdentityManager.ts`. Deletion is permitted — removing them is the goal. Editing is
blocked, because editing implies reading.

**What we explicitly refuse to do**, recorded so nobody proposes it again:

- ❌ Feed the proprietary files to an LLM to summarise or port them. That manufactures a
  derivative-work argument where none currently exists. **The absence of reverse
  engineering is our strongest asset, and we are not spending it.**
- ❌ Reimplement in another language to "avoid" the licence. Copyright protects
  expression, not language choice or process boundaries.
- ❌ Declare the repository Apache 2.0 while those files remain. That would be void — the
  copyright is FlowiseAI's, and no fork can relicense code it does not own. It would also
  be a lie, which is worse than the honest split we ship today.

**Legal grounding** (background, not advice): 17 U.S.C. §102(b); *Google v. Oracle*,
593 U.S. \_\_\_ (2021); *Sega v. Accolade*, 977 F.2d 1510 (9th Cir. 1992); *Sony v.
Connectix*, 203 F.3d 596 (9th Cir. 2000); the Phoenix BIOS clean-room methodology.
Clean-room does **not** defeat patents — independent invention is no defence to a patent
claim.

We are not lawyers. Counsel should review the specification and attestation before the
Apache-2.0-only build is published.

---

## Where the project is going

Three capabilities upstream never shipped, all Apache 2.0. Two of them are now in
`3.1.4-fw4`:

- ✅ **RBAC with real enforcement.** Upstream's 21 permissions had *no* server-side check —
  the client rendered buttons as `null` rather than disabling them, so those checks were
  cosmetic. Ours enforces server-side, deny-by-default, workspace-scoped, audited.
- ✅ **SSO and MFA.** The SSO *client* already existed in the Apache-2.0 UI (Google, Azure,
  GitHub, Auth0) — only the server was proprietary. MFA never existed at all; TOTP with
  hashed recovery codes is genuinely new.
- ⬜ **Flow and prompt versioning with full history.** Git-backed, non-destructive restore:
  recovering an old version writes a *new* commit, so the version you moved away from
  stays recoverable forever. Designed, not built. See
  [REQUIREMENTS-VERSIONING.md](REQUIREMENTS-VERSIONING.md).

Plus encryption at rest with honest threat modelling, and one unified append-only audit
trail — who did what, when. Both shipped.

## Following along

- [`PROJECT-LOG.md`](PROJECT-LOG.md) — findings, decisions, rejected approaches with reasons
- [`SPEC-AUTH-RBAC.md`](SPEC-AUTH-RBAC.md) — the 2,174-line clean-room specification
- [`REQUIREMENTS-AUTH-RBAC.md`](REQUIREMENTS-AUTH-RBAC.md) — what we build and why it is better
- [`REQUIREMENTS-VERSIONING.md`](REQUIREMENTS-VERSIONING.md) — versioning design
- [`CLEANROOM-PROTOCOL.md`](CLEANROOM-PROTOCOL.md) — the binding process
