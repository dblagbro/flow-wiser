---
description: Identity, RBAC, tenancy, crypto and public routes — security-critical change rules
globs:
    - 'packages/server/src/identity/**'
    - 'packages/server/src/routes/public-*/**'
    - 'packages/server/src/routes/leads/**'
    - 'packages/server/src/routes/webhook*/**'
    - 'packages/server/src/middlewares/**'
alwaysApply: false
---

# Security-critical paths

Changes here are security changes, whatever they look like. They need a test, and they need
review.

## Authorization

-   **Enforce server-side.** A UI-only check is not a permission — rendering a button as `null`
    with no server counterpart is the exact upstream defect this layer exists to correct.
-   **Deny by default.** A route added without an explicit permission must fail closed.
-   **Scope every query** to workspace/organization. Cross-tenant IDOR is the highest-severity
    defect class in this codebase; assume any unscoped query is one.
-   **Audit** privileged actions to the append-only trail.
-   Permissions are declared in `identity/rbac/Permissions.ts` and enforced in `PermissionCheck.ts`.
    Do not scatter inline checks into controllers — a check written in one controller is a check the
    next route will not inherit, which is how routes end up unauthenticated.

## Public and unauthenticated routes

`public-chatbots`, `public-chatflows`, `public-executions`, `leads`, `webhook-listener` are
deliberate, audited exceptions. Treat every input as hostile.

-   Verify a "public" resource is **actually marked public** before returning it. Returning the full
    definition of a non-public flow to an unauthenticated caller has happened here and was rated
    CRITICAL.
-   Anonymous writes only on genuinely public resources.
-   Never return credentials, internal IDs or full flow definitions beyond what the endpoint needs.

## Crypto and secrets

-   Never weaken hashing parameters without an ADR.
-   Redaction must handle the **whole** value — a redactor that stops at the first delimiter leaks
    the remainder. Test with values containing commas, colons and newlines.
-   `FLOWISE_SECRETKEY_OVERWRITE` must never be the `.env.example` default. A publicly documented
    encryption key is not encryption.
-   A missing mandatory secret must be **fatal at boot**, never a live-but-unusable server.

## Input handling

Guard SSRF on every outbound fetch path, including redirects and DNS rebinding, and including
IPv6 (`::` has been missed here before). Keep code-execution `require` allowlists restrictive —
filtering must reject host-access builtins, and appending to an allowlist unfiltered is how
`fs.readFileSync` on the credential database became reachable without any sandbox escape.

## Required for every change in these paths

1. A test that **fails before** the change and passes after.
2. For a security fix, a **negative** test reproducing the original exploit condition exactly.
3. Verification against the **built artifact**, not just the source tree.
4. An entry in `docs/bug-log.md` with severity based on **demonstrated** impact.

Never disclose an unfixed vulnerability outside this repository, and never send finding details to
any external service — including a web search.
