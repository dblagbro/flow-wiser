# Flow-Wiser Changelog

All notable changes to the Flow-Wiser community continuation fork.

Flow-Wiser versions are expressed as `<upstream-version>-fw<n>` — the upstream Flowise
release this build is based on, plus a Flow-Wiser revision number. `3.1.4-fw1` is upstream
Flowise 3.1.4 with Flow-Wiser fix set 1 applied.

The left component tracks upstream and only moves when upstream does. Upstream reached end
of life at `3.1.4`, so it is not going to move again: from here, `fw<n>` is the only thing
that advances, however large the change. `3.1.4-fw4` removing the entire commercial
identity stack and replacing it is a bigger step than `fw1` → `fw3`, and it is still
`3.1.4-` on the left, because inventing a `3.2.0` or `4.0.0` would claim an upstream
release that does not exist.

Two consequences worth stating, since both have bitten projects that did this:

- Under strict semver, `3.1.4-fw4` is a **pre-release of** `3.1.4` and therefore sorts
  *below* it. Nothing in this codebase compares versions programmatically — the version
  endpoint reports a string and the About dialog displays it — so this is a labelling
  quirk, not a behavioural one. Do not build release-gating logic on `semver.gt` here.
- A `+` build-metadata suffix would sort correctly but is not a legal Docker tag
  character, so the tag and the package version could not stay identical. They are worth
  more identical.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); latest release
first.

---

## [3.1.4-fw4] — 2026-08-06

**The first Flowise build that is genuinely open source, and the first fresh install that
actually works.**

Two things landed together. The 127 commercially licensed files are gone and their
functionality has been reimplemented under Apache 2.0, so this is the first Flowise
container anyone may freely redistribute. And starting the resulting server for real —
booting it, signing in, using it — turned up a run of defects that no amount of unit
testing had reached, including a fresh install that bricked itself on first login. Those
are fixed here.

`3.1.4-fw1` through `3.1.4-fw3` are **superseded**. They were built before the removal and
contain the commercially licensed compiled output; see *Notes on distribution* below.

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
  `admin:clear-password-change`, `mfa:disable`, `sso:disable`, `session:revoke-all`, and
  `doctor`. Passwords are read from `/dev/tty` and cannot be supplied by flag, pipe or
  environment variable. `doctor` runs nine checks and exits non-zero on failure, so a
  half-migrated database is a finding rather than a mystery.

### Fixed — a fresh install did not work, in six independent ways

Every one of these was found by starting the server and using it. They are listed because
each would have hit the first person to try this build.

#### A fresh install bricked itself at first login

`admin:create` sets `mustChangePassword`. Login then succeeded and **every** subsequent
route answered `403 must_change_password` — and nothing in the codebase ever set that flag
back to false. Not the account router, not the migration tool, and not the recovery CLI;
`admin:reset-password` sets it to `true` as well, by design. The first administrator of a
brand-new instance could sign in and then do nothing, permanently, with no exit over HTTP
or over the CLI. `account.ts` asserted the opposite in its own header.

Every individual piece behaved correctly, which is why nothing caught it until a first
login was driven end to end against a running server.

Fixed with `POST /account/reset-password` — session-authenticated, and it **requires the
current password**, so a stolen session cookie is not by itself enough to seize the
account. A body carrying `tempToken` is the forgotten-password flow, which needs an email
path this build does not have, and is answered `501` rather than a misleading `400`.
Changing another account's password through it is `403`: that is administration, and
administration must not arrive through a self-service route. Every session is revoked and
the caller's own reissued, so the forced change does not end on a login screen.

Plus a second exit for when HTTP is what is unreachable: `flowise admin:clear-password-change
--email <e>` clears the flag without touching the credential, without prompting for a
password and without revoking a session. It is a separate command rather than a flag on
`admin:reset-password`, whose invariant — there is no flag to skip it — stands. And
`resetPassword.jsx` previously demanded a token before it would submit, so a user
redirected there by the 403 landed on a form they could not send; with no token in the URL
it now collects the current password instead.

#### The six-role hierarchy was never created, because nothing called the bootstrap

