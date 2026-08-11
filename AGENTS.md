# AGENTS.md — Flow-Wiser project contract

The portable contract for any agent or contributor working in this repository. Tool-agnostic
by design; `CLAUDE.md` adds Claude-specific notes on top and does not restate this file.

---

## 0. The non-negotiable rule

**Never read, open, edit, summarise, or feed to a model any file under
`packages/server/src/enterprise/` or `packages/server/src/IdentityManager.ts`.**

These paths carry FlowiseAI's Commercial License. Reading them contaminates the clean-room
record for the entire project. **Deletion is permitted and is the goal; modification is not.**

As of `apache2-only` @ `ffae9952` these paths **do not exist in the tree** — the replacement
Apache-2.0 `identity/` layer is in place. The prohibition still stands: it applies to any
branch, any tag, any historical commit, and any restored copy.

The binding process is `docs/CLEANROOM-PROTOCOL.md`. It governs; this section only summarises it.

Also forbidden, recorded so nobody proposes them again (see `docs/PROJECT-LOG.md`):

-   Reverse engineering the licensed files, **including via another LLM**.
-   Reimplementing them in another language to "avoid" the licence.
-   Declaring the repository Apache-2.0 without evidence. **Licensing claims require evidence and
    human sign-off** — one was published incorrectly three times. Never assert license status as a
    side effect of other work.

---

## 1. Purpose

Flow-Wiser is a community continuation fork of FlowiseAI's Flowise, created after FlowiseAI
announced end-of-life (code freeze 2026-07-29, upstream archived 2026-08-10).

Goals, in priority order:

1. **A fully Apache-2.0 build** — replace the commercially-licensed auth / SSO / RBAC /
   multi-tenancy subsystem with original clean-room work.
2. **Different and better, not a clone** — server-side-enforced RBAC, real MFA, SSO, an
   append-only audit trail, encryption at rest with honest threat modelling.
3. **Flow and prompt versioning** with non-destructive restore.
4. **Keep the upstream UI essentially unchanged** — `packages/ui` is already Apache-2.0.
5. **A patched, deployable image** on `main` for people who need Flowise working today.

Standing requirements live in `docs/product.md`. `docs/index.md` says which document is
authoritative for which topic — **read it before assuming any document is current.**

---

## 2. Architecture and module boundaries

pnpm + turbo monorepo. Six workspace packages under `packages/`:

| Package             | npm name               | Role                                                                |
| ------------------- | ---------------------- | ------------------------------------------------------------------- |
| `server`            | `flowise`              | Express API, oclif CLI, TypeORM persistence, queues, identity layer |
| `ui`                | `flowise-ui`           | React + Vite SPA. **Apache-2.0; keep essentially unchanged**        |
| `components`        | `flowise-components`   | Node/integration library consumed by the server                     |
| `agentflow`         | `@flowiseai/agentflow` | Agent flow runtime, published separately                            |
| `observe`           | `@flowiseai/observe`   | Observability package, published separately                         |
| `api-documentation` | `flowise-api`          | API docs                                                            |

**Dependency direction:** `ui → server (HTTP only)`; `server → components → agentflow/observe`.
Never introduce a `components → server` import, and never let the UI import server internals.

Inside `packages/server/src`:

-   `identity/` — **the clean-room replacement.** `rbac/` (`Permissions.ts`, `PermissionCheck.ts`),
    `tenancy/`, `crypto/`, `middleware/`, `routes/`, `services/`, `PlatformManager.ts`.
    This is the licence-critical module: changes here need the clean-room rules applied.
-   `routes/` — 63 route groups mounted in `routes/index.ts`.
-   `database/` — 24 entity files, 53 migrations each for `sqlite`, `postgres`, `mysql`, `mariadb`.
    **A migration added for one engine must be added for all four.**
-   `versioning/` — `VersionStore.ts`, `capture.ts`, `diff.ts`, `normalise.ts` (git-backed history).
-   `queue/` — BullMQ/Redis prediction, upsert and schedule queues.
-   `commands/` — oclif CLI: `admin`, `audit`, `credential`, `mfa`, `session`, `sso`, `doctor`.
-   `services/`, `controllers/`, `utils/`, `errors/`, `middlewares/`.

`docs/project-map.md` holds the detailed map. Regenerate it when structure changes.

---

## 3. Commands

Toolchain: Node per `.nvmrc`, pnpm per `engines`. **See `docs/testing.md` for the current
toolchain caveat — this machine does not yet satisfy them.**

