# Status — building in the open

**Last updated: 2026-08-05**

This project is developed in public, including the unfinished parts. Work-in-progress is
pushed to the `apache2-only` branch as it is written, before it compiles or runs.

That is deliberate, for three reasons:

1. **Honesty.** A fork that claims "100% open source, coming soon" and shows nothing is
   asking for trust it hasn't earned. You can read every line and judge for yourself.
2. **The clean-room record.** Independent creation is a defence you *prove* with a paper
   trail. Every commit is timestamped, attributed, and public — the specification landed
   before the implementation, and the git history shows it.
3. **Contribution.** You cannot help with work you cannot see.

---

## What actually works right now

| Thing | State |
| --- | --- |
| **`main` — patched Flowise** | ✅ **Production-ready.** Released as `v3.1.4-fw3`, published at `dblagbro/flow-wiser` |
| Docker image version pinning | ✅ Fixed and shipped |
| `connect-sqlite3` boot crash (upstream #6688) | ✅ Root-caused, fixed, reported upstream |
| `NODE_VERSION=24` unbuildable default | ✅ Fixed |
| `vm2` 3.11.2 → 3.11.5 (6 critical sandbox escapes) | ✅ Fixed and shipped |
| Flow-Wiser branding, SPA route fixes | ✅ Shipped |
| Upstream archive (347 PRs, 698 issues, 116 advisories) | ✅ Captured before the 2026-08-10 lock |

**If you want a working, patched Flowise today, use `main`.** It is the only branch you
should deploy.

## What is being built — and does not work yet

The `apache2-only` branch is replacing the 127 commercially-licensed files with original
Apache-2.0 work. **It does not run. It is not deployable. Do not use it in production.**

| Component | State | Notes |
| --- | --- | --- |
| Interface specification | ✅ Complete | 2,174 lines, 53 endpoints, 82 permissions, 12 entities, 349 citations — all from Apache-2.0 sources |
| RBAC catalog + middleware | ✅ Written | 669 LOC. Typechecked and behaviourally tested in isolation |
| Identity entities + migrations | ✅ Written | 10 entities, 8 migrations ×4 engines. SQLite DDL executed against an in-memory DB |
| SSO / MFA / audit / encryption metadata | 🔄 In progress | Extending the data layer |
| Auth core (hashing, sessions, login) | ⬜ Not started | The long pole |
| 53 HTTP endpoints + services | ⬜ Not started | |
| **Wiring** | ❌ **Not done** | Entities are **not** registered in the global map; **no** route file points at the new RBAC yet |
| Deleting the 127 files | ⬜ Not started | The final step |

**Concretely, today:** the new code exists and compiles in isolation, but nothing calls
it. The server still runs entirely on the outgoing stack. That is what "does not work
yet" means — not "slightly buggy", but "not connected".

## Why the branch is honest about being broken

Some of these commits will not build as a whole tree. That is expected while the old and
new stacks coexist: the entities are deliberately `identity_`-prefixed and unregistered
precisely so the running server is unaffected until cut-over.

Pushing only green commits would mean pushing nothing for weeks, then a single enormous
drop nobody can review. We would rather be reviewable than tidy.

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

Three capabilities upstream never shipped, all Apache 2.0:

- **RBAC with real enforcement.** 21 permissions currently have *no* server-side check —
  the client renders buttons as `null` rather than disabling them, so those checks are
  cosmetic. Ours enforces server-side, deny-by-default, workspace-scoped, audited.
- **SSO and MFA.** The SSO *client* already exists in the Apache-2.0 UI (Google, Azure,
  GitHub, Auth0) — only the server was proprietary. MFA never existed at all; TOTP with
  hashed recovery codes is genuinely new.
- **Flow and prompt versioning with full history.** Git-backed, non-destructive restore:
  recovering an old version writes a *new* commit, so the version you moved away from
  stays recoverable forever. See [REQUIREMENTS-VERSIONING.md](REQUIREMENTS-VERSIONING.md).

Plus encryption at rest with honest threat modelling, and one unified append-only audit
trail — who did what, when.

## Following along

- [`PROJECT-LOG.md`](PROJECT-LOG.md) — findings, decisions, rejected approaches with reasons
- [`SPEC-AUTH-RBAC.md`](SPEC-AUTH-RBAC.md) — the 2,174-line clean-room specification
- [`REQUIREMENTS-AUTH-RBAC.md`](REQUIREMENTS-AUTH-RBAC.md) — what we build and why it is better
- [`REQUIREMENTS-VERSIONING.md`](REQUIREMENTS-VERSIONING.md) — versioning design
- [`CLEANROOM-PROTOCOL.md`](CLEANROOM-PROTOCOL.md) — the binding process
