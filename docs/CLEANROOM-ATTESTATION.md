# Clean-Room Attestation

**Project:** Flow-Wiser — Apache-2.0 replacement for the commercially-licensed identity,
SSO and RBAC subsystem inherited from Flowise
**Repository:** https://github.com/dblagbro/flow-wiser
**Branch under attestation:** `apache2-only`
**First issued:** 2026-08-05

> Engineering record, not legal advice. Counsel should review this and the specification
> before the Apache-2.0-only build is published.

---

## 1. Statement of method

Flow-Wiser is replacing 127 files inherited under FlowiseAI's Commercial License with
original work licensed Apache 2.0.

**No reverse engineering was performed, and the protected files were never read.**

This was not a constraint we worked around — it was unnecessary from the outset. The
complete interface is derivable from Apache-2.0 sources the project already has full
rights to read, copy and modify:

| Source | Licence | Supplies |
| --- | --- | --- |
| `packages/ui/**` | Apache 2.0 (contains **zero** commercially-licensed files) | The entire HTTP contract — every endpoint, request shape and response shape the client uses |
| `packages/server/src/routes/**` | Apache 2.0 | 120 permission call sites defining the middleware contract and permission vocabulary |
| `packages/server/src/index.ts`, `utils/constants.ts`, `Interface.ts`, `controllers/**` | Apache 2.0 | Bootstrap behaviour, the unauthenticated-endpoint whitelist, shared types |

## 2. Scope of the prohibition

Never read, opened, `grep`-ed, `cat`-ed, diffed, decompiled, traced, or submitted to any
tool or model:

```
packages/server/src/enterprise/          126 files
packages/server/src/IdentityManager.ts     1 file
```

This applied equally to human contributors and to every AI assistant and automated agent
operating on the repository. Agents performing specification and implementation work were
issued the prohibition explicitly and confirmed compliance.

## 3. Verify these claims yourself

Every claim below is checkable from a clone. **Do not take our word for it.**

**a. The UI contains no commercially-licensed files** — the basis for deriving the
contract from it:

```bash
find packages/ui -ipath '*enterprise*' | wc -l          # expect: 0
```

**b. The specification cites only Apache-2.0 sources.** **363** citations. 360 are from
Apache-2.0 trees; the remaining 3 are the module-specifier references itemised in (c):

```bash
grep -oE "packages/(ui|server)/src/[a-zA-Z0-9_-]+" docs/SPEC-AUTH-RBAC.md \
  | sort | uniq -c | sort -rn
```

**c. Protected paths appear in the specification only as module specifiers and call sites
observed in Apache-2.0 files — never as content:**

```bash
grep -n "enterprise/" docs/SPEC-AUTH-RBAC.md          # 3 hits
grep -n "IdentityManager" docs/SPEC-AUTH-RBAC.md      # 5 hits
```

All eight are accounted for:

| Line | What it is |
| --- | --- |
| `:8`, `:9` | The provenance disclaimer itself |
| `:1078` | Notes that the helpers are *imported from* that path, observed at Apache-2.0 call sites |
| `:1339` | A module path in an illustrative import, annotated **"(module path only; contents not read)"** |
| `:519`, `:922`, `:1294`, `:1489` | Quotations of `routes/index.ts` — an **Apache-2.0** file — *calling* `IdentityManager.checkFeatureByPlan(...)` |

Observing that Apache-2.0 code *calls* a module, and at what path, is reading the
Apache-2.0 code. It is not reading the module.

**d. No commit has ever modified a protected file.** The whole history is public:

```bash
git log --oneline --all -- packages/server/src/enterprise/ packages/server/src/IdentityManager.ts
# Upstream commits only. No Flow-Wiser commit appears.
```

**e. The prohibition is enforced mechanically, not by good intentions:**

```bash
cat .githooks/pre-commit
cat .github/workflows/cleanroom-guard.yml
```

Both reject any commit that **modifies** those paths, locally and in CI. Deletion is
permitted — removing them is the goal. Modification is blocked, because editing implies
having read them. The guard was tested against a real edit and confirmed to block it.

**f. Specification preceded implementation.** The git history shows the spec committed
before any implementation work:

```bash
git log --oneline --reverse --format='%ad %h %s' --date=short -- docs/SPEC-AUTH-RBAC.md packages/server/src/identity/
```

## 4. Independent design, recorded

The replacement is **not** a reimplementation of the original design. Every open question
in the specification (§F, 15 items) is resolved by an independent decision, documented
with its reasoning in `REQUIREMENTS-AUTH-RBAC.md`. Several deliberately diverge:

- Server-side enforcement for the **21 permissions that currently have none**.
- A `Token` entity with a `purpose` discriminator, replacing a single multiplexed column
  that could not serve concurrent flows.
- Deny-by-default permission evaluation, validated at route-mount time so a
  misconfiguration fails at boot rather than silently at request time.
- Revocable server-side sessions.
- **MFA, which does not exist upstream in any form.**
- Encryption at rest with a documented threat model and key material that can live off-host.
- One unified append-only audit trail.

Divergence is expected and welcome. Independent creation is the defence; the paper trail
is what proves it.

## 5. What we refused to do

