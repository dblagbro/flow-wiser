# How we replaced an open-core licensing layer, legally

A practical account of taking Flowise — 94.67% Apache 2.0, 5.33% commercially licensed —
to **100% Apache 2.0**, without reverse engineering and without reading a single protected
file.

Written so the method is reusable. Most open-core forks die on this problem.

> Engineering record, not legal advice. Have counsel review before publishing.

---

## The situation

FlowiseAI reached end of life on 2026-08-03. The Apache-2.0 majority was explicitly
released to the community — *"the Apache 2.0 licensed code is yours to keep building on"* —
but **127 files** were not: `packages/server/src/enterprise/` (126) plus
`IdentityManager.ts`. Those held authentication, SSO, RBAC and multi-tenancy under a
Commercial Licence forbidding copying, publishing and distribution.

They could not simply be deleted. Flowise 3.x had **removed** the Apache-2.0 authentication
they replaced, so dropping them yielded an **unauthenticated server** — on a product with
116 published security advisories.

And they could not be relicensed. The copyright is FlowiseAI's; no fork can relicense code
it does not own. Declaring the repository Apache 2.0 while they remained would have been
void, and dishonest.

## The insight that made it tractable

**The entire interface was already in our hands, under a licence that permits reading it.**

| Source | Licence | What it gave us |
| --- | --- | --- |
| `packages/ui/**` | Apache 2.0, **zero** protected files | The complete HTTP contract — every endpoint, payload and response |
| `packages/server/src/routes/**` | Apache 2.0 | 120 permission call sites: the middleware contract and vocabulary |
| `packages/server/src/index.ts` | Apache 2.0 | Bootstrap behaviour; literally constructs `req.user` for the API-key path |

The client is the specification. It has to be — it is what actually calls the server.

So there was **nothing to reverse engineer**. That is the single most important fact in the
whole exercise, and it was available from the start to anyone who looked at the licence
boundaries before reaching for a disassembler.

## The method

**1. Specify before implementing.** An agent under an absolute prohibition produced a
2,174-line interface specification derived only from Apache-2.0 sources: 53 endpoints, 82
permissions, 12 entities, **363 citations**, and — importantly — **15 explicitly recorded
gaps** where the interface did not determine behaviour.

Those gaps matter more than the answers. Each became a documented independent design
decision rather than a guess dressed as a finding.

**2. Verify provenance mechanically.** 360 of 363 citations from Apache-2.0 trees; the
remaining 3 are module *specifiers* observed in Apache-2.0 imports, each itemised. Anyone
can re-run the greps — the attestation ships the commands, not the conclusions.

**3. Enforce the boundary in code, not in good intentions.** A `pre-commit` hook and a CI
workflow reject any commit that **modifies** a protected path. Deletion is permitted;
modification is not, because editing implies having read.

**4. Derive each replacement from its call sites.** For every symbol: how is it called,
what is passed, how is the result consumed? Implement the minimum that satisfies those
sites. Example — `getWorkspaceSearchOptions` was spread into a TypeORM where-clause, never
awaited, sometimes handed `undefined`. That fixes the shape completely without opening the
original.

**5. Diverge deliberately, and write down why.** We were not cloning. Where the original's
behaviour was wrong, we changed it and recorded the reasoning.

**6. Delete, then prove.** `tsc` baseline captured *before* (417 errors, all from an
unbuilt sibling package), compared *after* (404). **Zero new errors** — and 13 disappeared,
9 of which were real breakage earlier steps had left behind.

## What we changed on purpose

| Upstream | Flow-Wiser | Why |
| --- | --- | --- |
| Credentials: manage ⇒ read | `credentials:reveal` split out, admin-only, audited | One compromised account should not yield every API key |
| Single `tempToken` for 4 flows | `Token` entity with a `purpose` discriminator | One column cannot serve concurrent flows |
| 21 permissions with no server check | All enforced server-side | The client rendered buttons as `null` — the checks were cosmetic |
| Licence-gated features | All features, always | There is nothing to sell |
| No MFA at all | TOTP + hashed recovery codes | Verified against RFC 6238 published vectors |
| Sign-in log only | One append-only audit trail | RBAC without a record answers "was this allowed?", never "who did it?" |
| Encryption key beside the database | Key may live off-host; refuses published example values | Deployments run with `myencryptionkey`, straight from `.env.example` |

