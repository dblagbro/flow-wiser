# Flow-Wiser Changelog

All notable changes to the Flow-Wiser community continuation fork.

Flow-Wiser versions are expressed as `<upstream-version>-fw<n>` — the upstream Flowise
release this build is based on, plus a Flow-Wiser revision number. `3.1.4-fw1` is upstream
Flowise 3.1.4 with Flow-Wiser fix set 1 applied.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.1.4-fw1] — 2026-08-05

**The first Flowise 3.1.4 container build that actually starts.**

Upstream Flowise reached end of life on 2026-08-03 (code freeze 2026-07-29, repository
archived 2026-08-10). This release fixes three independent defects in the upstream container
build that were never fixed upstream and now never will be.

### Fixed

#### Official Docker images shipped an unpatched server (undisclosed upstream)

Every published `flowiseai/flowise` image ships the **`flowise@3.1.2` server package
regardless of its tag**:

| Image tag | Server package actually shipped |
| --- | --- |
| `flowiseai/flowise:3.1.2` | `flowise@3.1.2` |
| `flowiseai/flowise:3.1.3` | `flowise@3.1.2` ❌ |
| `flowiseai/flowise:3.1.4` | `flowise@3.1.2` ❌ |

`flowise@3.1.3` and `@3.1.4` are published correctly on npm; no official image ever
contained them.

**Cause.** `docker/Dockerfile` ran an unpinned `npm install -g flowise`. The version was not
part of the Docker layer cache key, so later builds reused the layer produced when npm's
`latest` was still 3.1.2.

**Impact.** The **25 security advisories fixed in `flowise@3.1.3`** — several of them critical
RCEs — were absent from every official image. Anyone who "upgraded" to the 3.1.3 or 3.1.4
image was still running the 3.1.2 server, with the version endpoint correctly reporting
`3.1.2` while the tag claimed otherwise.

**Fix.** `FLOWISE_VERSION` is now a build argument, so it participates in the layer key, and
the build asserts the installed version matches the requested one and fails loudly otherwise.

#### `connect-sqlite3@0.9.17` — the root cause of upstream issue #6688

