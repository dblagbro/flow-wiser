# Upstream advisory sweep — all 116 advisories

**Subject:** Flow-Wiser `3.1.4-fw10`, forked from Flowise `3.1.4`  
**Date:** 2026-08-10  
**Scope:** every security advisory published against upstream Flowise and captured in
`upstream-archive/advisories/` before the repository was archived on 2026-08-10.

## Why this exists

A fork inherits its parent's vulnerabilities. Upstream is now archived and will not issue another
patch, so "we forked a maintained project" stopped being true and the only honest way to know where
this product stands was to check all 116 against the current tree, one at a time, and publish the
result — including the ones that came back badly.

Four did. They are fixed in `3.1.4-fw10`; one of them was confirmed exploitable against a live
production host before it was closed.

## Result

| Verdict | Count | Meaning |
|---|---|---|
| Fixed upstream | 81 | Already closed in the 3.1.4 base this fork started from |
| Not applicable | 23 | Vulnerable code does not exist here — most went with the 127 commercially licensed files this fork deleted |
| Fixed in fork | 6 | Closed by Flow-Wiser's own reimplementation |
| **Fixed in fw10** | **4** | **Still present when the sweep ran. Now fixed.** |
| ⚠️ Mitigated, not eliminated | 2 | The `vm2` sandbox. See below — this is the one row that is not a clean pass |

**Zero advisories ended the sweep unresolved, and zero were marked UNCLEAR.** Two are mitigated
rather than eliminated, and are described honestly below rather than counted as fixed.

## The two that are mitigated, not fixed

`GHSA-wg86-r78f-74mp` and `GHSA-9rvc-vf7m-pgm2` concern the `vm2` sandbox, which executes code nodes
in the server process. `vm2` is deprecated and unpatchable; its author withdrew it after concluding
the escapes could not be reliably closed.

What is true: `eval` and `wasm` are disabled and force-overridden after any caller options are
merged; twenty host-access builtins are denied in code regardless of configuration; `node:`-prefixed
specifiers are canonicalised so they cannot bypass the denylist; and as of `fw10`, `Proxy` and
`Reflect` are shadowed — the primitive the published escapes build their trap on.

What is also true: that is configuration, not architecture. A future escape technique that does not
depend on those primitives would work.

**The actual answer is `CODE_EXECUTION_MODE=disabled`**, which removes the capability entirely and is
correct for any deployment whose flows contain no code nodes, or `=e2b`, which executes off-host and
fails closed if its key is missing. Neither is the default, and that is a deliberate compatibility
choice rather than an oversight — stated here so an operator can make it knowingly.

Counting these as "fixed" would be the kind of claim this document exists to avoid making.

## Method, and its limits

Each advisory's sink was identified from its text, then the tree was searched for the *pattern* —
not the filename, because a renamed file is not a fixed file. Where a fix was found, `git log -S` on
the fixing line attributed it to upstream or to this fork rather than assuming. Four independent
reviewers took 29 advisories each and were instructed that a wrong "fixed" is worse than an honest
"unclear", because this table would be published as evidence.

Two advisories rest on affected-version-range evidence only, because neither names a file, function
or commit. They are marked Fixed upstream on that basis and the limitation is stated here rather
than buried.

## The full table

