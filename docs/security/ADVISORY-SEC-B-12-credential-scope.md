# Security advisory — SEC-B-12: cross-workspace credential disclosure

**Published:** 2026-10-01 · **Severity:** HIGH (multi-tenant deployments) · **Status:** FIXED

## Summary

`getCredentialData` — the function that decrypts and returns stored credentials — resolved a
credential **by id alone, with no workspace scope**. The compensating `credentialBelongsToWorkspace`
check existed but was enforced only in the text-to-speech controller, not on the general flow
build/execute path. In a **multi-tenant** deployment, a flow that referenced a credential id owned by
another workspace could have that credential **decrypted and returned** — cross-tenant credential
disclosure (IDOR).

## Affected versions

All Flow-Wiser builds carrying the Apache-2.0 identity layer **up to and including `3.1.4-fw10`
before commit `962daef5`** (the released `…-askdevin1/2/3` production images included). Upstream
Flowise, from which the unscoped `getCredentialData` is inherited, is affected in the same way.

## Impact

-   **Multi-tenant deployments:** HIGH. A workspace member who can get a foreign credential id into a
    flow they execute could read another workspace's secret.
-   **Single-tenant / single-workspace deployments (e.g. the current production instance):** LOW —
    there is no second tenant to disclose to, and credential ids are unguessable UUIDs that are not
    visible across workspaces. Not a live compromise of the current production instance.

## Fix

`getCredentialData` now **fails closed on cross-workspace access before decrypting**, via a tested
`credentialAccessibleToWorkspace()` helper. A credential is usable only if it is **owned by** the
current workspace or **explicitly shared into** it (a `WorkspaceShared` row) — sharing is preserved.
Enforcement applies wherever a workspace context (`options.workspaceId`) is present; CLI and internal
callers that pass none are unchanged.

Fixed in commit `962daef5` (branch `security/sec-b-12-credential-scope`), with 6 unit tests
including the foreign-denied and fail-closed cases.

## How it was found

Surfaced while analysing an unsolicited external "patch" that proposed making `getCredentialData`
resolve credentials **by name** on an id miss — which, given non-unique names and no reliable tenant
scope, would have _widened_ this into an easy cross-tenant disclosure. The patch was declined and not
applied; the correct fix tightens the path instead. See
[`INCIDENT-2026-10-01-supply-chain-attempt.md`](INCIDENT-2026-10-01-supply-chain-attempt.md).

## Operator action

Upgrade to a build at or after `962daef5`. No configuration change required. Rotating credentials
that may have been exposed is advisable only for deployments that ran multi-tenant on an affected
build; single-tenant deployments are not affected.