Upstream [#6688](https://github.com/FlowiseAI/Flowise/issues/6688) reports that
`flowiseai/flowise:3.1.4` fails to start. **The cause is not 3.1.4 code.**

`connect-sqlite3@0.9.17` changed its constructor so `this.db.exec` is no longer a function,
throwing during session-store setup at boot:

```
TypeError: this.db.exec is not a function
  at new SQLiteStore (connect-sqlite3/lib/connect-sqlite3.js:56:17)
  at initializeDBClientAndStore (dist/enterprise/middleware/passport/SessionPersistance.js:96)
```

Because the dependency was unpinned, this breaks **any** Flowise container built after 0.9.17
was published — not just 3.1.4. Reproduced 2026-08-05:

```
official flowiseai/flowise:3.1.3, built earlier -> connect-sqlite3 0.9.16 -> boots
fresh build of that same flowise@3.1.3, today   -> connect-sqlite3 0.9.17 -> crashes
```

The "3.1.3 works, 3.1.4 is broken" split the community observed is an artifact of **when each
image was built**, not of anything that changed between the two releases. Anyone rebuilding
3.1.3 today to escape the 3.1.4 bug hits the identical crash.

**Fix.** Pinned to `connect-sqlite3@0.9.16` via the `CONNECT_SQLITE3_VERSION` build argument,
with a post-install assertion. Upstream PR
[#6706](https://github.com/FlowiseAI/Flowise/pull/6706) by **PiedPiper911** fixes the same
defect in the TypeScript source for source builds; both are needed for different install paths.

#### `ARG NODE_VERSION=24` could not build

The Dockerfile's default Node version fails to compile `better-sqlite3` under node-gyp:

```
gyp ERR! cwd /usr/local/lib/node_modules/flowise/node_modules/better-sqlite3
gyp ERR! node -v v24.19.0
gyp ERR! not ok
```

Every published image actually runs **Node v20.20.2**, so upstream CI was passing an override
and the broken default went unnoticed. Anyone running a plain `docker build` hit a hard failure.

**Fix.** Defaulted to Node 20, matching the runtime upstream shipped. CI can still override.

### Security

- **All 26 advisories published 2026-08-04 are closed** by this build — 10 critical, 13 high,
  3 medium. This includes `GHSA-8gj2-2cvc-6xx7`, which required 3.1.4 and was previously
  unreachable because 3.1.4 would not start.
- Adopted **CVE-2026-27699** (`basic-ftp` → 5.2.1) and **CVE-2026-33863** (`convict` → 6.2.5)
  from upstream PRs #6683 and #6682 by **anupamme**, which could not be merged before archival.
  Both were re-pinned via `pnpm.overrides` rather than root `dependencies` — these are
  transitive dependencies, and a root entry does not reliably force transitive consumers onto
  the pinned version under pnpm.
- `SECURITY.md` replaced. Upstream's states that vulnerability reports are no longer accepted;
  Flow-Wiser accepts them.

### Added

- `upstream-archive/` — snapshot of the upstream contribution backlog captured before the
  2026-08-10 archive locked it: **347 open pull requests** as git-am-able mailbox patches
  (original authors preserved), **698 open issues**, **116 security advisories**, and
  **100 discussions**.
- `CONNECT_SQLITE3_VERSION` and `FLOWISE_VERSION` build arguments, both with assertions.
- Dependabot, vulnerability alerts, and GitHub Discussions enabled.

### Known issues

Two **non-fatal** node-load failures remain, inherited from upstream dependency drift. The
server starts and serves normally; only these specific nodes are unavailable:

| Error | Node affected |
| --- | --- |
| `@langchain/core` does not export `./utils/uuid` | ReAct Agent (Chat + LLM) |
| `Cannot find module '@smithy/eventstream-codec'` | AWS Bedrock |

Both are tracked for a future release.

### Notes on distribution

Prebuilt images are published at **`dblagbro/flow-wiser`**:

```bash
docker pull dblagbro/flow-wiser:3.1.4-fw3     # or :latest
```

**Licensing note.** As with every Flowise container, this image includes compiled output
from `packages/server/src/enterprise/` and `IdentityManager.ts`, which are under
FlowiseAI's **Commercial License**, not Apache 2.0. Those terms govern your use of those
components wherever you obtain the image. Flow-Wiser cannot relicense them — the
copyright is FlowiseAI's — and an Apache-2.0-only build with them removed is the
project's next major goal. See *Unreleased* below and [FORK.md](FORK.md).

> **This note applies to the `3.1.4-fw3` image only, and is retained because it was
> accurate when that image was published.** Those files have since been removed and
> replaced; the repository is now 100% Apache 2.0. See the *Unreleased* section below.

The image was scanned before publication: no `.env` files, no application database, and
no credential-shaped strings are baked in.

Or build it yourself:

```bash
git clone https://github.com/dblagbro/flow-wiser
cd flow-wiser
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4 \
  --build-arg CONNECT_SQLITE3_VERSION=0.9.16 \
  -f docker/Dockerfile -t flow-wiser/flowise:3.1.4-fw1 docker/
```

See [FORK.md](FORK.md) for the full licensing breakdown.

---

## [Unreleased]

### Changed — the repository is now 100% Apache 2.0

Upstream Flowise was open core. **127 files were not Apache 2.0**:
`packages/server/src/enterprise/` (126 files) plus
`packages/server/src/IdentityManager.ts`, governed by a FlowiseAI Commercial License
forbidding copying, publishing and distribution. They could not be relicensed — the
copyright is FlowiseAI's — so no Flowise fork could be freely redistributed.

Those files have been **deleted**, and the functionality they provided reimplemented
independently under Apache 2.0.

They could not simply be dropped. Flowise 3.0 removed the Apache-2.0 `FLOWISE_USERNAME` /
`FLOWISE_PASSWORD` authentication when it introduced the commercial identity stack, so
deleting the 127 files without replacing them yields an **unauthenticated server** — on a
product carrying 116 published security advisories.

**How the replacement was written.** The entire interface was already available under a
licence permitting us to read it: `packages/ui/` contains no commercially licensed files
and is the client that calls the server, and `packages/server/src/routes/` carries 120
permission call sites. A specification was derived from those sources alone — 53 endpoints,
82 permissions, 12 entities, 363 citations, and 15 explicitly recorded gaps where the
interface did not determine behaviour — and implemented against it. **The commercially
licensed files were never read.** A pre-commit hook and a CI job reject any commit that
modifies a protected path.

- `docs/CLEANROOM-PROTOCOL.md` — the binding process and its prohibitions
- `docs/CLEANROOM-ATTESTATION.md` — evidence, with commands anyone can re-run. Includes a
  disclosed incident in which a malformed command exposed roughly twelve lines of one
  protected file, and the remediation applied
- `docs/SPEC-AUTH-RBAC.md` — the specification and its citations
- `docs/HOW-WE-DID-THIS.md` — the method, written to be reusable, including what went wrong

### Added — identity, RBAC, tenancy and recovery

- **Authentication** under `packages/server/src/identity/`: local password login (bcrypt,
  cost 12, chosen so existing upstream hashes verify unchanged), sessions, and SSO login
  methods.
- **MFA**: TOTP with hashed recovery codes, verified against the published RFC 6238 test
  vectors. Upstream had no MFA.
- **RBAC**: 82 permissions across 19 categories, deny-by-default and validated at
  route-mount time. Upstream shipped 21 permissions with no server-side check at all — the
  client rendered the buttons as `null`, so the restriction was cosmetic.
- **`credentials:reveal` split out of `credentials:manage`**, admin-only and audited, so one
  compromised account no longer yields every stored API key.
- **Audit trail**: one append-only record across all domains, replacing the sign-in-only
  log. RBAC without a record answers "was this allowed?" but never "who did it?".
- **Encryption at rest** with per-record key version, algorithm, nonce and salt, so key
  rotation is resumable and auditable. The key may live off-host, and the server refuses to
  start with the published example value that `.env.example` has been shipping.
- **Multi-tenancy** with organisations, workspaces and a denormalised tenant key on the row,
  so a query that forgets to join cannot cross tenants.
- **Migration from an existing Flowise database**, preserving accounts and access: password
  hashes carry over and still verify, non-user content is byte-identical before and after,
  dry-run writes nothing, and rollback is byte-for-byte. Verified against a copy of a real
  production database.
- **Recovery CLI** — `admin:create`, `admin:reset-password`, `admin:list`, `admin:unlock`,
  `mfa:disable`, `sso:disable`, `session:revoke-all`, and `doctor`. Passwords are read from
  `/dev/tty` and cannot be supplied by flag, pipe or environment variable. `doctor` runs
  nine checks and exits non-zero on failure, so a half-migrated database is a finding rather
  than a mystery.

### Known gaps

Stated plainly rather than omitted:

- Five identity-administration endpoints (`/user`, `/role`, `/organization`,
  `/organizationuser`, `/audit`) return **501 with a reason**. They have no call site in the
  Apache-2.0 client, so implementing them would mean inventing behaviour — exactly what this
  method exists to prevent.
- Chatflow version history is designed but not yet built.

### Planned

- Resolve the two remaining non-fatal node-load failures
- Sweep remaining critical dependency advisories, including the `vm2` sandbox escapes
- Adopt the remaining security pull requests from `upstream-archive/`
- Public product map and contribution queue
- Chatflow version history
- An Apache-2.0-only published container image

---

## Upstream history

Releases before this fork are upstream Flowise releases. All 307 upstream tags and 42 release
records are preserved in this repository.
