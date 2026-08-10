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

## [3.1.4-fw9] — 2026-08-10

The remaining thirteen findings from the `fw8` QA regression. `fw8` fixed the nine that blocked a
release; this closes the rest, plus a production data defect found while investigating a broken
canvas.

### Unauthenticated surfaces

- **The MCP Streamable-HTTP transport validated a hostname once and never again.** It called
  `checkDenyList(url)` and then handed the URL to the SDK with no custom `fetch`, so the SDK
  followed redirects and re-resolved DNS itself — neither checked. The SSE fallback *in the same
  function* already passed `secureFetch`, which walks redirects manually and pins the validated IP.
  The guard existed; the path that normally runs did not use it.
- **`/chatflows-streaming/:id`** loaded and parsed any flow's `flowData` by UUID with no ownership
  check, leaking existence (200 vs a 500 naming the internal service) and node-graph detail.
- **`POST /leads`** accepted anonymous writes onto private flows and persisted them into the owner's
  lead list. Capturing a lead is the widget's job, so anonymous is legitimate — but only against a
  flow that is actually published.

### Tenancy

Credentials, tools, variables and assistants set `workspaceId` on create and never the denormalised
`organizationId`. Chatflows got this in `fw6`; the other four were missed. The consequence is that
`flowise doctor` goes **red on a fresh instance after ordinary use** — QA reproduced it at 305/305.
Production is clean today only because its rows predate the API write path.

### Operations

- **`audit:export --verify` could not fail.** It printed a digest and exited 0 whether or not it
  matched; on deliberately tampered data it printed the *different* digest with no warning. The
  tamper-evidence control worked only if an operator compared 64 hex characters by eye. `--expect
  <sha256>` now exits 3 on mismatch.
- **A missing `FLOWISE_SESSION_PEPPER` no longer starts a server nobody can log into.** It logged an
  error and kept serving. The code's stated reason for warning rather than throwing was that
  `initDatabase` swallowed the exception — that catch now rethrows, so the reasoning was stale and
  the behaviour is corrected to match it.
- **`HEALTHCHECK` added.** There was none, while compose pairs `restart: always` with no health
  condition — which never restarts a hung-but-alive process.
- **`node` execs as PID 1.** `pnpm start` put four processes under PID 1, so `docker stop` returned
  ExitCode 1 with `ELIFECYCLE` instead of 0/143 and nothing reaped orphans. Every clean stop looked
  like a crash, which is what makes a real crash unremarkable.

### Observability

28,639 unauthorized requests produced **four log lines and zero audit rows**. Denials are now counted
and summarised once per window — a smoke alarm rather than per-denial logging, which would turn an
auth incident into a log-flood incident and hand an attacker a cheap way to fill the disk.

### Supply chain

`docker-image-dockerhub.yml` was dispatchable and pushes to `flowiseai/flowise` — **upstream's**
namespace — with this fork's token, building the non-redistributable image. The project's one
documented licence incident was a button press away, gated only by a comment. Every job now carries
`if: false`. `CODEOWNERS` added for `.github/**` and the security-critical paths.

### Accessibility, measured rather than eyeballed

- **Focus indicators.** None existed anywhere in the theme; tabbing the whole sidebar reported
  `outline: none`. Applied globally at `:focus-visible` — the defect was that each component had to
  remember — so pointer users still see nothing. Ring contrast 5.72:1 to 8.52:1 against the surfaces
  it lands on, against WCAG 1.4.11's 3:1.
- **Disabled text.** `text.disabled` was undefined, so MUI fell back to its *light-theme*
  `rgba(0,0,0,0.26)`. On the dark background that is **1.06:1** — black on near-black. Now 6.03:1
  dark and 4.62:1 light, both clearing AA.

### One production flow could not be opened

`"[object Object]" is not valid JSON`. SQLite storage classes are per **value**, not per column, so a
row whose `flowData` was once written as bytes is stored `BLOB` even though the column is declared
`text` — and the driver returns a Buffer, which serialises to an object. 24 of 25 rows were `text`;
one was `blob`.

Fixed at both levels: a column transformer normalises Buffer→string on every read path, and the
single production row was converted with `CAST(... AS TEXT)` behind a `typeof(flowData)='blob'`
guard, after a consistent `.backup`. Content md5 identical before and after.