```bash
corepack enable && corepack prepare pnpm@10.26.0 --activate   # provision pnpm
pnpm install                                                   # also runs `husky install`

pnpm build                 # turbo run build (all packages)
pnpm build:docker          # build excluding agentflow + observe
pnpm dev                   # all packages in watch mode
pnpm start                 # packages/server/bin/run start
pnpm start-worker          # queue worker

pnpm test                  # turbo run test (jest)
pnpm test:coverage
node scripts/assert-test-discovery.js   # asserts no suite is silently unrun

pnpm lint                  # eslint over js,jsx,ts,tsx,json,md
pnpm lint-fix
pnpm format                # prettier --write "**/*.{ts,tsx,md}"

pnpm --filter flowise typeorm:migration-run
pnpm --filter flowise typeorm:migration-generate
```

Containers — `docker/`:

```bash
docker build -f docker/Dockerfile -t flow-wiser:dev .
docker compose -f docker/docker-compose.yml up -d          # single node
docker compose -f docker/docker-compose-queue-source.yml up -d   # queue mode
```

**Always pin the version build-arg.** An unpinned `npm install -g flowise` is the exact defect
that shipped three mislabelled images; `docker/Dockerfile` now asserts installed == requested.
Never remove that assertion.

---

## 4. Coding and naming conventions

-   TypeScript throughout the server; JSX in the UI. Prettier + ESLint are authoritative — run
    `pnpm format` and `pnpm lint-fix` rather than hand-formatting.
-   4-space indent, single quotes, no semicolons where Prettier omits them — do not fight the
    formatter, and do not reformat files you did not otherwise change.
-   Entities: `PascalCase` class, `identity_`-prefixed table names for the clean-room layer.
-   Migrations: `<Description><Timestamp>` class name, one per engine, kept numerically aligned.
-   Routes: one directory per group under `src/routes/<kebab-case>/`, mounted in `routes/index.ts`.
-   Permissions are declared in `identity/rbac/Permissions.ts` and enforced server-side.
    **A UI-only check is not a permission.** Deny by default; workspace-scoped; audited.
-   Commit subjects: `type(scope): imperative summary`, lowercase, no trailing period —
    matching the existing history (`fix(identity): …`, `docs(security): …`, `test(agentflow): …`).

## 5. File placement

| Kind                      | Location                                                                   |
| ------------------------- | -------------------------------------------------------------------------- |
| Server route group        | `packages/server/src/routes/<name>/`                                       |
| Identity / RBAC / tenancy | `packages/server/src/identity/**`                                          |
| Entity                    | `packages/server/src/database/entities/` + register in `entities/index.ts` |
| Migration                 | `packages/server/src/database/migrations/<engine>/` — **all four engines** |
| CLI command               | `packages/server/src/commands/<group>/`                                    |
| UI view                   | `packages/ui/src/views/`                                                   |
| Repo automation           | `scripts/`                                                                 |
| Standing documentation    | `docs/` (see `docs/index.md`)                                              |
| Architecture decisions    | `docs/decisions/ADR-NNNN-*.md`                                             |

Do not add top-level directories without an ADR.

## 6. Testing expectations

-   Jest, colocated `*.test.ts` next to the unit under test.
-   **Every bug fix ships a test that fails before the fix and passes after.** A fix without a
    regression test is incomplete.
-   Security fixes ship a **negative** test that reproduces the original exploit condition.
-   Migrations are verified against all four engines before merge.
-   `node scripts/assert-test-discovery.js` must pass — a suite that silently does not run is
    treated as a failing suite.
-   Never point tests at production. QA runs against disposable instances with their own
    volumes; see `docs/testing.md` for the environment discipline actually used.

## 7. Documentation lifecycle

After any meaningful change, update the affected document **in the same change**:

| You changed                          | Update                                             |
| ------------------------------------ | -------------------------------------------------- |
| Structure, modules, routes, entities | `docs/project-map.md`, `docs/architecture.md`      |
| Behaviour or shipped state           | `docs/current-state.md`, `CHANGELOG.md`            |
| A refactor                           | `docs/refactor-log.md`                             |
| Found or fixed a defect              | `docs/bug-log.md`, `docs/ISSUE-REGISTER.md`        |
| QA activity                          | `docs/qa-notes.md`                                 |
| A process failure                    | `docs/PROCESS-GAPS.md`, `docs/remediation-plan.md` |
| A significant decision               | a new ADR in `docs/decisions/`                     |
| Release state                        | `docs/release-readiness.md`                        |