`BootstrapService` was fully written, fully documented, and had **zero callers**. Every
file that names it imports only its constants; nothing anywhere constructed it or invoked
`run()`. On every fresh install:

- The six roles — super-admin, admin, super-user, org-admin, user, read-only — did not
  exist. The only role that ever existed was the single one `admin:create` seeds on demand
  for the account it is making, so RBAC was fully designed and one-sixth usable: there was
  no `admin`, `user` or `read-only` row to assign anyone to.
- `FLOWISE_BOOTSTRAP_EMAIL` / `FLOWISE_BOOTSTRAP_PASSWORD` did nothing at all.
- `doctor` reported "5 of the six system roles are not seeded" on a healthy instance, which
  is how this surfaced.

Now invoked from `initDatabase`, after migrations and before the identity manager.
Idempotent by construction, so it is safe on every boot including against a database
migrated from Flowise 3.x. One deliberate contract change for the boot path only: an
instance with no identity and none configured is now **reported** rather than thrown, and
the boot log prints the exact command to fix it — throwing inside the transaction rolled
back the six roles it had just seeded, so a first `docker run` with no environment would
have refused to start *and* left nothing behind for `admin:create` to use.

#### A brand-new Postgres database could never be created

Nineteen Postgres migrations default a primary key to `uuid_generate_v4()`, starting with
the very first one. That function lives in the **`uuid-ossp` extension, and nothing in this
repository has ever created it**. A fresh Postgres database aborted on migration one with
`function uuid_generate_v4() does not exist` and the server never started.

This predates the fork. Existing deployments are unaffected because their extension was
created by hand or by a template database long ago, which is why it stayed invisible for
three years. `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` is now issued after
`initialize()` and before `runMigrations()` — the only window that works, since migrations
run in timestamp order and nothing can be scheduled ahead of `Init1693891895163`. A failure
is logged, not fatal: a least-privilege database user legitimately may not hold `CREATE`.

#### `identity_workspace_shared` had no table

The `WorkspaceShared` entity was added during cut-over but never registered in
`identityEntities` and never given a migration, while three shipped Apache-2.0 services
read it at runtime (`services/credentials`, `routes/oauth2`,
`services/openai-assistants-vector-store`). This does not fail at boot — it waits until
someone first exercises credential sharing, OAuth2 token resolution or vector-store
access, then fails on a missing table. Found by the data-migration pass against a copy of
a production database.

`1780000000011-AddIdentityWorkspaceShared` added for all four engines, entity and
migration both registered. DDL executed against real SQLite, `postgres:16-alpine` and
`mariadb:11.8`; the MySQL file is byte-identical to the MariaDB one modulo collation.

#### A fresh database never got the tenancy columns

Deleting the commercially licensed identity stack also unregistered the migrations that
came with it — and those were the ones that added `workspaceId` to the core Apache-2.0
tables. Fifteen entities still declare the column; on a fresh database only three or four
of them had it, depending on the engine.

Worse, on SQLite: migration `1755066758601` rebuilt `chat_flow` with
`FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")`, and `workspace` came from the
commercial migrations, so on a fresh database it does not exist. SQLite checks foreign keys
at DML time, so **every `SELECT` worked and every `INSERT` failed** with
`no such table: main.workspace` — the instance looked healthy until somebody tried to save
a flow.

`1780000000012-AddTenancyColumnsToCoreTables` restores `workspaceId` on all fifteen tables
and `organizationId` plus a composite `(organizationId, workspaceId)` index on the ten that
`REQUIREMENTS-MIGRATION.md` §3a enumerates. The table list is derived from TypeORM entity
metadata rather than written by hand. `chat_flow` is rebuilt forward from its own
`PRAGMA table_info`, preserving every row, column and index, and only when `workspace` is
genuinely absent.

Two follow-ups to the same repair: `PRAGMA table_info` strips the wrapping parentheses off
an expression default, so `DEFAULT (datetime('now'))` came back as `datetime('now')` and
the rebuilt `CREATE TABLE` was rejected — defaults are re-parenthesised on the way out. And
`1780000000002` guarded its column `ALTER`s with `hasColumn` but not its indexes; MySQL and
MariaDB have no `CREATE INDEX IF NOT EXISTS`, so a re-run after a partial failure aborted
on a duplicate key name. Both `CREATE INDEX` and both `DROP INDEX` statements are now
guarded, `down()` included — a `down()` that cannot run against a partially applied `up()`
is precisely the situation rollback exists for.