The transformer matters more than the data fix — no migration can stop an import or a raw `INSERT`
reintroducing it silently.

### Known open, and why

`/vector/upsert/` dual-auth is a design change (valid API key **or** session with permission), not a
guard — adding one blind would break every key-based integration. `CODEOWNERS` does nothing until
"Require review from Code Owners" is enabled on `main`. The production compose is now `640` but still
holds literal secrets. The brand primary is 3.12:1 against white and changing it is a brand decision,
not a defect to fix quietly.

---

## [3.1.4-fw8] — 2026-08-10

**The line in the sand**, and the first release to be gated on a full QA regression rather than
released and then examined. `docs/BASELINE-3.1.4-fw8.md` states what is verified and by which check;
`docs/bug-log.md` lists all 27 findings with status; `docs/release-readiness.md` states what is still
open.

A deep QA pass across seven domains — static/build, API, sandbox+crypto, web security+supply chain,
containers/infra, ops/CLI/backup-restore, performance, and UI/accessibility — found 27 issues. Nine
were release blockers. All nine are fixed here.

### The one that was live

`GET /api/v1/public-chatbotConfig/:id` returned the **complete flow definition** — node graph, model
choices, which credential types are wired — for flows explicitly marked `isPublic = 0`, to
unauthenticated callers on the public internet. Confirmed against the running production instance:
48,523 bytes, HTTP 200, no credentials required. No credential *values* were exposed.

Its sibling `/public-chatflows/:id` had the correct check, which is what proves this was an omission
rather than a decision. Both endpoints now share **one** authorization function, because two copies
of a security check is one copy and one liability — and that is precisely how one of them came to
have no copy at all.

### `read-only` was not read-only

A user holding only `*:view` could run flows (`internal-prediction` — LLM spend, and in-process code
execution when the flow contains a code node), write embeddings, generate agentflows, and DELETE
conversation history with a 200. Guards added to four routers, with read/abort/delete separated by
severity. `/vector/upsert/` is deliberately left unguarded: it is the API-key surface external
integrations call, and making it "valid key OR session with permission" is a design change rather
than a guard.

### A fresh install could not be installed, and then could not be used

Neither `IDENTITY_ENCRYPTION_KEY` nor `FLOWISE_SESSION_PEPPER` appeared in **any** `.env.example`,
while the server hard-refuses to issue sessions without the pepper. The README's Compose quickstart
pointed at `docker/`, which pins `flowiseai/flowise:latest` — the non-redistributable upstream image
this fork exists to replace.

And once past that, the first login was impossible: `admin:create` sets `mustChangePassword`, the
password-change middleware is mounted globally so it answered the browser's **document** request for
`/reset-password` with 403 JSON, and the client mapped every 403 to `/unauthorized` — leaving the
server's own `redirectTo` hint as unreachable code. The account could only be recovered from the
host. That was the out-of-box experience.

### Silent unrecoverability

Restoring a backup without its encryption key — or with a different key carrying the same version
number, which a default of `1` makes likely — produced an instance that started cleanly, passed
`doctor` 9 of 9, and reported "nothing to do" from `credential:rotate-encryption`. The first symptom
would be a 500 days later, possibly after the good backup had aged out of retention.

`doctor` now performs a **real decrypt** of one record per distinct key version, and rotation probes
before it trusts a version number. Verified on 305 credentials: wrong key fails and exits 1, right
key passes and rotates normally.

### Also fixed

- **`::`** was missing from the SSRF deny list and routes to loopback — `curl http://[::]:3100/`
  reached a live service. `100.64.0.0/10` and `198.18.0.0/15` added with it.
- The **argon2** redaction pattern excluded `,`, and every real PHC string contains
  `m=65536,t=3,p=4` — so matching stopped at the first comma and salt and digest survived in clear.
- `path-to-regexp` was pinned **eight majors** below what express-5 consumers declare, breaking route
  registration for the Brave-MCP node and the MCP OAuth router. Third bad override found in a day.
- `flowise user <email> <password>` removed: argv password, no audit row, working login.
- `/sso-config` blanked the **entire application** on an empty API response. Fixed at source, and
  every protected route now sits behind a real React error boundary — the existing `ErrorBoundary`
  was a display component that cannot catch a thrown render or effect.