Every dated entry uses an **absolute date** (`2026-08-11`), never "today" or "recently".
Stale documentation is a defect: if you find a document contradicting the code, fix it or
record the conflict — do not step around it.

**Documentation is linted.** `pnpm lint` globs `**/*.{js,jsx,ts,tsx,json,md}`, and
`eslint-plugin-markdown` parses fenced `js / `ts / `jsx / `json blocks in Markdown **as
real code**. Pseudocode, shell transcripts, illustrative fragments and anything with `...` or `->`
must use `text, `bash or ```console — otherwise it is a **lint error**, and `prettier/prettier`is error-level so formatting counts too. Use a code language only when the block is genuinely
valid, complete code. Run`pnpm lint` after writing documentation; a doc change can break the gate
exactly like a code change.

## 8. Git and release rules

-   Work on a branch. `main` is the deployable patched line; `apache2-only` is the
    Apache-2.0 continuation line. Do not commit directly to either without being asked.
-   Commit only what you changed. **Never `git add -A` from a parent directory** — this working
    tree sits inside an unrelated repository checkout (see `CLAUDE.md`).
-   Releases follow `docs/release-readiness.md`. Its rule is absolute: a gate is passed by going
    _through_ it, not around it. A fix that exists in the tree but not in the deployed image has
    not shipped.
-   Versioning is `3.1.4-fwN`, tracking upstream's base with a fork counter.

## 9. Security and secrets

-   **No secrets, credentials, tokens, private keys, PII, or production data** in code,
    documentation, tests, fixtures, logs, commit messages, or issue text — ever.
-   Never commit `.env`, `*.sqlite`, `*.pem`, `*.key`, or credential exports. `.gitignore`
    enforces this; do not weaken those patterns.
-   **`.gitignore` protects git and nothing else.** Every tool that globs the working tree — ESLint,
    Prettier, bundlers, test runners, doc generators, scanners — needs its own exclusion, and each is
    a separate chance to _read_ a secret. This is not hypothetical: `pnpm lint` opened a credential
    export and was stopped only by file permissions (RM-16). Three lists must stay in step:
    `.gitignore`, `ignorePatterns` in `.eslintrc.js`, and `.prettierignore`. Adding a secret pattern
    to one means adding it to all three.
-   `FLOWISE_SECRETKEY_OVERWRITE` must never be the `.env.example` default. A publicly documented
    encryption key is not encryption.
-   Report vulnerabilities per `SECURITY.md`.
-   If you encounter real credentials in the working tree, **do not read, move, print, or commit
    them.** Report the path and stop. (One such file exists here — see `CLAUDE.md`.)

## 10. Refactoring

**Preserve behaviour.** A refactor that changes observable behaviour is not a refactor — it is
a change, and it needs tests, documentation and review to match.

-   Establish the current behaviour with a test _before_ restructuring.
-   Keep refactors separate from behaviour changes, in separate commits.
-   Record every meaningful refactor in `docs/refactor-log.md`.

## 11. Prohibited without explicit human authorization

Stop and ask. Do not do any of these on your own initiative:

-   `git push` to any remote, or creating/updating a PR
-   Publishing to npm, Docker Hub, ECR, or any registry
-   Deploying anything, or touching the running production instance
-   Destructive database actions — drop, truncate, mass delete, destructive migration
-   `docker compose down`, removing volumes, or stopping a stack
-   Rotating, revoking, or regenerating live credentials
-   Deleting branches, tags, or history; force-pushing; rewriting published commits
-   Changing `.github/workflows/**` publish or release jobs
-   Weakening or disabling the clean-room guard, its CI workflows, or CODEOWNERS

Authorization is **per action, per occasion**. Approval to do something once is not standing
permission to do it again.

## 12. When artifacts disagree

1. Work out which artifact is stale.
2. Correct low-risk drift when intent is unambiguous.
3. **Pause and ask** when the conflict touches product behaviour, security, licensing, data
   loss, architecture, production, or a remote system.
4. Prevent recurrence in the right layer — persistent fact → this file; reusable procedure →
   a skill; path-specific rule → `.claude/rules/`; deterministic rule → test, hook, CI or lint;
   major decision → an ADR.
5. Verify the correction.
6. Update the relevant log or changelog.

**A control is not in place until it has been observed failing on a known-bad input and passing
on a known-good one, in the environment that actually runs it.** Both halves are required. The
existence of a guard is not evidence that it runs. This rule was learned the hard way —
`docs/PROCESS-GAPS.md` G1.
