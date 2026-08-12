# Release readiness — `3.1.4-fw8`

**Verdict: NOT RELEASABLE as `rc2`. Blocked on redeploy and re-verification of `rc3`.**

**Assessed:** 2026-08-10 · **Candidate:** `3.1.4-fw8-rc3` (building) · **Branch:** `fix/open-core-route-gating`, PR #8

## Gate status

| Gate | State |
|---|---|
| CI on the release commit | ✅ green (required checks pass) |
| Lint / build / tests | ✅ 0 errors · 6/6 packages · 980 tests |
| Test discovery | ✅ 156/156 — no suite silently unrun |
| Nine QA blockers | ✅ fixed in the tree |
| **Fixes verified on a built image** | ❌ **NOT DONE** — this is the gate |
| **Live disclosure closed in production** | ❌ **STILL OPEN** — fix is in the tree, production runs `rc2` |
| QA artifacts removed | ❌ three containers, 305 test credentials still up |
| Exposed credential rotated | ❌ operator action |

## Why rc2 cannot ship

`rc2` is the image currently in production and it contains **none** of the nine blocker fixes. It is
serving the complete definition of private flows to unauthenticated callers on the public internet —
verified again at the time of writing: 48,523 bytes, HTTP 200, no credentials required.

## The critical path, in order

1. **Build `rc3`** — in progress.
2. **Deploy it.** This is what actually closes the disclosure; every fix before this point is
   theoretical from production's point of view.
3. **Re-verify the changed surfaces.** Authorization changed on five route files, the session
   middleware and two UI files — precisely what the API and UI domains exercised. Re-running those
   two domains is not optional: this change set could plausibly have broken login.
4. **Tear down QA artifacts** and confirm the production database fingerprint is unchanged.
5. **Tag and release** — first release to pass through the gate rather than around it.

## Open, and deliberately not fixed in this pass

`/vector/upsert/` dual-auth (API key **or** session — a design change, not a guard), OPS-04
(credentials written with a null tenant key; production is currently clean but will drift), INFRA-02
(missing pepper starts a live-but-unusable server), INFRA-04 (`pnpm` as PID 1 — a clean stop exits 1),
INFRA-03 (no HEALTHCHECK), SEC-B-01 (MCP transport skips the SSRF guard on redirects), PERF-03 (an
unauthorized burst is invisible), and the accessibility set (UI-04/06/07).

None of these blocks the disclosure fix. All of them should land before this is described as a
security-hardened release.