### The pattern, and the rule adopted because of it

Four controls in this repository **could not fail**: the release gate (accepted `skipped` as success,
and interpolated a tag name into a shell command — a git tag may legally contain `$(...)`),
`audit:export --verify` (prints a digest, exits 0 either way), `credential:rotate-encryption`
(compared key versions, not key identity), and the Dockerfile version assertion (only fires when
given the argument the docs omit). Three verifications performed during the work had the same defect:
`git push --dry-run` against a protected branch, an IP allowlist tested from inside the allowlist,
and the release gate tested only with a cooperative tag.

**A guard now ships with a test that feeds it the bad input and asserts refusal.** See
`packages/server/test/security/negative-controls.test.ts` — written first, watched fail, then fixed.

### Known open

`/vector/upsert/` dual-auth; credentials written with a null tenant key (production is clean, but it
will drift); a missing session pepper starts a live-but-unusable server; `pnpm` as PID 1 makes a clean
stop exit 1; no HEALTHCHECK; the MCP transport skips the SSRF guard on redirects; an unauthorized
burst of 28,639 requests produced 4 log lines and 0 audit rows; and the accessibility set (focus
indicators, contrast). Full list in `docs/bug-log.md`.

---

## [3.1.4-fw7] — 2026-08-08

Adds a code-execution kill switch, audit retention, and fixes a runtime bug that shipped in fw6.

### Fixed

**`audit:export --from` / `--to` failed at runtime.** Both filters referenced `e.createdDate`; the
column is `occurredAt`. TypeScript could not catch it because the reference lives inside a
query-builder string, so it compiled clean and shipped. It surfaced only when `audit:prune` made the
same mistake in a *typed* context, where the compiler did reject it.

Worth recording: "0 TypeScript errors" verified the typed call sites and silently skipped the
string-embedded query. A compile pass is not coverage of anything expressed as a string.

### Added

**`CODE_EXECUTION_MODE`** — `disabled` | `e2b` | `vm2`. Defaults to previous behaviour.

- **`e2b` now fails closed.** Previously the remote sandbox was selected only by the presence of
  `E2B_APIKEY`, and its absence fell back silently to the in-process sandbox. That is exactly how an
  independent assessment concluded code ran off-host and rated the `vm2` risk moot, while the key was
  unset and everything ran locally. An operator who asks for off-host execution now gets it or an
  error.
- **`disabled`** removes the risk class rather than mitigating it. A deployment with no code-execution
  nodes has no reason to carry an in-process sandbox at all, and no sandbox is stronger than not
  executing.

**Boot-time sandbox posture.** The server states which sandbox will execute code and warns explicitly
when it is `vm2`. The assessment above reached a wrong conclusion because the posture was not
observable without reading source and checking an environment variable.

**`flowise audit:prune`** — retention enforcement. Default 400 days; refuses below the 365 days
PCI-DSS 10.7 requires unless `--force`; refuses to delete without `--i-have-exported`, because
deleted audit rows are unrecoverable. Its own audit record is written *after* the delete, so a prune
can never fall inside the window it describes and erase the evidence of pruning.

### Still open

`vm2` remains deprecated and unpatchable. Its published escapes are blocked here by configuration —
`Proxy` removed from the sandbox, `eval: false` defeating the `Function('return process')` primitive
every public technique relies on — and an independent assessment confirmed all four fail. That is
real, and it is still a mitigation resting on configuration rather than architecture.

`isolated-vm` was deliberately not rushed in: it is a native module in a project where native builds
are already why Node 24 is unusable, and it does not sandbox `require`, so library-using flows would
break. It deserves its own change.

---

## [3.1.4-fw6] — 2026-08-08

Fixes three findings from a security retest, and reworks credential encryption so the product can
support standard compliance claims.

### Fixed

**Runtime variables read arbitrary `process.env`** (HIGH on a multi-user instance). A runtime
variable resolved `process.env[name]` with the name supplied by the user and no allowlist, then
injected the result into code nodes *and* prompt templates. Creating one is gated on
`variables:create` — a non-admin permission that `org-admin` and `user` both hold. Any authoring user
could name a variable `JWT_AUTH_TOKEN_SECRET`, reference it in a flow, read the token-signing key,
and forge tokens for any user in any tenant.

