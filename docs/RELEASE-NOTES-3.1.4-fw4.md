# Flow-Wiser `3.1.4-fw4`

**2026-08-06 — Flowise, actually open source. And a fresh install that actually works.**

```bash
docker pull dblagbro/flow-wiser:3.1.4-fw4     # or :latest
curl -s http://localhost:3000/api/v1/version  # {"version":"3.1.4-fw4"}
```

---

## Why this one matters

**Flowise was never fully open source.** 127 files —
`packages/server/src/enterprise/` (126) plus `packages/server/src/IdentityManager.ts` —
carried a FlowiseAI Commercial License that forbids copying, publishing and distribution.
Every Flowise container ever published, official or otherwise, contained the compiled
output of those files. So nobody could legally redistribute a Flowise image, and no fork
could fix that by deleting them: Flowise 3.0 had removed the old Apache-2.0
`FLOWISE_USERNAME` / `FLOWISE_PASSWORD` login when it introduced the commercial identity
stack, so deleting them leaves you with an **unauthenticated server** — on a product
carrying 116 published security advisories.

`3.1.4-fw4` closes that. The 127 files are deleted, and authentication, RBAC, SSO, MFA,
audit, encryption at rest and multi-tenancy have been reimplemented from scratch under
Apache 2.0. Nothing was relicensed; nothing was reverse engineered; the commercially
licensed files were never read.

**This is the first Flowise container image anyone may freely redistribute.**

## What you get

| | |
| --- | --- |
| **Redistributable** | 100% Apache 2.0. No carve-outs, no `FLOWISE_EE_LICENSE_KEY`, nothing gated |
| **Authentication** | Local password login (bcrypt cost 12), sessions, SSO login methods |
| **MFA** | TOTP with hashed recovery codes, checked against the RFC 6238 test vectors. Upstream had none |
| **RBAC** | 82 permissions across 19 categories, deny-by-default, **enforced server-side** |
| **Credential safety** | `credentials:reveal` split out of `credentials:manage` — admin-only and audited, so one compromised account no longer yields every stored API key |
| **Audit trail** | One append-only record across all domains, replacing a sign-in-only log |
| **Encryption at rest** | Per-record key version, algorithm, nonce and salt, so key rotation is resumable and auditable |
| **Multi-tenancy** | Organisations and workspaces, with the tenant key denormalised onto the row so a query that forgets to join cannot cross tenants |
| **Recovery** | A nine-command CLI. Passwords are read from `/dev/tty` and cannot be given by flag, pipe or environment variable |
| **Migration** | From an existing Flowise 3.x database. Password hashes carry over and still verify; non-user content is byte-identical before and after; rollback is byte-for-byte |

Two of these are things upstream never had at all. **MFA did not exist.** And upstream's
21 permissions had **no server-side check** — the client rendered the buttons as `null`, so
the restriction was cosmetic and any authenticated user could call the endpoint directly.

## A fresh install works now. It did not before.

Getting a real server up and actually signing into it found six independent defects that
no amount of unit testing had reached. Each would have hit the first person to try this
build.

- **A fresh install bricked itself at first login.** `admin:create` sets
  `mustChangePassword`; login then succeeded and every other route answered
  `403 must_change_password` — and *nothing in the codebase ever set that flag back to
  false*. The first administrator of a new instance could sign in and then do nothing,
  permanently, with no exit over HTTP or over the CLI. There are now two exits:
  `POST /account/reset-password` (session-authenticated, and it requires the current
  password, so a stolen cookie is not enough to seize the account) and
  `flowise admin:clear-password-change` for when HTTP is what is unreachable.
- **The six-role hierarchy was never created**, because `BootstrapService` had zero
  callers. RBAC was fully designed and one-sixth usable: the only role that ever existed
  was the one `admin:create` seeds on demand, so there was no `admin`, `user` or
  `read-only` row to assign anyone to. `FLOWISE_BOOTSTRAP_EMAIL` /
  `FLOWISE_BOOTSTRAP_PASSWORD` did nothing at all.
- **A brand-new Postgres database could never be created.** Nineteen Postgres migrations
  default a primary key to `uuid_generate_v4()`, which lives in the `uuid-ossp` extension —
  and nothing in Flowise has ever created it. A fresh database aborted on migration one and
  the server never started. This predates the fork by three years; it stayed invisible
  because every existing deployment's extension was created by hand or by a template
  database long ago.
- **`identity_workspace_shared` had no table.** The entity was never registered and never
  given a migration, while three shipped services read it at runtime. That does not fail at
  boot — it waits until somebody first uses credential sharing, OAuth2 token resolution or
  vector-store access.