| Advisory | Severity | Verdict | Summary |
|---|---|---|---|
| [GHSA-2vv2-3x8x-4gv7](https://github.com/advisories/GHSA-2vv2-3x8x-4gv7) | critical | Fixed upstream | Flowise OS command remote code execution |
| [GHSA-3769-jgqc-cxm7](https://github.com/advisories/GHSA-3769-jgqc-cxm7) | critical | Fixed upstream | Flowise: RCE via NodeVM Sandbox Escape in executeJavaScriptCode() nodeVMOptions Override |
| [GHSA-3g4j-r53p-22wx](https://github.com/advisories/GHSA-3g4j-r53p-22wx) | critical | Fixed upstream | Duplicate Advisory: FlowiseAI Pre-Auth Arbitrary Code Execution |
| [GHSA-3gcm-f6qx-ff7p](https://github.com/advisories/GHSA-3gcm-f6qx-ff7p) | critical | Fixed upstream | Flowise has Remote Code Execution vulnerability |
| [GHSA-3hjv-c53m-58jj](https://github.com/advisories/GHSA-3hjv-c53m-58jj) | critical | Not applicable | Flowise: CSV Agent Prompt Injection Remote Code Execution Vulnerability |
| [GHSA-4j8x-x6v7-w9rq](https://github.com/advisories/GHSA-4j8x-x6v7-w9rq) | critical | Not applicable | Flowise: RCE via CSVAgent csvFile data URI base64 segment is interpolated into Python source wit |
| [GHSA-52fh-8v99-63c2](https://github.com/advisories/GHSA-52fh-8v99-63c2) | critical | Not applicable | Flowise: Pyodide validator Unicode homoglyph bypass leads to RCE |
| [GHSA-5xvg-pmgg-3mxr](https://github.com/advisories/GHSA-5xvg-pmgg-3mxr) | critical | Fixed upstream | Flowise: CSV Agent Prompt Injection Remote Code Execution Vulnerability |
| [GHSA-7944-7c6r-55vv](https://github.com/advisories/GHSA-7944-7c6r-55vv) | critical | Fixed upstream | FlowiseAI Pre-Auth Arbitrary Code Execution |
| [GHSA-8vvx-qvq9-5948](https://github.com/advisories/GHSA-8vvx-qvq9-5948) | critical | Fixed upstream | Flowise allows arbitrary file write to RCE |
| [GHSA-964p-j4gg-mhwc](https://github.com/advisories/GHSA-964p-j4gg-mhwc) | critical | Fixed upstream | Flowise is vulnerable to stored XSS via "View Messages" allows credential theft in FlowiseAI adm |
| [GHSA-99pg-hqvx-r4gf](https://github.com/advisories/GHSA-99pg-hqvx-r4gf) | critical | Fixed upstream | Flowise has an Arbitrary File Read |
| [GHSA-9rvc-vf7m-pgm2](https://github.com/advisories/GHSA-9rvc-vf7m-pgm2) | critical | ⚠️ Mitigated, NOT eliminated | FlowiseAI: Authenticated Host RCE via POST /api/v1/node-custom-function and NodeVM Sandbox Escap |
| [GHSA-9wc7-mj3f-74xv](https://github.com/advisories/GHSA-9wc7-mj3f-74xv) | critical | Not applicable | Flowise: Code Injection in CSVAgent leads to Authenticated RCE |
| [GHSA-c9gw-hvqq-f33r](https://github.com/advisories/GHSA-c9gw-hvqq-f33r) | critical | Fixed upstream | Flowise: Authenticated RCE Via MCP Adapters |
| [GHSA-g32j-mmxr-gfq5](https://github.com/advisories/GHSA-g32j-mmxr-gfq5) | critical | Fixed upstream | Flowise RCE via TypeORM DataSource |
| [GHSA-h42x-xx2q-6v6g](https://github.com/advisories/GHSA-h42x-xx2q-6v6g) | critical | Fixed upstream | Flowise Pre-auth Arbitrary File Upload |
| [GHSA-hmgh-466j-fx4c](https://github.com/advisories/GHSA-hmgh-466j-fx4c) | critical | Fixed upstream | Flowise vulnerable to RCE via Dynamic function constructor injection |
| [GHSA-jv9m-vf54-chjj](https://github.com/advisories/GHSA-jv9m-vf54-chjj) | critical | Not applicable | Flowise is vulnerable to arbitrary file write through its WriteFileTool |
| [GHSA-q4xx-mc3q-23x8](https://github.com/advisories/GHSA-q4xx-mc3q-23x8) | critical | Fixed upstream | Duplicate Advisory: Flowise vulnerable to RCE via Dynamic function constructor injection |
| [GHSA-q67q-549q-p849](https://github.com/advisories/GHSA-q67q-549q-p849) | critical | Fixed upstream | Flowise has arbitrary file access due to missing chat flow id validation |
| [GHSA-qgvm-j2hm-6m38](https://github.com/advisories/GHSA-qgvm-j2hm-6m38) | critical | Fixed upstream | Flowise: Unauthenticated OAuth2 token refresh endpoint returns access tokens — enables token the |
| [GHSA-v38x-c887-992f](https://github.com/advisories/GHSA-v38x-c887-992f) | critical | Not applicable | Flowise: Airtable_Agent Code Injection Remote Code Execution Vulnerability |
| [GHSA-vmv7-4m6c-3cg5](https://github.com/advisories/GHSA-vmv7-4m6c-3cg5) | critical | Fixed upstream | Flowise: CSV Agent Remote Code Execution via Pyodide Code Injection — Root Shell Verified |
| [GHSA-wg86-r78f-74mp](https://github.com/advisories/GHSA-wg86-r78f-74mp) | critical | ⚠️ Mitigated, NOT eliminated | Flowise Sandbox Escape to RCE |
| [GHSA-wgpv-6j63-x5ph](https://github.com/advisories/GHSA-wgpv-6j63-x5ph) | critical | Not applicable | Flowise Cloud and Local Deployments have Unauthenticated Password Reset Token Disclosure that Le |
| [GHSA-x3hf-7cj6-3r4m](https://github.com/advisories/GHSA-x3hf-7cj6-3r4m) | critical | Fixed upstream | Flowise RCE via SQLite Record Manager Node |
| [GHSA-x6vm-w76m-8j7g](https://github.com/advisories/GHSA-x6vm-w76m-8j7g) | critical | Fixed upstream | Flowise: Remote Code Execution Vulnerability in CSVAgent |
| [GHSA-28g4-38q8-3cwc](https://github.com/advisories/GHSA-28g4-38q8-3cwc) | high | Fixed upstream | Flowise: Cypher Injection in GraphCypherQAChain |
| [GHSA-2q4w-x8h2-2fvh](https://github.com/advisories/GHSA-2q4w-x8h2-2fvh) | high | Fixed upstream | Flowise Authentication Bypass vulnerability |
| [GHSA-2x8m-83vc-6wv4](https://github.com/advisories/GHSA-2x8m-83vc-6wv4) | high | Fixed upstream | Flowise: SSRF Protection Bypass (TOCTOU & Default Insecure) |
| [GHSA-35g6-rrw3-v6xc](https://github.com/advisories/GHSA-35g6-rrw3-v6xc) | high | Fixed upstream | FlowiseAI/Flosise has File Upload vulnerability |
| [GHSA-3prp-9gf7-4rxx](https://github.com/advisories/GHSA-3prp-9gf7-4rxx) | high | Fixed upstream | Flowise: Mass Assignment in DocumentStore Create Endpoint Leads to Cross-Workspace Object Takeov |
| [GHSA-48m6-ch88-55mj](https://github.com/advisories/GHSA-48m6-ch88-55mj) | high | Not applicable | Flowise: Improper Mass Assignment in Account Registration Enables Unauthorized Organization Asso |
| [GHSA-48x4-mx8f-gr4h](https://github.com/advisories/GHSA-48x4-mx8f-gr4h) | high | Fixed upstream | Flowise Unauthenticated Denial of Service (DoS) vulnerability |
| [GHSA-4jpm-cgx2-8h37](https://github.com/advisories/GHSA-4jpm-cgx2-8h37) | high | Fixed upstream | Flowise: Sensitive Data Leak in public-chatbotConfig |
| [GHSA-5cph-wvm9-45gj](https://github.com/advisories/GHSA-5cph-wvm9-45gj) | high | Fixed upstream | Flowise OverrideConfig security vulnerability |
| [GHSA-5f53-522j-j454](https://github.com/advisories/GHSA-5f53-522j-j454) | high | Fixed upstream | Flowise Missing Authentication on NVIDIA NIM Endpoints |
| [GHSA-5fw2-mwhh-9947](https://github.com/advisories/GHSA-5fw2-mwhh-9947) | high | **FIXED IN fw10** | Flowise: Unauthenticated TTS endpoint accepts arbitrary credential IDs — enables API credit abus |
| [GHSA-5h9v-837x-m97r](https://github.com/advisories/GHSA-5h9v-837x-m97r) | high | Fixed upstream | FlowiseAI: Dataset create+update mass-assignment allows cross-workspace dataset takeover |
| [GHSA-5wxp-qjgq-fx6m](https://github.com/advisories/GHSA-5wxp-qjgq-fx6m) | high | Fixed upstream | FlowiseAI has Mass Assignment in Chatflow Update Endpoint that Allows Cross-Workspace AgentFlow  |
| [GHSA-66f2-xxgm-f6xp](https://github.com/advisories/GHSA-66f2-xxgm-f6xp) | high | Fixed upstream | Flowise Cors Misconfiguration in packages/server/src/index.ts |
| [GHSA-6933-jpx5-q87q](https://github.com/advisories/GHSA-6933-jpx5-q87q) | high | Fixed in fork | Flowise has unsandboxed remote code execution via Custom MCP |
| [GHSA-69jq-qr7w-j7qh](https://github.com/advisories/GHSA-69jq-qr7w-j7qh) | high | Fixed upstream | FlowiseAI Flowise arbitrary file upload vulnerability |
| [GHSA-6f7g-v4pp-r667](https://github.com/advisories/GHSA-6f7g-v4pp-r667) | high | Fixed upstream | Flowise: Unauthenticated OAuth 2.0 Access Token Disclosure via Public Chatflow in Flowise |
| [GHSA-6fw7-3q8r-m5vj](https://github.com/advisories/GHSA-6fw7-3q8r-m5vj) | high | Fixed upstream | FlowiseAI has Mass Assignment in Variable Update Endpoint that Allows Cross-Workspace Resource R |
| [GHSA-6r77-hqx7-7vw8](https://github.com/advisories/GHSA-6r77-hqx7-7vw8) | high | **FIXED IN fw10** | Flowise:  APIChain Prompt Injection SSRF in GET/POST API Chains |
| [GHSA-6vh2-wg4h-4vwj](https://github.com/advisories/GHSA-6vh2-wg4h-4vwj) | high | Fixed upstream | Flowise: Unauthenticated Property Injection into Flow Execution Context via Ungated `overrideCon |
| [GHSA-6wp6-22x5-rr3w](https://github.com/advisories/GHSA-6wp6-22x5-rr3w) | high | Fixed upstream | Flowise vulnerable to code injection via api/v1 |
| [GHSA-728h-4mwj-f2p4](https://github.com/advisories/GHSA-728h-4mwj-f2p4) | high | Fixed upstream | FlowiseAI: CustomTemplate create+update mass-assignment allows cross-workspace template takeover |
| [GHSA-78pr-c5x5-jggc](https://github.com/advisories/GHSA-78pr-c5x5-jggc) | high | Fixed upstream | FlowiseAI: Assistant create+update mass-assignment allows cross-workspace assistant takeover |
| [GHSA-7g73-99r4-m4mj](https://github.com/advisories/GHSA-7g73-99r4-m4mj) | high | Fixed upstream | FlowiseAI Vulnerable to Credential Data Leak |
| [GHSA-7j65-65cr-6644](https://github.com/advisories/GHSA-7j65-65cr-6644) | high | Fixed upstream | FlowiseAI: DatasetRow create+update mass-assignment allows cross-workspace row takeover |
| [GHSA-7rgr-72hp-9wp3](https://github.com/advisories/GHSA-7rgr-72hp-9wp3) | high | Fixed upstream | Duplicate Advisory: Flowise is vulnerable to stored XSS via "View Messages" allows credential th |
| [GHSA-88pr-878c-24wf](https://github.com/advisories/GHSA-88pr-878c-24wf) | high | Fixed upstream | Flowise: Authenticated arbitrary file write in the `S3 Directory` document loader via unsanitize |
| [GHSA-8r8h-6vcc-xhrv](https://github.com/advisories/GHSA-8r8h-6vcc-xhrv) | high | Fixed upstream | Flowise: RBAC Bypass Leading to Unauthorized Workspace Variables Disclosure |
| [GHSA-c6xh-wv4j-ppv5](https://github.com/advisories/GHSA-c6xh-wv4j-ppv5) | high | Fixed upstream | Flowise: SSRF Protection Bypass via IPv4-Mapped IPv6 Addresses |
| [GHSA-chm3-vqcf-52rx](https://github.com/advisories/GHSA-chm3-vqcf-52rx) | high | Fixed upstream | Flowise: Cross-workspace credential IDOR in openai-assistants-vector-store |
| [GHSA-cvrr-qhgw-2mm6](https://github.com/advisories/GHSA-cvrr-qhgw-2mm6) | high | Fixed upstream | Flowise: Parameter Override Bypass Remote Command Execution |
| [GHSA-cwc3-p92j-g7qm](https://github.com/advisories/GHSA-cwc3-p92j-g7qm) | high | Not applicable | Flowise has IDOR leading to Account Takeover and Enterprise Feature Bypass via SSO Configuration |
| [GHSA-f228-chmx-v6j6](https://github.com/advisories/GHSA-f228-chmx-v6j6) | high | Not applicable | Flowise: Remote code execution vulnerability in AirtableAgent.ts caused by lack of input verific |
| [GHSA-f6hc-c5jr-878p](https://github.com/advisories/GHSA-f6hc-c5jr-878p) | high | Not applicable | Flowise: resetPassword Authentication Bypass Vulnerability |
| [GHSA-fm2f-4339-4p2f](https://github.com/advisories/GHSA-fm2f-4339-4p2f) | high | Fixed upstream | Flowise: Missing Authorization on Execution Update Endpoint |
| [GHSA-fr6g-7cq8-fg82](https://github.com/advisories/GHSA-fr6g-7cq8-fg82) | high | Fixed upstream | Flowise: Information Disclosure in GET /api/v1/upsert-history returns the entire server-wide ups |
| [GHSA-fvcw-9w9r-pxc7](https://github.com/advisories/GHSA-fvcw-9w9r-pxc7) | high | Fixed upstream | Flowise affected by Server-Side Request Forgery (SSRF) in HTTP Node Leading to Internal Network  |
| [GHSA-gmmw-qg98-6j6p](https://github.com/advisories/GHSA-gmmw-qg98-6j6p) | high | Not applicable | Flowise: Broken Access Control in Stripe Subscription Endpoints Allows Cross-Tenant Billing Mani |
| [GHSA-h997-3fxj-p5j8](https://github.com/advisories/GHSA-h997-3fxj-p5j8) | high | Fixed upstream | Flowise Path Injection at /api/v1/openai-assistants-file |
| [GHSA-hmg2-jjjx-jcp2](https://github.com/advisories/GHSA-hmg2-jjjx-jcp2) | high | Fixed upstream | FlowiseAI: Vector Store No Permission Checks |
| [GHSA-hp26-q66v-q2w7](https://github.com/advisories/GHSA-hp26-q66v-q2w7) | high | Fixed upstream | FlowiseAI has Mass Assignment in Assistant Update Endpoint that Allows Cross-Workspace Resource  |
| [GHSA-hr92-4q35-4j3m](https://github.com/advisories/GHSA-hr92-4q35-4j3m) | high | Fixed upstream | FlowiseAI/Flowise has Server-Side Request Forgery (SSRF) vulnerability |
| [GHSA-j44m-5v8f-gc9c](https://github.com/advisories/GHSA-j44m-5v8f-gc9c) | high | Not applicable | Flowise is vulnerable to arbitrary file exposure through its ReadFileTool |
| [GHSA-j8g8-j7fc-43v6](https://github.com/advisories/GHSA-j8g8-j7fc-43v6) | high | Fixed upstream | Flowise has Arbitrary File Upload via MIME Spoofing |
| [GHSA-m99r-2hxc-cp3q](https://github.com/advisories/GHSA-m99r-2hxc-cp3q) | high | Fixed upstream | Flowise has an MCP Security Bypass that Enables RCE |
| [GHSA-mq4r-h2gh-qv7x](https://github.com/advisories/GHSA-mq4r-h2gh-qv7x) | high | Fixed upstream | Flowise Allows Mass Assignment in `/api/v1/leads` Endpoint |
| [GHSA-mq53-pc65-wjc4](https://github.com/advisories/GHSA-mq53-pc65-wjc4) | high | Fixed upstream | FlowiseAI: Evaluation create+update mass-assignment allows cross-workspace evaluation takeover |
| [GHSA-p5w8-m249-4r4v](https://github.com/advisories/GHSA-p5w8-m249-4r4v) | high | Fixed upstream | Flowise: `DELETE /api/v1/chatflows/:id` does not validate resource type, allowing `agentflows:de |
| [GHSA-php6-83fg-gw3g](https://github.com/advisories/GHSA-php6-83fg-gw3g) | high | Not applicable | FlowiseAI Exposes Basic Auth Credentials via API |
| [GHSA-r4hh-pcgx-j5r2](https://github.com/advisories/GHSA-r4hh-pcgx-j5r2) | high | Fixed upstream | Flowise: Authenticated Command Execution and Sandbox Bypass via Puppeteer and Playwright Package |
| [GHSA-r745-8hwv-h473](https://github.com/advisories/GHSA-r745-8hwv-h473) | high | Fixed upstream | Flowise: Unauthenticated OAuth2 Refresh Enables Non-Blind SSRF and Secret Exfiltration |
| [GHSA-rh7v-6w34-w2rr](https://github.com/advisories/GHSA-rh7v-6w34-w2rr) | high | Fixed upstream | Flowise: File Upload Validation Bypass in createAttachment |
| [GHSA-v5w9-prxf-w882](https://github.com/advisories/GHSA-v5w9-prxf-w882) | high | Not applicable | Flowise has Authentication Bypass Using Unprotected Registration Endpoint (/register) |
| [GHSA-w47f-j8rh-wx87](https://github.com/advisories/GHSA-w47f-j8rh-wx87) | high | Fixed upstream | Flowise: Public chatflow endpoints return unsanitized flowData including plaintext API keys, pas |
| [GHSA-wch5-xp77-fxg4](https://github.com/advisories/GHSA-wch5-xp77-fxg4) | high | **FIXED IN fw10** | Flowise: Cross-Workspace OAuth2 Credential Metadata Leak |
| [GHSA-wp74-f5hh-5f3r](https://github.com/advisories/GHSA-wp74-f5hh-5f3r) | high | Fixed upstream | Flowise: Missing authorization on `/api/v1/files` allows low-privileged API keys to list and del |
| [GHSA-wq95-wr7m-26h4](https://github.com/advisories/GHSA-wq95-wr7m-26h4) | high | Fixed upstream | Duplicate Advisory: Flowise Stored XSS vulnerability through logs in chatbot |
| [GHSA-wvhq-wp8g-c7vq](https://github.com/advisories/GHSA-wvhq-wp8g-c7vq) | high | Fixed in fork | Flowise has Authorization Bypass via Spoofed x-request-from Header |
| [GHSA-wxrr-jp8m-qq7f](https://github.com/advisories/GHSA-wxrr-jp8m-qq7f) | high | Fixed upstream | FlowiseAI: Evaluator create+update mass-assignment allows cross-workspace evaluator takeover |
| [GHSA-x5v6-pj28-cwwm](https://github.com/advisories/GHSA-x5v6-pj28-cwwm) | high | Fixed upstream | FlowiseAI has Mass Assignment in Tool Update Endpoint that Allows Cross-Workspace Resource Reass |
| [GHSA-x5w6-38gp-mrqh](https://github.com/advisories/GHSA-x5w6-38gp-mrqh) | high | Not applicable | Flowise: Password Reset Link Sent Over Unsecured HTTP |
| [GHSA-x7rp-qj2h-ghgw](https://github.com/advisories/GHSA-x7rp-qj2h-ghgw) | high | Fixed in fork | Flowise Fails to Invalidate Existing Sessions After Password Changes |
| [GHSA-xc48-889x-5qmw](https://github.com/advisories/GHSA-xc48-889x-5qmw) | high | Fixed upstream | Flowise: CVE-2025-8943 Patch Bypass: npm_config_yes bypasses MCP environment variable blocklist  |
| [GHSA-xhmj-rg95-44hv](https://github.com/advisories/GHSA-xhmj-rg95-44hv) | high | Fixed upstream | Flowise: SSRF Protection Bypass via Unprotected Built-in HTTP Modules in Custom Function Sandbox |
| [GHSA-2364-jh4q-m9vm](https://github.com/advisories/GHSA-2364-jh4q-m9vm) | medium | Not applicable | Flowise: IDOR vulnerability exists at the GET /api/v1/organization/customer-default-source endpo |
| [GHSA-2jch-qc96-9f5g](https://github.com/advisories/GHSA-2jch-qc96-9f5g) | medium | Fixed upstream | Flowise Cross-site Scripting in api/v1/chatflows/id |
| [GHSA-2qqc-p94c-hxwh](https://github.com/advisories/GHSA-2qqc-p94c-hxwh) | medium | Not applicable | Flowise: Weak Default Express Session Secret |
| [GHSA-4fr9-3x69-36wv](https://github.com/advisories/GHSA-4fr9-3x69-36wv) | medium | Fixed upstream | Flowise vulnerable to XSS |
| [GHSA-59fh-9f3p-7m39](https://github.com/advisories/GHSA-59fh-9f3p-7m39) | medium | Not applicable | Flowise: Mass Assignment in PUT /api/v1/user Allows Authenticated Users to Override Password Has |
| [GHSA-6pcv-j4jx-m4vx](https://github.com/advisories/GHSA-6pcv-j4jx-m4vx) | medium | Fixed in fork | Flowise: Unauthenticated Information Disclosure of OAuth Secrets (Cleartext) via GET Request |
| [GHSA-7r4h-vmj9-wg42](https://github.com/advisories/GHSA-7r4h-vmj9-wg42) | medium | Fixed upstream | Flowise Stored XSS vulnerability through logs in chatbot |
| [GHSA-858c-qxvx-rg9v](https://github.com/advisories/GHSA-858c-qxvx-rg9v) | medium | Fixed upstream | Flowise Cross-site Scripting in /api/v1/chatflows-streaming/id |
| [GHSA-8f47-4rh3-x44m](https://github.com/advisories/GHSA-8f47-4rh3-x44m) | medium | Not applicable | Flowise: Bcrypt Password Hash Exposure |
| [GHSA-8gj2-2cvc-6xx7](https://github.com/advisories/GHSA-8gj2-2cvc-6xx7) | medium | **FIXED IN fw10** | Flowise: Unauthenticated Credential Abuse via Text-to-Speech Endpoint Allows Unauthorized Use of |
| [GHSA-9c4c-g95m-c8cp](https://github.com/advisories/GHSA-9c4c-g95m-c8cp) | medium | Fixed upstream | FlowiseDB vulnerable to SQL Injection by authenticated users |
| [GHSA-9hrv-gvrv-6gf2](https://github.com/advisories/GHSA-9hrv-gvrv-6gf2) | medium | Fixed upstream | Flowise Execute Flow function has an SSRF vulnerability |
| [GHSA-c2c9-mfw7-p8hw](https://github.com/advisories/GHSA-c2c9-mfw7-p8hw) | medium | Fixed upstream | Flowise: Cross-Workspace Chatflow Disclosure via chatflows/apikey Endpoint Returns All Unprotect |
| [GHSA-cc4f-hjpj-g9p8](https://github.com/advisories/GHSA-cc4f-hjpj-g9p8) | medium | Not applicable | Flowise: Weak Default JWT Secrets |
| [GHSA-fccx-2pwj-hrq7](https://github.com/advisories/GHSA-fccx-2pwj-hrq7) | medium | Fixed upstream | Flowise Cross-site Scripting in /api/v1/public-chatflows/id |
| [GHSA-jc5m-wrp2-qq38](https://github.com/advisories/GHSA-jc5m-wrp2-qq38) | medium | Not applicable | Flowise Vulnerable to PII Disclosure on Unauthenticated Forgot Password Endpoint |
| [GHSA-m5p9-xvxj-64c8](https://github.com/advisories/GHSA-m5p9-xvxj-64c8) | medium | Fixed upstream | Flowise and Flowise Chat Embed vulnerable to Stored Cross-site Scripting |
| [GHSA-m7mq-85xj-9x33](https://github.com/advisories/GHSA-m7mq-85xj-9x33) | medium | Not applicable | Flowise: Weak Default Token Hash Secret |
| [GHSA-m837-xvxr-vqwg](https://github.com/advisories/GHSA-m837-xvxr-vqwg) | medium | Fixed upstream | Flowise: Hardcoded CORS wildcard on TTS endpoint enables cross-origin credential abuse from any  |
| [GHSA-qqvm-66q4-vf5c](https://github.com/advisories/GHSA-qqvm-66q4-vf5c) | medium | Fixed upstream | Flowise: SSRF Protection Bypass via Direct node-fetch / axios Usage (Patch Enforcement Failure) |
| [GHSA-rwrp-9823-p2xq](https://github.com/advisories/GHSA-rwrp-9823-p2xq) | medium | Fixed in fork | Flowise: Incomplete Credential Redaction Exposes Secrets via API |
| [GHSA-w6v6-49gh-mc9w](https://github.com/advisories/GHSA-w6v6-49gh-mc9w) | medium | Fixed upstream | Flowise: Path Traversal in Vector Store basePath |
| [GHSA-wxm4-9f8p-gggv](https://github.com/advisories/GHSA-wxm4-9f8p-gggv) | medium | Fixed upstream | Flowise Cross-site Scripting in/api/v1/credentials/id |
| [GHSA-x2g5-fvc2-gqvp](https://github.com/advisories/GHSA-x2g5-fvc2-gqvp) | medium | Fixed in fork | Flowise has Insufficient Password Salt Rounds |