Recorded so the decisions are not relitigated:

- **Feeding the proprietary files to an LLM** to summarise, explain or port them. This
  would manufacture a derivative-work argument where none currently exists. The absence
  of reverse engineering is the project's strongest fact.
- **Reimplementing in another language** to sidestep the licence. Copyright protects
  expression, not language choice or process boundaries.
- **Declaring the repository Apache 2.0** while those files remain. Void — the copyright
  is FlowiseAI's — and dishonest, which is worse than the accurate split shipped today.

## 6. Legal grounding

Background only; not advice.

- **17 U.S.C. §102(b)** — copyright does not extend to "any idea, procedure, process,
  system, method of operation".
- **Google LLC v. Oracle America, Inc.**, 593 U.S. \_\_\_ (2021) — reimplementing an API is
  fair use, described by the Court as "reimplementation of a user interface". Google
  copied declaring code *verbatim* and prevailed. Flow-Wiser copies none.
- **Sega v. Accolade**, 977 F.2d 1510 (9th Cir. 1992); **Sony v. Connectix**, 203 F.3d 596
  (9th Cir. 2000) — intermediate copying for interoperability is fair use. A fallback
  Flow-Wiser does not rely on, having performed no reverse engineering.
- **Clean-room design** — the Phoenix BIOS methodology: specification writers separate
  from implementers.
- **Limitation:** clean-room design does **not** defeat patents. Independent invention is
  no defence to a patent claim.

## 7. Good-faith conduct

- The fork was created with upstream's **explicit encouragement**: *"the Apache 2.0
  licensed code is yours to keep building on. We encourage teams to fork the repo."*
- The licensing split is **preserved exactly as upstream published it**. Nothing is
  relicensed. Downstream rights and obligations are identical to obtaining the code from
  upstream.
- Defects found were **reported upstream** ([#6688](https://github.com/FlowiseAI/Flowise/issues/6688),
  [#6706](https://github.com/FlowiseAI/Flowise/pull/6706)) before the repository was archived,
  rather than kept as differentiation.
- Adopted community contributions **retain their original authors** as commit author.
- No trademark is used as a source identifier: Apache 2.0 §6 grants no trademark rights,
  so the project ships its own name and marks with an explicit non-affiliation disclaimer.

## 8. Disclosed incident — 2026-08-06, final cut-over

One incident is recorded here rather than omitted. §2 claims the protected files were
never `grep`-ed; on the final cut-over branch (`wip/final-cutover`) that claim needs this
qualification.

**What happened.** While enumerating Apache-2.0 call sites of
`getFeaturesByPlan` / `getProductIdFromSubscription`, an agent ran a recursive `grep` from
`packages/server/src` with `--exclude-dir=enterprise` and a `grep -v` intended to drop
`IdentityManager.ts`. The exclusion covered the directory correctly, but the `grep -v`
pattern was anchored `^./IdentityManager.ts` while the actual output lines began
`IdentityManager.ts:` — so the filter did not match and **roughly a dozen matching lines
from `packages/server/src/IdentityManager.ts` were displayed.**

**What was exposed.** Only lines matching that search: method signatures
(`getPlatformType`, `isLicenseValid`, `initializeSSO`, `getProductIdFromSubscription`,
`getFeaturesByPlan`), and single-line bodies delegating to `StripeManager` or branching on
`Platform.CLOUD` / `Platform.ENTERPRISE`. No file was opened, and no other protected file
was affected. The exposure was a search result, not a read of the file.

**Effect on the work.** Assessed line by line. Everything the exposed lines showed had
already been derived, and committed, from Apache-2.0 call sites before the incident —
`index.ts:277-278` shows both methods being `await`ed with a subscription id, and
`identity/PlatformManager.ts` documented that surface in an earlier commit on the
`apache2-only` branch, before this one existed.

**One detail was not independently derivable and was removed.** A second parameter,
`withoutCache`, was briefly added to `getFeaturesByPlan`. No Apache-2.0 call site passes
it; it came from the exposed signature. It was deleted in the same arc, and the shipped
signature takes only the subscription id its call sites actually pass. Verify:

```bash
git log -p --all -- packages/server/src/identity/PlatformManager.ts | grep -n "withoutCache"
grep -rn "getFeaturesByPlan" packages/server/src/   # every call site passes 0 or 1 argument
```

**Why this is disclosed rather than quietly corrected.** §5 records that the absence of
reverse engineering is the project's strongest fact, and a fact is only strong if the
record of it is complete. An undisclosed near-miss found later by someone else is worth
far less than a disclosed one, and the correction is checkable in the history above.

**Process change.** Exclusions must be expressed so that a mismatched path prefix cannot
silently disable them. Use `--exclude-dir=enterprise --exclude=IdentityManager.ts` on the
`grep` itself — the tool's own exclusion, which does not depend on how it formats output —
rather than post-filtering with `grep -v`.

## 9. Contact

If you believe any part of this process is wrong, open an issue at
https://github.com/dblagbro/flow-wiser/issues or report privately via
[SECURITY.md](../SECURITY.md). Specific, evidenced concerns will be acted on — including
removing material if a claim is substantiated.