- **A fresh database never got the tenancy columns.** Removing the commercial identity
  stack also unregistered the migrations that added `workspaceId` to the core tables. On
  SQLite it was worse than missing columns: `chat_flow` carried a foreign key to a
  `workspace` table that no longer existed, and SQLite checks foreign keys at DML time — so
  **every read worked and every write failed**. The instance looked healthy right up until
  somebody tried to save a flow.
- **The tree did not compile, and would not have booted on Postgres.** Thirteen TypeScript
  errors, plus ten date columns typed in a way no engine accepted. And `initDatabase()`
  swallowed its own failure, so a broken boot died several lines later with a `TypeError`
  about something unrelated — which is exactly the log an operator reads during a failed
  upgrade.

Also fixed: **every recovery command we printed named a binary that does not exist.** The
CLI's errors and `doctor` findings said `flow-wiser admin:…`; the executable is `flowise`.
Those messages print at precisely the moment the operator is locked out and has nothing
else to go on, and they were uncopyable as written. All 44 of them now say `flowise`.

## One more thing we found by checking instead of assuming

Before publishing, the built image was scanned for commercial material rather than trusted
on the strength of having deleted the files. It was not clean.

`upstream-archive/` preserves the 347 open upstream pull requests as `git am`-able patches,
captured before the 2026-08-10 archival. **Fifteen of them change files under
`packages/server/src/enterprise/` or `IdentityManager.ts`** — that is what those pull
requests were for — and a diff hunk carries the surrounding lines of the file it patches.
196 hunks, 14,224 lines, in the tree and in every image built from it, including `fw1`
through `fw3`.

The hunk bodies are gone, removed by a committed, reproducible script that decides only on
the file path in each `diff --git` header and never inspects hunk content. Paths and
diffstat entries were kept, so the archive still records what each pull request touched.
`upstream-archive/` is now excluded from images entirely, and the build fails if it appears
in one.

One qualification cannot be fixed and is stated rather than glossed: this fork preserves the
complete upstream history and all 307 release tags, so those files exist at historical
commits and at the `pre-enterprise-deletion` tag, under the terms that applied when
FlowiseAI published them. No fork can remove that without destroying the history it exists
to preserve. **The Apache-2.0-only unit is the current tree and the images built from it.**

## Security

- **`vm2` is pinned to 3.11.5 in the source tree**, not only in the npm-install Dockerfile.
  Before `fw4` the pin lived solely in `docker/Dockerfile`, so a build from source — which
  is how this release is built — would have shipped the vulnerable 3.11.2 while the README
  advertised 3.11.5. 3.11.2 is subject to six critical sandbox escapes, and a sandbox
  escape here is the first link in *RCE → read `database.sqlite` → decrypt credentials →
  exfiltrate provider API keys*.