#### The Apache-2.0 tree did not compile, and would not have booted on Postgres

A source build failed with 13 TypeScript errors across four files. The interesting one:
`sanitizeUser` deleted `User.tempToken` and `User.tokenExpiry`, neither of which exists on
the new identity `User`. Deleting the two lines would have compiled and been wrong —
Flow-Wiser migrates from existing Flowise 3.x databases, whose user rows **do** carry those
columns, in cleartext, and they survive the migration. The sanitizer now strips by name
rather than by type, so a row read back from a migrated database cannot leak them.

Separately, ten date columns across six identity entities were declared `type: 'datetime'`,
which is not a Postgres type, so `DataSource` initialisation raised
`DataTypeNotSupportedError` before the server ever listened. Changing them to `'timestamp'`
then proved not to be a SQLite type either. They now use `type: Date`, which TypeORM maps
per driver.

And `initDatabase()` logged its error and returned, so `config()` then dereferenced an
identity manager the failed block never assigned and the boot died of
`TypeError: Cannot read properties of undefined (reading 'initializeSSO')` — several lines
away from the real cause, and that is the log an operator reads during a failed upgrade.
Startup failures are now fatal at the point of failure.

### Fixed — every recovery command we printed named a binary that does not exist

The CLI's doc strings, error messages, `doctor` findings and migration warnings said
`flow-wiser admin:…`, `flow-wiser doctor`, and so on. There is no `flow-wiser` executable:
`packages/server/package.json` declares `"bin": {"flowise": "./bin/run"}`, and that is the
only name npm ever puts on `PATH`. Every command we printed was uncopyable as written —
including the ones printed at exactly the moment the operator is locked out and has nothing
else to go on.

Corrected to `flowise` in all 44 places rather than adding a second bin alias: `oclif.bin`
is `flowise` and oclif renders its own usage and help lines from it, so an alias would
leave the hand-written half and the generated half disagreeing.

### Fixed — the repository was not actually 100% Apache 2.0, and the images carried the difference

`FORK.md` and `LICENSE.md` both said the 127 commercially licensed files were "not in this
repository … or in any artifact built from it." Both were wrong.

`upstream-archive/patches/` preserves the 347 open upstream pull requests as `git am`-able
mailboxes. **Fifteen of them change files under `packages/server/src/enterprise/` or
`packages/server/src/IdentityManager.ts`** — that is what those pull requests were for — and
a diff hunk carries the surrounding context lines of the file it patches. 196 hunks, 14,224
lines of commercially licensed source, in the tree. `COPY . .` then put all 71 MB of the
archive into every image built from the root `Dockerfile`.

Found by scanning the built image for commercial material rather than assuming that deleting
the files had been enough. It had not been; nothing had ever looked anywhere but at the
files themselves.

- `upstream-archive/strip-protected-hunks.py` removes the hunk bodies and is committed, so
  the operation is reproducible and auditable rather than something that happened once to a
  directory. It decides **only** on the path in a `diff --git a/… b/…` header — no hunk
  content is inspected or matched on, because `docs/CLEANROOM-PROTOCOL.md` requires not
  *reading* those files, not merely not copying them. Headers and diffstat entries are kept,
  with a marker where each hunk was, so the archive still records what each pull request
  touched. Every hunk against an Apache-2.0 path is untouched and still applies.
- `.dockerignore` now excludes `upstream-archive`, `.git`, `.github` and `.githooks`, plus
  `.env` anywhere in the tree, database files and key material. The three `.env` paths listed
  before were enumerated by hand, so a fourth would have been copied in silently.
- The `Dockerfile` gate now fails on any `enterprise/` path segment rather than only compiled
  `dist/enterprise/`, and on `upstream-archive` itself.

