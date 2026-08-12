# Flow-Wiser Security Remediation Brief — Engineering Detail

**Flow-Wiser 3.1.4-fw10 · forked from Flowise 3.1.4 · 2026-08-10**

Companion to the executive brief. This document assumes you read code.

---

## Scope and method

Every security advisory published against upstream Flowise and captured before the repository was
archived: **116 advisories, 28 critical / 64 high / 24 medium**, from
`upstream-archive/advisories/all-advisories.json`.

For each: identify the sink from the advisory text, grep the tree for the **pattern** rather than the
filename (a renamed file is not a fixed file), read the current code, and where a fix exists, use
`git log -S` on the fixing line to attribute it to upstream or to this fork rather than assuming.
Four independent reviewers took 29 each. Standing instruction: _a wrong "fixed" is worse than an
honest "unclear", because this table will be published as evidence._

Result: **0 unclear, 0 unresolved.** Full table at `docs/ADVISORY-SWEEP.md`.

| Verdict                                                      | n     |
| ------------------------------------------------------------ | ----- |
| Fixed upstream in the 3.1.4 base                             | 81    |
| Not applicable — code deleted with the commercial components | 23    |
| Fixed by this fork's reimplementation                        | 6     |
| **Still present at sweep time — fixed in fw10**              | **4** |
| Mitigated, not eliminated (`vm2`)                            | 2     |

---

## FINDING 1 — Unauthenticated credential abuse via text-to-speech

**Advisories:** GHSA-8gj2-2cvc-6xx7 (medium), GHSA-5fw2-mwhh-9947 (high)
**Access required:** none
**Status before fw10:** confirmed exploitable against the live production host

### Root cause

`/api/v1/text-to-speech/generate` is in `WHITELIST_URLS` (`packages/server/src/utils/constants.ts:39`)
so an embedded widget can synthesise a public chatflow's replies without a session. The controller
has two branches. The `chatflowId` branch enforces the contract — no session means the chatflow must
be `isPublic`. The body-config branch enforced nothing:

```ts
// packages/server/src/controllers/text-to-speech/index.ts — before
} else {
    provider     = bodyProvider
    credentialId = bodyCredentialId   // straight from the request body
```

`credentialId` reaches `getCredentialData` (`packages/components/src/utils.ts:754`), which resolves:

```ts
findOneBy({ id: selectedCredentialId }) // no workspaceId predicate
```

Omitting `chatflowId` bypasses the `isPublic` gate entirely.

### Proof of exploitability

```bash
curl -X POST https://<host>/api/v1/text-to-speech/generate \
     -H 'Content-Type: application/json' \
     -d '{"provider":"openai","credentialId":"<uuid>","text":"hi"}'

HTTP/1.1 200 OK
event: tts_start
data: {"event":"tts_start","data":{"format":"mp3"}}
```

No session cookie, no API key, no permission. The server decrypted the owner's provider key and
began synthesis. The only barrier is knowing a credential UUID — which the advisory itself assumes,
and which UUIDs leak through logs, exports and error messages.

**Impact:** unbounded attacker-controlled spend on the victim's OpenAI/ElevenLabs account, and
cross-tenant on a multi-workspace instance. The key value is never echoed back, but it is _used_.

### Fix

`packages/server/src/controllers/text-to-speech/index.ts`

```ts
if (!req.user?.activeWorkspaceId) throw new InternalFlowiseError(UNAUTHORIZED, …)
const ownsCredential = await credentialsService.credentialBelongsToWorkspace(
    bodyCredentialId, req.user.activeWorkspaceId)
if (!ownsCredential) throw new InternalFlowiseError(UNAUTHORIZED, …)
```

New helper, `packages/server/src/services/credentials/index.ts`:

```ts
const credentialBelongsToWorkspace = async (credentialId, workspaceId): Promise<boolean> => {
    …findOneBy({ id: credentialId, workspaceId })   // returns boolean, never the row
}
```

It returns a boolean deliberately. Returning the credential would invite callers to use _this_
lookup's row and skip their own scoping — which is the defect being fixed, one layer up.

The widget path is untouched: a request carrying `chatflowId` for a public flow still works.

---

## FINDING 2 — Unauthenticated OAuth2 credential write

**Advisory:** GHSA-wch5-xp77-fxg4 (high) · **Access required:** none

### Root cause

The `state` parameter was the credential's own primary key. The code said so:

```ts
// packages/server/src/routes/oauth2/index.ts:146 — before
state: credentialId,   // "Use credential ID as state parameter"
```

`/oauth2-credential/callback` and `/oauth2-credential/refresh` were both in `WHITELIST_URLS`
(`constants.ts:36-37`), and the router is mounted with no middleware (`routes/index.ts:109`).
Callback resolved:

```ts
findOneBy({ id: state as string }) // attacker-supplied, no ownership, no CSRF binding
```

then wrote new tokens to that credential. `/refresh/:credentialId` did the same and overwrote
`encryptedData`.