- **The `connect-sqlite3` crash behind upstream
  [#6688](https://github.com/FlowiseAI/Flowise/issues/6688) cannot occur.** It threw inside
  one of the 127 deleted files. Nothing in the tree imports `connect-sqlite3` any more.
- All 26 advisories published 2026-08-04 remain closed (10 critical, 13 high, 3 medium).
- **The build fails if any commercially licensed artifact is present** anywhere on the image
  — any `dist/enterprise/` path, any `IdentityManager` file. `pnpm install` fetches from
  npm, and upstream's published `flowise` package still carries that compiled output, so a
  dependency edge could reintroduce it silently. It now cannot be built at all if that
  happens.

## Upgrading

**From `3.1.4-fw1`, `fw2` or `fw3`:** change the tag. Those images are superseded and are
**not redistributable** — they were built from `docker/Dockerfile`, which installs
FlowiseAI's published npm package, and that package contains the commercially licensed
compiled output.

**From upstream Flowise 3.x:** your database migrates. Password hashes carry over and still
verify — bcrypt cost 12 was chosen for exactly that reason — and non-user content is
byte-identical before and after. Run `flowise doctor` afterwards; it runs nine checks and
exits non-zero, so a half-migrated database is a finding rather than a mystery.

**Note the version string.** `GET /api/v1/version` now answers `3.1.4-fw4`. Every `fw`
image before this one reported a bare `3.1.4` — the same class of
tag-does-not-match-contents problem this fork was started to fix.

## Known gaps

Stated plainly rather than omitted.

- Five identity-administration endpoints (`/user`, `/role`, `/organization`,
  `/organizationuser`, `/audit`) return **501 with a reason**. They have no call site in the
  Apache-2.0 client, so implementing them would mean inventing behaviour — exactly what the
  clean-room method exists to prevent.
- The **forgotten-password** flow returns **501**: there is no transactional email path in
  this build, so no token can be issued. The forced-password-change flow through the same
  URL does work.
- **Chatflow version history** is designed but not built.
- **The denormalised tenant key is not written on create.** `REQUIREMENTS-MIGRATION.md` §3a
  requires `organizationId` on every tenant-scoped resource row. The column and its index
  exist; the write paths do not populate them, so a newly created chatflow has
  `organizationId` NULL while its workspace has one. `flowise doctor` catches this and exits
  non-zero, so **expect one failure from `doctor` on any instance where content has been
  created** until §3a's central enforcement layer lands. Nothing is served to the wrong
  tenant today — scoping still runs through `workspaceId` — but a query filtering on
  organization alone, which is exactly what §3a exists to make safe, would miss those rows.
- Two **non-fatal node-load failures** remain, inherited from upstream dependency drift.
  The server starts and serves normally; only these nodes are unavailable:
  `@langchain/core` does not export `./utils/uuid` (ReAct Agent), and
  `Cannot find module '@smithy/eventstream-codec'` (AWS Bedrock).
- **`vm2` is pinned, not replaced.** It has produced a fresh escape in essentially every
  release line. Replacing it outright (`isolated-vm`), or disabling custom-code nodes on
  internet-facing deployments, is the real fix.
- **MySQL migrations are verified by inspection, not execution** — no MySQL image will
  unpack on the build host. The files are byte-identical to the MariaDB ones modulo
  collation, and MariaDB is executed.

## Building it yourself

```bash
git clone https://github.com/dblagbro/flow-wiser && cd flow-wiser
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4-fw4 \
  -t dblagbro/flow-wiser:3.1.4-fw4 .
```

That is the **root** `Dockerfile` — note the `.` context and the absence of `-f`. It
compiles this repository. `docker/Dockerfile` does *not* build a release: it installs
FlowiseAI's published npm package, which still contains the commercially licensed compiled
output, and it cannot build `fw4` at all because that version exists only in this
repository and never on npm.

Running it needs a writable data directory and four secrets, each a fresh
`openssl rand -base64 32`:

```bash
docker run -d --name flow-wiser -p 3000:3000 --user root \
  -e DATABASE_TYPE=sqlite -e DATABASE_PATH=/data \
  -e SECRETKEY_OVERWRITE="$(openssl rand -base64 32)" \
  -e FLOWISE_SECRETKEY_OVERWRITE="$(openssl rand -base64 32)" \
  -e IDENTITY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e FLOWISE_SESSION_PEPPER="$(openssl rand -base64 32)" \
  -v flow-wiser-data:/data \
  dblagbro/flow-wiser:3.1.4-fw4

docker exec -it flow-wiser flowise admin:create --email you@example.com --role super-admin
```

The password is prompted on `/dev/tty` and cannot be piped, passed as a flag, or read from
the environment. The first sign-in will require you to change it, which is the flow that
did not exist before this release.

`flowise doctor` will tell you whether the result is healthy, and exits non-zero if not.

One note if you are scripting against the API: requests need the header
`x-request-from: internal`. Without it a request is treated as an external API-key call and
answered `401`. The shipped UI sets it (`packages/ui/src/api/client.js`).

## How this was done legally

The interface was already readable under a licence that permits it. `packages/ui/` contains
no commercially licensed files and is the client that calls the server, so it specifies the
complete HTTP contract; `packages/server/src/routes/` carries 120 permission call sites. A
specification was derived from those Apache-2.0 sources alone — 53 endpoints, 82
permissions, 12 entities, 363 citations, and 15 explicitly recorded gaps where the interface
did not determine behaviour — and implemented against it.

**The commercially licensed files were never read**, and never fed to any tool for
summarising or porting. A pre-commit hook and a CI job reject any commit that modifies a
protected path — deletion is permitted, modification is not, because editing implies having
read.

- [`docs/CLEANROOM-PROTOCOL.md`](CLEANROOM-PROTOCOL.md) — the binding process
- [`docs/CLEANROOM-ATTESTATION.md`](CLEANROOM-ATTESTATION.md) — the evidence, with commands
  you can re-run, including a disclosed incident where a malformed command exposed roughly
  twelve lines of one protected file, and the remediation applied
- [`docs/HOW-WE-DID-THIS.md`](HOW-WE-DID-THIS.md) — the method, written to be reusable on
  other open-core projects

## Licensing

100% Apache 2.0, no exceptions. Read [`FORK.md`](../FORK.md) before redistributing, and see
[`NOTICE`](../NOTICE) for attribution.

This fork is **not affiliated with, endorsed by, or sponsored by FlowiseAI, Inc. or
Workday, Inc.** "Flowise" is used nominatively, to identify the upstream project this code
derives from. Apache 2.0 §6 grants no trademark rights.

**Full detail:** [CHANGELOG.md](../CHANGELOG.md).