Two consequences, recorded in `upstream-archive/MANIFEST.md`: those fifteen patches are no
longer faithful captures of their pull requests, and `pr-6706` — the `connect-sqlite3` fix by
**PiedPiper911** — changed only a protected file and so now applies nothing. It could never
have been applied to this fork regardless, since the file it patches does not exist here.

A third qualification is not fixable and is now stated instead: this fork preserves the
complete upstream history and all 307 release tags, so those files exist at historical
commits and at the `pre-enterprise-deletion` tag. A fork cannot remove that without
destroying the history it exists to preserve. The Apache-2.0-only unit is the current tree
and the images built from it.

### Security

- **`vm2` pinned to 3.11.5 in the source tree**, not only in the npm-install Dockerfile.
  The earlier pin existed solely in `docker/Dockerfile`; `packages/components` still
  declared `vm2 3.11.2` and the lockfile resolved it, so a build from the root Dockerfile —
  the one that produces this release — would have shipped the vulnerable sandbox while the
  README advertised 3.11.5. 3.11.2 is subject to six critical sandbox escapes
  (`GHSA-248r-7h7q-cr24`, `GHSA-6j2x-vhqr-qr7q`, `GHSA-76w7-j9cq-rx2j`,
  `GHSA-m4wx-m65x-ghrr`, `GHSA-rp36-8xq3-r6c4`, `GHSA-v6mx-mf47-r5wg`), and a sandbox
  escape here is the first link in *RCE → read `database.sqlite` → decrypt credentials →
  exfiltrate provider API keys*. Fixed as a direct dependency **and** a `pnpm.overrides`
  entry, for the same reason the fork already learned once with `connect-sqlite3`: a later
  resolution silently undoes an earlier pin.
