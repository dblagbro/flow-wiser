# Internal chat-history authorization verification

## 2026-11-12 — Internal chat-history permission gate

The internal chat-message GET routes now require `chatflows:view` or
`agentflows:view`, using the same existing permission middleware as ordinary
chat history. A workspace API key with unrelated or empty grants previously
reached the message handler. The controller's workspace restriction remains
unchanged; this correction adds the missing operation-level permission check.

Fourteen synthetic route tests cover both registered paths, anonymous and
insufficiently privileged subjects, missing workspace scope, both viewer grants
and the existing organization-administrator behavior. The unfixed route fails
eight denial assertions; the fixed route passes all fourteen tests. No real
chat history, credentials, provider calls or production mutations are involved.

This is the internal-history portion of
[GHSA-ppmg-4cx6-95hh](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-ppmg-4cx6-95hh).
Ordinary history reads and deletion already have guards in this fork. Source
validation is distinct from runtime deployment; a rebuilt, verified image is
required before calling the production finding resolved. This is an
authorization disclosure risk, not demonstrated remote code execution.

## Reproduce

```bash
cd packages/server
pnpm exec jest --selectProjects stubbed-orm --runInBand --runTestsByPath src/routes/internal-chat-messages/authorization.test.ts
```

The test uses real Express routing and the fork's actual permission middleware;
only message retrieval and audit output are stubbed. It does not test login,
API-key issuance, complete controller tenancy, or the public reverse proxy.
Full repository CI remains required before merge.
