# Baseline — `3.1.4-fw8`

**This is the line in the sand.** Everything before it was written while the build was red, the
release process was unguarded, and part of the test suite was not running. `3.1.4-fw8` is the first
release where none of those is true.

**Date:** 2026-08-09 · **Supersedes:** `3.1.4-fw7` and everything earlier · **Next:** full QA

---

## Why this version and not fw7

fw7 is a good build. It is running in production, it passed every functional check, and nothing in
it is known to be wrong. But it was *tagged and released on a commit whose CI was failing*, and so
were fw5 and fw6 — Node CI was red from 2026-08-05 to 2026-08-09 and nobody was told. Three security
releases went out in that window, two of them to an external assessment team.

The code was fine. The **evidence** was not, and QA needs something to test against whose evidence
holds. That is the whole reason for cutting fw8: it is the first version where the claim "this
passed" is checkable rather than asserted.

| | fw5 · fw6 · fw7 | **fw8** |
|---|---|---|
| CI on the released commit | **red** | **green** |
| `pnpm install --frozen-lockfile` | failed | passes |
| `pnpm lint` | 45 errors | 0 errors |
| Tests run | 937 | **974** |
| `recovery-cli.test.ts` (30 tests) | never executed | passes |
| Cypress | failed at boot | passes |
| Release could be cut on a red commit | yes, silently | gate objects |
| A test suite could exist and never run | yes, silently | check objects |
| HSTS at the edge | absent | present, verified externally |

---

## What is verified, and how

Nothing below is asserted from memory. Each row names the check that produced it.

### Build and test

| Claim | Evidence |
|---|---|
| Installs from its own lockfile | `pnpm install --frozen-lockfile` in CI |
| Lints clean | `pnpm lint` with `CI=true`, 0 errors (12 pre-existing unused-var warnings) |
| Builds | `pnpm build`, all 6 packages |
| 974 tests pass | `pnpm test:coverage` in CI |
| Every test file on disk actually runs | `scripts/assert-test-discovery.js`, 155 discovered / 155 on disk |
| The app boots and serves | Cypress starts the server and drives it |

### Security posture (as deployed)

| Claim | Evidence |
|---|---|
| No unauthenticated prediction | `POST /api/v1/prediction/<id>` unauthenticated → 401 |
| Credential values not exposed by default | `GET /credentials/:id` returns redacted; `/reveal` requires `credentials:reveal` |
| Credentials encrypted with AEAD | 3/3 production records carry the `fwenc:v1:` envelope (AES-256-GCM) |
| Admin API is protected by the app, not the network | `/api/v1/credentials` from **outside the LAN** → 401 from the application, not 403 from nginx |
| HSTS at the edge | `Strict-Transport-Security: max-age=31536000` on `/`, `/chatflows`, `/credentials`, `/api/v1/version`, and both `add_header` override locations |
| Sandbox posture is stated, not inferred | server logs `CODE_EXECUTION_MODE` at boot |

**The external check matters more than it looks.** Every earlier verification of the admin paths was
run from this host, whose address is inside the IP allowlist being tested — a test that could not
fail. See G11.

---

## What is NOT fixed, stated plainly

QA should not treat any of these as a discovery.

| Item | Status |
|---|---|
| **`vm2`** | Still present, still deprecated, still the default execution path. Its known escapes are blocked by configuration — `Proxy` removed, `eval:false`, 20 host builtins denied in code — and an independent assessment confirmed all four public techniques fail. That is configuration, not architecture. `CODE_EXECUTION_MODE=disabled` removes the risk class; `=e2b` moves it off-host and now fails closed. |
| **12 dangling credential references** | 21 references across 9 flows point at credentials that no longer exist. Operator data, not a code defect. Those flows will fail at runtime on a missing credential. **This is why `flowise doctor` exits 1.** |
| **Two expired TLS certs on this edge** | `dump-the-dump.org` and `themartinfeldwrench.com` have been expired since 2026-03-18. Unrelated to Flow-Wiser, but they share the reverse proxy, and they are why HSTS here deliberately omits `includeSubDomains`. |
| **Alerting** | Audit events are recorded, never pushed. No integration. |
| **Tamper-proofing** | The audit trail has tamper *evidence* (SHA-256 manifest, reproducible digest). An actor with database write access could still rewrite history and re-export. A hash-chained log would be required. |
| **Data classification** | Not implemented. A prerequisite for any real HIPAA/GDPR conversation. |
| **Docker Hub publication is ungated** | Nothing in CI pushes images; they are built and pushed by hand, so the release gate does not cover them. |
| **Edge drift is undetected** | Nothing compares `nginx -T` against the config on disk. The container was stale for two days with every local signal green (G11). |

---

## Reproducing this build

```bash
git clone https://github.com/dblagbro/flow-wiser && cd flow-wiser
git checkout v3.1.4-fw8
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4-fw8 \
  -t dblagbro/flow-wiser:3.1.4-fw8 .
```

`NODE_VERSION=20` is not optional — Node 24 cannot compile `better-sqlite3`. The build asserts that
`FLOWISE_VERSION` matches the version declared in `package.json` and fails if they disagree, so a
mislabelled image cannot be produced by accident.

Required at runtime, and the server refuses to start without them — deliberately, because a
generated key silently strands every credential written under the previous one:

```
IDENTITY_ENCRYPTION_KEY=<32+ bytes, not a published example value>
FLOWISE_SESSION_PEPPER=<any non-empty secret>
```

---

## What QA should attack

Ordered by where the evidence is thinnest, not by severity.

1. **The sandbox.** `vm2` is the one control that is configuration rather than architecture. Try to
   reach the host filesystem, the environment, and the network from a code node — in all three
   `CODE_EXECUTION_MODE` settings.
2. **RBAC boundaries.** Six seeded roles. Verify that `read-only` and `user` cannot reveal a
   credential value by any route, and that `super-user` can audit everything without seeing one.
3. **Tenant isolation.** Every content query is scoped by `workspaceId`. Try cross-tenant IDOR on
   flows, credentials, tools, assistants, document stores, variables, API keys.
4. **The upgrade path.** A pre-identity Flowise database must upgrade without losing content. The
   legacy workspace/organisation id adoption is what makes 25 existing flows survive; test it
   against a database that was never a Flow-Wiser instance.
5. **Key rotation.** `credential:rotate-encryption` — interrupt it, and confirm the table is not
   left half-rotated.
6. **Audit integrity.** Export a seqNo range, re-export it with `--verify`, confirm the digest
   reproduces; then modify a row and confirm it does not.
7. **The things above marked NOT fixed.** Confirm they behave as described, rather than worse.

---

## Provenance

- **Licence:** Apache-2.0 only. 127 commercially licensed files removed; CI fails if any returns.
- **Clean-room:** `docs/CLEANROOM-PROTOCOL.md`, attested in `docs/CLEANROOM-ATTESTATION.md`.
- **How the process failed and what now enforces it:** `docs/PROCESS-GAPS.md` (G1–G11).
- **Known issues:** `docs/ISSUE-REGISTER.md`.
- **Framework mapping:** `docs/COMPLIANCE-POSTURE.md`.