- The `connect-sqlite3` boot crash behind upstream
  [#6688](https://github.com/FlowiseAI/Flowise/issues/6688) **cannot occur in this build**.
  It threw inside `dist/enterprise/middleware/passport/SessionPersistance.js`, which is one
  of the 127 deleted files; nothing in the tree imports `connect-sqlite3` any more.
- All 26 advisories published 2026-08-04 remain closed, as in `3.1.4-fw1`.

### Changed — build and versioning

- **The root `Dockerfile` is now the release build.** It compiles this repository, from
  which the 127 files are deleted, so nothing derived from them can reach the image.
- **`docker/Dockerfile` cannot produce an Apache-2.0-only image and is documented as such.**
  It runs `npm install -g flowise@<version>`, which fetches FlowiseAI's published package —
  and that package ships the compiled `dist/enterprise/` output and
  `dist/IdentityManager.js` under the Commercial License. That is precisely how `fw1`
  through `fw3` came to contain commercially licensed material. It also cannot build `fw4`
  or later at all, since those versions exist only in this repository and never on npm. It
  is retained for reproducing and diagnosing the upstream images.
- **The root `Dockerfile` takes `FLOWISE_VERSION`** and asserts it against
  `packages/server/package.json` before installing anything, so the tag and the version the
  server reports are one fact rather than two.
- **The build fails if any commercially licensed artifact is present**, anywhere on the
  image filesystem: any `dist/enterprise/` path, or any `IdentityManager` file. `pnpm
  install` fetches from npm and upstream's package still carries that output, so a
  dependency edge could reintroduce it silently. It now cannot be built at all if that
  happens.
- **The version the server reports is now the Flow-Wiser version.** `GET /api/v1/version`
  reads the nearest `package.json`, which resolves to `packages/server/package.json`. Every
  `fw` image before this one reported a bare `3.1.4` — the same class of
  tag-does-not-match-contents problem this fork was started to fix. It now answers
  `3.1.4-fw4`.

### Known gaps

Stated plainly rather than omitted:

- Five identity-administration endpoints (`/user`, `/role`, `/organization`,
  `/organizationuser`, `/audit`) return **501 with a reason**. They have no call site in the
  Apache-2.0 client, so implementing them would mean inventing behaviour — exactly what this
  method exists to prevent.
- The forgotten-password flow (`POST /account/reset-password` with a `tempToken`) returns
  **501**. There is no transactional email path in this build, so no token can be issued.
  The forced-password-change flow through the same URL does work.
- Chatflow version history is designed but not yet built.
- **The denormalised tenant key is not written on create.** `REQUIREMENTS-MIGRATION.md` §3a
  requires `organizationId` on every tenant-scoped resource row; the migrations add the column
  and the index, but the write paths do not populate it, so a newly created chatflow has
  `organizationId` NULL while its workspace has one. `doctor` catches it and exits non-zero:
  *"1 row(s) carry a tenant key that disagrees with their workspace"*. Nothing is currently
  served to the wrong tenant, because scoping still goes through `workspaceId` — but a query
  that filters on organization alone, which §3a exists to make safe, would miss those rows.
  §3a's central enforcement layer is the missing piece; until it lands, expect `doctor` to
  report this on any instance where content has been created.
- The two non-fatal node-load failures from `3.1.4-fw1` remain: `@langchain/core` does not
  export `./utils/uuid` (ReAct Agent), and `Cannot find module '@smithy/eventstream-codec'`
  (AWS Bedrock). The server starts and serves normally; only those nodes are unavailable.
- `vm2` is pinned, not replaced. It has produced a fresh escape in essentially every release
  line. Replacing it outright (`isolated-vm`), or disabling custom-code nodes on
  internet-facing deployments, is the real fix.
- MySQL migrations are verified by inspection rather than execution — no MySQL image will
  unpack on the build host. The files are byte-identical to the MariaDB ones modulo
  collation, and MariaDB is executed.

### Planned

- Resolve the two remaining non-fatal node-load failures
- Replace `vm2` rather than pinning it
- Sweep remaining critical dependency advisories
- Adopt the remaining security pull requests from `upstream-archive/`
- Chatflow version history
- Public product map and contribution queue

### Notes on distribution

**`3.1.4-fw4` is the first freely redistributable Flowise image.** Everything in it is
Apache 2.0.

```bash
docker pull dblagbro/flow-wiser:3.1.4-fw4     # or :latest
curl -s http://localhost:3000/api/v1/version  # {"version":"3.1.4-fw4"}
```

Or build it yourself, from source, and watch the gates fire:

```bash
git clone https://github.com/dblagbro/flow-wiser && cd flow-wiser
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4-fw4 \
  -t dblagbro/flow-wiser:3.1.4-fw4 .
```

Note the `-f`-less form and the `.` context: this is the **root** Dockerfile, not
`docker/Dockerfile`.

**The `3.1.4-fw1` through `3.1.4-fw3` images are superseded and are not
redistributable.** They were built from `docker/Dockerfile`, which installs FlowiseAI's
published npm package, and that package contains the compiled `dist/enterprise/` output and
`dist/IdentityManager.js` under FlowiseAI's Commercial License. Those terms govern those
images wherever you obtain them. Flow-Wiser could not and did not relicense them. If you
pulled an `fw1`–`fw3` image, `fw4` is the one to move to.

The image was scanned before publication: no `.env` file, no application database, no
credential-shaped strings, and no `enterprise/` path or `IdentityManager` artifact
anywhere on its filesystem — the last of which the build now enforces rather than checks
after the fact.

See [FORK.md](FORK.md) for the full licensing breakdown.

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
docker pull dblagbro/flow-wiser:3.1.4-fw3
```

**Licensing note.** As with every Flowise container, this image includes compiled output
from `packages/server/src/enterprise/` and `IdentityManager.ts`, which are under
FlowiseAI's **Commercial License**, not Apache 2.0. Those terms govern your use of those
components wherever you obtain the image. Flow-Wiser cannot relicense them — the
copyright is FlowiseAI's — and an Apache-2.0-only build with them removed is the
project's next major goal. See [FORK.md](FORK.md).

> **Superseded by `3.1.4-fw4`, which is Apache-2.0-only.** This note applies to the
> `3.1.4-fw1` through `3.1.4-fw3` images and is retained unedited because it was accurate
> when they were published. Those files have since been removed and replaced; the
> repository, and the `3.1.4-fw4` image built from it, are 100% Apache 2.0. `fw1`–`fw3`
> remain non-redistributable and `:latest` no longer points at them.

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

## Upstream history

Releases before this fork are upstream Flowise releases. All 307 upstream tags and 42 release
records are preserved in this repository.
