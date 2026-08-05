# Clean-Room Protocol

**Status: BINDING for all contributors.** This governs how Flow-Wiser replaces the
127 commercially-licensed files with original, Apache-2.0 work.

> This document records engineering process. It is not legal advice. Have counsel
> review the specification and attestation before publishing the Apache-2.0-only build.

---

## What is off limits

**Never read, open, `grep`, `cat`, diff, or paste the contents of:**

```
packages/server/src/enterprise/          126 files
packages/server/src/IdentityManager.ts     1 file
```

You may acknowledge these paths exist. You may never reproduce, paraphrase, or
describe their internal implementation.

This applies to humans **and** to any AI assistant, agent, or tool operating on the
repository.

## What IS permitted — and sufficient

The entire interface specification is derivable from **Apache-2.0 licensed sources we
already have full rights to read, copy, and modify**:

| Source | Licence | What it gives us |
| --- | --- | --- |
| `packages/ui/**` | Apache 2.0 (0 enterprise files) | The complete HTTP contract — every endpoint, payload and response the client uses |
| `packages/ui/src/api/*.js` | Apache 2.0 | `auth.js`, `role.js`, `user.js`, `workspace.js`, `account.api.js`, `loginmethod.js`, `oauth2.js` |
| `packages/server/src/routes/**` | Apache 2.0 | 120 `checkPermission` / `checkAnyPermission` call sites (70 + 50, across 22 files) — the middleware contract and permission vocabulary |
| `packages/server/src/Interface.ts` | Apache 2.0 | Shared types |

**We therefore do not reverse engineer anything.** That is deliberate and is the
single strongest fact in our favour. Do not spend it.

## Prohibited shortcuts

- ❌ **Do not** feed the proprietary files to an LLM to summarise, explain, or port them.
  That manufactures a derivative-work argument where none currently exists.
- ❌ **Do not** decompile, disassemble, or trace the running enterprise code to learn
  its internals.
- ❌ **Do not** copy structure, naming, or algorithms *from* those files even if
  recalled from memory.
- ❌ **Reimplementing in another language changes nothing.** Copyright protects
  expression, not language choice or process boundaries. A Go port of copied logic
  infringes exactly as much as a TypeScript one.

## The phases

1. **Specify** — derive requirements from Apache-2.0 sources only. Every claim carries
   a `file:line` citation. Output: `docs/SPEC-AUTH-RBAC.md`.
2. **Review** — check the spec contains functional requirements, not copied expression.
3. **Implement** — implementers work solely from the spec. They must not open the
   originals. Enforced by the guard below.
4. **Record** — retain spec, citations, commit history, attestation.
5. **Remove** — delete the 127 files; ship as genuine Apache 2.0.

## Mechanical enforcement

`.githooks/pre-commit` and CI both reject any commit that **modifies** the protected
paths. Enable locally:

```bash
git config core.hooksPath .githooks
```

The guard permits **deletion** (step 5 requires it) while blocking edits, which would
imply the author had been reading them.

## Design stance: different and better, not equivalent

We are **not** cloning their identity layer. We are writing our own, with a different
and better design, that happens to satisfy the same Apache-2.0 UI contract. Divergence
is expected and welcome — see `docs/REQUIREMENTS-AUTH-RBAC.md`.

Anywhere the spec leaves a design decision open, **make an independent choice and
document why**. Independent creation is the defence; a paper trail is what proves it.

## Legal grounding (background, not advice)

- **17 U.S.C. §102(b)** — copyright does not extend to "any idea, procedure, process,
  system, method of operation". Interfaces are largely unprotectable.
- **Google LLC v. Oracle America, Inc.**, 593 U.S. \_\_\_ (2021) — reimplementing an API
  is fair use; the Court described it as "reimplementation of a user interface".
  Google copied declaring code *verbatim* and prevailed. We copy none.
- **Sega v. Accolade**, 977 F.2d 1510 (9th Cir. 1992) and **Sony v. Connectix**,
  203 F.3d 596 (9th Cir. 2000) — even intermediate copying for interoperability is fair
  use. A fallback we do not need.
- **Clean-room design** — the Phoenix BIOS methodology: specification writers separate
  from implementers.
- **Limitation:** clean-room does **not** defeat patents. Independent invention is no
  defence to a patent claim.