The OAuth2 `state` parameter exists to be unguessable and to bind a callback to the authorisation
request that started it. A `state` that _is the identifier of the object being modified_ provides
neither property.

### Exploitation

1. **Token grafting.** Attacker begins an authorisation against their own provider account, supplies
   a victim's credential UUID as `state`, completes consent. The provider redirects to the victim
   instance's callback; tokens are written onto the victim's credential. Every workflow using that
   credential now acts as the attacker's identity — reading their mailbox, writing to their CRM.
2. **Forced rotation.** `POST /oauth2-credential/refresh/<uuid>` unauthenticated, repeatedly: burns
   refresh tokens and breaks the victim's integrations.
3. **Replay.** No single-use, no expiry — a captured callback URL is reusable indefinitely.

### Fix

New module `packages/server/src/utils/oauth2State.ts`:

-   128 bits from `randomBytes(16)`
-   issued **only** by `/authorize`, which is authenticated and workspace-scoped
-   stored against `{ credentialId, workspaceId, expiresAt }`
-   **deleted on read** — replay fails
-   10-minute TTL, swept on access

Callback now redeems rather than trusts, and scopes the lookup to the workspace recorded at issue
time:

```ts
const redeemed = redeemOAuth2State(state as string)
if (!redeemed) return res.status(400).send(errorPage(…))   // never issued / already used / expired
const credential = await credentialRepository.findOneBy({
    id: redeemed.credentialId, workspaceId: redeemed.workspaceId })
```

`/refresh/:credentialId` removed from `WHITELIST_URLS`; requires a session and a workspace-scoped
lookup.

**Known limitation, stated rather than hidden:** pending states are held in-process. A restart
mid-handshake invalidates them (the user retries the connect) and they do not span replicas. A
multi-replica deployment needs this in the database or a shared cache. That needs a migration; this
change was closing a live unauthenticated credential-write hole, so the tradeoff is recorded as a
decision rather than left as an oversight.

---

## FINDING 3 — SSRF in the GET API chain

**Advisory:** GHSA-6r77-hqx7-7vw8 (high)
**Access required:** none if the flow is public or API-keyed; otherwise any authoring user

### Root cause

The POST variant had already been fixed by reimplementing the chain locally against `secureFetch`
(`packages/components/nodes/chains/ApiChain/postCore.ts:95`). The GET variant still imported
LangChain's class:

```ts
// GETApiChain.ts — before
import { APIChain } from '@langchain/classic/chains'
const chain = APIChain.fromLLMAndAPIDocs(llm, documents, { … })   // fetches with its own client
```

No `checkDenyList`, no redirect revalidation, no DNS-rebind protection. **The guard existed in the
sibling file and was simply not used here.**

### Why this node is worse than a generic SSRF

The URL is generated _by a language model_ from user-supplied text, so prompt injection steers it —
and the response is fed back into the answer prompt, so the attacker reads the result. It is not
blind. `http://169.254.169.254/latest/meta-data/iam/security-credentials/` returns cloud credentials
in the chat reply.

### Fix

New `packages/components/nodes/chains/ApiChain/getCore.ts`, mirroring `postCore.ts` for GET:

```ts
const res = await secureFetch(url, { method: 'GET', headers: this.headers })
```

`secureFetch` (`packages/components/src/httpSecurity.ts`) resolves the host, checks it against the
deny list, walks redirects revalidating **every hop**, and pins the validated IP into the connection
via `createPinnedAgent` — closing the TOCTOU window a rebind would otherwise open.

`GETApiChain.ts` now imports from `./getCore`.

**Related, fixed in fw9:** the deny list was missing `::` — the IPv6 unspecified address, which
routes to loopback. `curl http://[::]:3000/` reached a live service. `100.64.0.0/10` (CGNAT) and
`198.18.0.0/15` were also absent. All three added, with a negative test asserting the absence.

---

## FINDING 4 — SQL injection in assistants import

**Found outside the advisory set**, while verifying GHSA-9c4c-g95m-c8cp
**Access required:** `workspace:import` — held by super-admin, admin, org-admin

```ts
// packages/server/src/services/assistants/index.ts — before
let ids = '('
newAssistants.forEach((newAssistant) => { ids += `'${newAssistant.id}'` … })
… .where(`assistant.id IN ${ids}`)
```

Values from the uploaded file concatenated into SQL. `importTools` and `importVariables` received a
UUID guard upstream for exactly this defect; the assistants sibling was missed.

### Fix — two independent defences

```ts
for (const a of newAssistants)
    if (a.id && !validate(a.id)) throw new InternalFlowiseError(PRECONDITION_FAILED, …)

.where('assistant.id IN (:...assistantIds)', { assistantIds })
```

UUID validation rejects the payload; parameter binding means a future edit cannot reintroduce
concatenation. Either alone closes it — both are applied because they fail differently.

---

## FINDING 5 — A sandbox mitigation documented in five places and implemented in none

Not an upstream advisory. A defect in **our own** security posture documentation, found by the sweep.