Runtime variables now require a `FLOWISE_VAR_` prefix. A prefix rather than a denylist because a
denylist must anticipate every secret the process will ever hold — including ones added later and by
the operator's own configuration — so it is wrong by default. A prefix inverts that: the environment
must opt in.

**`GET /credentials/:id` returned decrypted plaintext.** The route requires `credentials:create` or
`credentials:update`, which **four of the six system roles hold**, including `org-admin` and `user` —
both explicitly designed to see credential *records* but never *values*. And `credentials:reveal`,
the admin-only grant that split exists for, was enforced on **no route at all**. The two endpoints
were also inverted: `/:id/reveal` redacted while the plain `GET` revealed.

`GET` now redacts. `/:id/reveal` genuinely reveals, requires `credentials:reveal`, and is audited.
`admin` and `super-admin` hold it; `super-user`, `org-admin`, `user` and `read-only` do not — so a
super-user can audit the entire system without ever holding a key, which is what the design always
claimed.

**`node:`-prefixed builtins bypassed the sandbox denylist.** `require('node:fs')` is an alias for
`require('fs')`, and the denylist matched exact strings. Not reachable in the shipped configuration,
but it would have stopped protecting silently the moment an operator allowlisted a `node:`-prefixed
module.

**Upgrading a Flowise 3.x database hid every flow.** The bootstrap minted a new workspace while
existing content carried the pre-fork `workspaceId`, so an upgraded instance showed an empty screen
with all data intact but out of scope. It now adopts the legacy organization and workspace ids —
adoption rather than re-stamping, so a rollback leaves user data untouched.

**The denormalised tenant key was never written.** Migration `1780000000012` added `organizationId`
to ten content tables and nothing populated it, so `doctor` reported a tenancy failure on any
instance holding content and exited 1. A health gate that always fails is not a health gate. It is
now resolved from the workspace, so the two can never disagree.

**The audit integrity claim could not be verified.** The manifest said "re-export the same range to
reproduce this digest", but there was no way to pin a range, and every export appends its own audit
event — so an unbounded re-export could never match. A control that cannot be exercised is worse than
none, because it reads as evidence. `--from-seq` / `--to-seq` pin the range and `--verify` runs as a
pure read.

### Changed — credential encryption

Credentials used `crypto-js` AES with a single static passphrase: no authentication, MD5-based key
derivation, no key version, no algorithm agility. Each of those independently disqualifies SOC 2
CC6.1, HIPAA §164.312(a)(2)(iv) and PCI-DSS 3.5–3.6.

Now AES-256-GCM with HKDF-SHA-256 and per-record nonce, salt and key version, reusing the AEAD the
identity layer already had. **Both formats decrypt**, detected from the payload, so an upgraded
database holding a mix works either way and each record migrates on its next save.

`flowise credential:rotate-encryption` makes rotation a procedure rather than an incident: dry run by
default, every record proven to round-trip before any write, one transaction, and a single failure
aborts the entire run — a half-rotated table is worse than an unrotated one, because some flows work
and the failures look random.

### Added

`flowise audit:export` — JSONL plus a SHA-256 manifest over an explicit `seqNo` range, for review and
evidence retention. The manifest states the limit of its own claim: this is tamper *evidence*, not
tamper *proofing*. An actor with database write access could rewrite history and re-export cleanly.

`docs/COMPLIANCE-POSTURE.md` — control mapping for SOC 2, HIPAA and PCI with evidence and named gaps.

---

## [3.1.4-fw5] — 2026-08-07

**Security release.** Fixes an independently assessed, empirically confirmed vulnerability that
allowed a code node to read every stored credential, plus the unauthenticated execution path that
would have made it reachable without a login.

Findings came from a sanctioned security assessment against a live instance. Where the assessment
proved something, this entry says so; where it suspected something and the code turned out already
hardened, that is said too.

### Fixed

#### Code nodes could `require('fs')` and read the entire credential database — CONFIRMED, HIGH