## What went wrong

Recorded because a method is only useful if its failure modes travel with it.

**A malformed exclusion exposed ~12 lines.** A `grep --exclude-dir=enterprise` was paired
with a `grep -v` post-filter whose anchor did not match the output format, so it silently
did nothing. Disclosed in full as §8 of the attestation, with the one possibly-influenced
detail removed. *Use the tool's own `--exclude=`; never a post-filter whose anchor can
mismatch.*

**Fixing the reported instances is not fixing the bug.** Five nullable `Date` columns were
missing an explicit type — `Date | null` reflects as `Object` and TypeORM refuses to
initialise. I fixed those five and declared it closed. There were **ten**. The rest sat in
files nobody had mentioned.

**Per-step assertions cannot catch a later step undoing an earlier one.** A build pinned
two dependencies in separate `RUN` steps; the second install silently reverted the first.
The build printed `pinned to 0.9.16` and its assertion passed — the assertion ran *before*
the regression. Verify after *all* mutations, not after each.

**A commit that exists only in scratch is not saved.** Agents were told to commit but not
push. The scratch directory was wiped twice, destroying two agents' work. Push per step.

**`git push` reporting "Everything up-to-date" is not confirmation.** It means the branch
you *named* is unchanged — which is also what it says when you name a remote that no longer
exists. Check `HEAD` against the remote ref.

The common shape: **a check that silently didn't happen.**

## What we refused

- **Feeding the protected files to an LLM** to summarise or port them. That manufactures a
  derivative-work argument where none exists. The absence of reverse engineering is the
  strongest fact; spending it for convenience is a bad trade.
- **Reimplementing in another language** to "avoid" the licence. Copyright protects
  expression, not language choice or process boundaries.
- **Inventing endpoints with no call site.** Five identity-administration routes return
  **501 with a reason** rather than guessed implementations. Inventing behaviour is exactly
  the failure this method exists to prevent — and unmounted they would have fallen through
  to the SPA catch-all, answering JSON requests with HTML.

## Legal grounding

Background only.

- **17 U.S.C. §102(b)** — copyright does not extend to "any idea, procedure, process,
  system, method of operation".
- **Google LLC v. Oracle America, Inc.**, 593 U.S. \_\_\_ (2021) — reimplementing an API is
  fair use; the Court called it "reimplementation of a user interface". Google copied
  declaring code *verbatim* and prevailed. We copied none.
- **Sega v. Accolade**, 977 F.2d 1510 (9th Cir. 1992); **Sony v. Connectix**, 203 F.3d 596
  (9th Cir. 2000) — intermediate copying for interoperability is fair use. A fallback we
  never needed.
- **Phoenix BIOS** — specification writers separate from implementers.
- **Limitation:** clean-room does **not** defeat patents. Independent invention is no
  defence to a patent claim.

## If you are doing this to another open-core project

1. **Map the licence boundary first.** Ours was one directory and one file. Knowing that
   turned an intimidating problem into a bounded one.
2. **Look for the client.** If a permissively-licensed UI talks to the proprietary server,
   the contract is already yours.
3. **Write the specification before touching an editor**, and record what it *cannot*
   determine.
4. **Enforce the boundary with a hook**, so it does not depend on anyone remembering.
5. **Work in public.** Provenance you cannot show is provenance you cannot rely on.
6. **Disclose near-misses.** One found later by someone else is worth far less than one you
   published yourself.

---

Full detail: [`CLEANROOM-PROTOCOL.md`](CLEANROOM-PROTOCOL.md) ·
[`CLEANROOM-ATTESTATION.md`](CLEANROOM-ATTESTATION.md) ·
[`SPEC-AUTH-RBAC.md`](SPEC-AUTH-RBAC.md) · [`PROJECT-LOG.md`](PROJECT-LOG.md)