`docs/COMPLIANCE-POSTURE.md:119`, `docs/BASELINE-3.1.4-fw8.md:74`, `docs/ISSUE-REGISTER.md:45` and
two CHANGELOG entries all stated **"`Proxy` removed from the sandbox"** as a shipped mitigation.

The only occurrence of the string `Proxy` in `packages/components/src/utils.ts` was a comment saying
it had been removed.

`Proxy` is the primitive the published `vm2` escapes construct their trap on. One of the two pillars
of our documented mitigation did not exist, and the claim was about to be published to customers as
evidence the sandbox was hardened.

### Fix

```ts
const sandbox: ICommonObject = {
    Proxy: undefined,
    Reflect: undefined,
    util: undefined, Symbol: undefined, child_process: undefined, fs: undefined, process: undefined,
```

The two CHANGELOG entries are **corrected in place**, noting the claim was not implemented until
fw10. Implementing it silently would leave a record implying it had always been true.

---

## Still open, with reasoning

### `vm2` remains the default execution path

`CODE_EXECUTION_MODE` resolves to `vm2` unless set (`packages/components/src/utils.ts:1777`). `vm2`
is deprecated and unpatchable; its author withdrew it.

**What holds, verified empirically** against the real code path — `require('fs')`, `require('node:fs')`,
`child_process` and `net` all fail with "Cannot find module"; `constructor.constructor('return process')`
and `Function('return process.env')` fail with "Code generation from strings disallowed"; dynamic
`import()` is unsupported; `typeof process === 'undefined'`; SSRF to `169.254.169.254` is blocked;
prototype pollution is confined to the sandbox's own `Object.prototype`. `eval` and `wasm` are
force-overridden **after** the caller's options merge (`utils.ts:1978-1981`), so a node cannot
re-enable them. As of fw10, `Proxy` and `Reflect` are shadowed.

**What does not hold:** that is configuration, not architecture.

**The complete answers, both shipped:** `CODE_EXECUTION_MODE=disabled` removes the capability —
verified as a genuine chokepoint, the entire codebase contains exactly one dynamic-execution
primitive, one `new NodeVM`, one `vm2` import, reached by all 20+ code-node call sites, with no stray
`eval`, `new Function` or `runInContext` anywhere. `CODE_EXECUTION_MODE=e2b` executes off-host and
**fails closed** if `E2B_APIKEY` is unset.

Neither is the default, because either would break existing flows without warning. That is an
operator decision and this brief exists so it can be made knowingly.

### Other open items

-   `/api/v1/vector/upsert/:id` — the API-key surface. Making it "valid key **or** session with
    permission" is a design change, not a guard; adding `checkAnyPermission` blind would break every
    key-based integration.
-   `CODEOWNERS` is committed but inert until "Require review from Code Owners" is enabled on `main`.
-   Brand primary `#2196f3` is 3.12:1 against white; AA wants 4.5:1.
-   MIME validation is extension↔declared-type, not magic-byte.

---

## Independent assessment

Two rounds by an external team during remediation.

**Round 1** found a critical unauthenticated RCE chain — code node → `require('fs')` → arbitrary file
read/write — and unauthenticated execution of keyless flows. Both fixed and re-verified.

**Round 2** confirmed all prior findings closed and raised seven new items (N1–N7), all since
addressed or explicitly accepted.

**Two statements in the round-2 report were factually wrong.** It asserted that `vm2` had been
removed from the image and that E2B was active. We verified both false at the time: `vm2@3.11.5` was
present and referenced in the built `utils.js`, and `E2B_APIKEY` was unset, so execution was local.
Their conclusion about unauthenticated RCE still held — but one verdict rested on a false premise.

Recorded because a brief that launders a third party's name into an endorsement is worthless. Their
findings were valuable precisely because they were adversarial, and that value is not increased by
pretending they were infallible.

---

## Verification

Every fix in this document was verified against a built image and, where the finding was live, against
the production host:

```
public-chatbotConfig (private flow)   401
feedback (private flow)               401
chatflows-streaming (private flow)    401
POST /leads (private flow)            401
text-to-speech (no session)           401     ← was 200 + synthesis
oauth2 refresh (no session)           401     ← was reachable
/chatflows (SPA)                      200     ← legitimate traffic unaffected
```

Build 6/6 packages · 980/980 tests across 34 suites · lint 0 errors · test discovery 155/155 files
(a check that exists because a 30-test suite was once committed, counted as coverage, and never
executed).

---

## Reproducing this audit

```bash
git clone https://github.com/dblagbro/flow-wiser && cd flow-wiser
git checkout v3.1.4-fw10
cat docs/ADVISORY-SWEEP.md      # all 116, verdict + evidence
cat docs/PROCESS-GAPS.md        # how the process failed, G1–G13
cat docs/bug-log.md             # every QA finding with status
```

The advisory source data is in `upstream-archive/advisories/`, captured before upstream was archived,
so the sweep is reproducible against the same inputs.