`TOOL_FUNCTION_BUILTIN_DEP` was concatenated onto the code sandbox's require allowlist with no
filtering, and the sandbox's secure wrappers mock only `axios`/`node-fetch` — never `fs`. A
deployment setting `TOOL_FUNCTION_BUILTIN_DEP=crypto,fs,path`, as this one did, gave any code node
the host filesystem.

Demonstrated with benign proofs replicating the application's exact NodeVM configuration:

    fs.readFileSync('/root/.flowise/database.sqlite')  → "SQLite format 3"
    fs.readdirSync('/mnt/s')                           → the mounted NAS, readable and writable

That is every stored credential, secret and API key, and arbitrary write to shared storage.
**No sandbox escape was required** — the sandbox was asked for the filesystem and handed it over.

Fixed in two places, deliberately:

- **In code.** `filterDangerousBuiltIns` refuses `fs`, `child_process`, `process`, `vm`, `module`,
  `worker_threads`, `net`, `dns` and others regardless of configuration, warning rather than
  filtering silently so a failing flow is explicable. An explicit escape hatch exists
  (`TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS`) and requires an exact acknowledgement string, so it
  cannot be reached by copying a config snippet. `path` is kept — it manipulates strings and opens
  nothing.
- **In configuration.** `fs` removed from the deployment's `TOOL_FUNCTION_BUILTIN_DEP`.

The code fix is the important one. A value in a compose file is one careless edit from returning,
and a sandbox whose containment can be removed by an environment variable is not a sandbox.

#### `/api/v1/prediction/:id` executed keyless flows without authentication — CONFIRMED, MEDIUM

`validateFlowAPIKey` began `if (!chatFlowApiKeyId) return true`. Since `/api/v1/prediction/` is
whitelisted and skips the bootstrap auth gate, that function was the only check on the path — and
it treated "no key configured" as "authorised". Confirmed live: an unauthenticated POST to a
private, keyless flow reached `buildChatflow`. 22 of 25 flows on the assessed instance were keyless.

A prediction now requires one of: a valid flow API key, an explicit `isPublic` flag, or an
authenticated caller. **Absence of a credential is not a credential.**

*Breaking:* calling `/prediction/` on a keyless, non-public flow without a session now returns 401.
That is the access being removed. Mark such flows public, or give them an API key.

#### A public flow may no longer contain a code-execution node

`isPublic` is a deliberate grant of unauthenticated execution; combined with a code node it means
unauthenticated code execution by design. Publishing such a flow is now refused with a message
naming the offending nodes. Private flows with code nodes are untouched — the risk is the
combination. Detection matches node-name substrings **and** non-empty code-bearing input fields, so
a code node type added later is still caught; a false positive costs a moment, a false negative
costs the host.

### Verified as already hardened

Reported by the assessment, confirmed by inspection — recorded so nobody re-fixes them:

- **SSRF from code nodes** (suspected) — already mitigated. `httpSecurity.ts` denies
  `169.254.169.254`, all RFC1918 ranges, `localhost` and `::1` by default, across redirect chains.
- **vm2 command execution** — the four public escape techniques are blocked by the shipped config:
  `Proxy` is removed from the sandbox and `eval: false` disables code-generation-from-strings,
  defeating the `Function('return process')` primitive every published escape relies on.
- **Path traversal / arbitrary file read** via `get-upload-file` — UUID and format validated.
- **Unauthenticated MCP code execution** — route-level `authenticateToken` applies despite the
  whitelist.

### Known and NOT fixed in this release

**`vm2` is deprecated and unpatchable.** Its escapes are blocked by configuration today, not by the
library. The durable fix is `isolated-vm` or the already-present `@e2b/code-interpreter` remote
sandbox; it touches every code-node type and is scheduled as its own change rather than rushed into
a security release. Until then, treat *who can author a code node* and *which flows are public* as
host-RCE-equivalent trust boundaries.

Correcting an earlier claim: the `vm2` 3.11.5 pin in `3.1.4-fw4` was described as closing six
critical sandbox escapes. 3.11.5 is the final release of a deprecated package. The pin moved off a
worse version; it did not make the sandbox safe.

### Added

- `packages/server/src/utils/codeNodeGuard.test.ts` — 16 cases including the assessment's payloads
- `packages/components/src/dangerousBuiltins.test.ts` — pins the refusal of every dangerous builtin

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
