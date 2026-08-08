# Compliance posture

**What this document is.** A map from the controls SOC 2, HIPAA and PCI-DSS ask about to what
Flow-Wiser actually implements, with the evidence for each claim and an honest statement of what is
missing. It is written to be handed to an auditor or pasted into a customer security questionnaire.

**What this document is not.** A claim of certification. SOC 2 is an audit of an *organisation*
against controls it defines, evidenced over a 3–12 month window by a licensed CPA firm. HIPAA
requires a covered-entity relationship, Business Associate Agreements, and administrative and
physical safeguards far beyond software. PCI-DSS applies only where cardholder data is stored,
processed or transmitted. **No amount of code makes software "SOC 2 compliant."** What software can
do is avoid being the thing that blocks the audit, and provide the evidence the auditor asks for.
That is the bar this document measures against.

**Last verified:** 2026-08-07 against `3.1.4-fw6`.

---

## How to read the status column

| Status | Meaning |
|---|---|
| **Implemented** | In the product, on by default, with evidence named |
| **Available** | In the product, **off by default**, can be enabled and tested |
| **Deployment** | The product supports it; whether it is true depends on how *this* instance is configured |
| **Organisational** | Not a software control. Listed so it is accounted for, not silently missing |
| **Gap** | Not implemented. Named rather than omitted |

---

## Encryption

| Control | Status | Evidence |
|---|---|---|
| Credential encryption at rest | **Implemented** | AES-256-GCM with HKDF-SHA-256, per-record nonce and salt (`utils/credentialEnvelope.ts`, `identity/crypto/aead.ts`) |
| Authenticated encryption (tamper detection) | **Implemented** | GCM auth tag; a modified record fails to decrypt rather than yielding altered data |
| Identity secret encryption at rest | **Implemented** | Same keyring; per-record key version, algorithm, nonce, salt |
| Key versioning on every record | **Implemented** | `envelopeKeyVersion()` reports a record's key version **without decrypting it** |
| Documented key rotation procedure | **Implemented** | `flowise credential:rotate-encryption` — dry run by default, round-trip proven before any write, single transaction, aborts wholly on any failure |
| Rotation is resumable and countable | **Implemented** | Records carry their key version, so "how many are still on the retired key?" is answerable without decryption |
| Key never generated silently | **Implemented** | `identity/crypto/keyring.ts` refuses to start rather than invent a key that would strand existing ciphertext |
| Published example keys refused | **Implemented** | Keyring rejects known `.env.example` values |
| Encryption in transit (client ↔ server) | **Deployment** | TLS terminated at the reverse proxy. The application is not intended to be exposed directly |
| Session cookies `Secure` + `HttpOnly` + `SameSite` | **Implemented** | Verified on the wire; driven by `NODE_ENV=production` or `IDENTITY_COOKIE_SECURE` |
| HSTS | **Gap** | Not set at the edge. A first visit can be downgraded before the redirect |
| Encryption in transit (app ↔ database) | **Deployment** | Local SQLite has no wire. A remote Postgres deployment must enable TLS in its connection settings |
| Key stored separately from data | **Deployment** | Supported via `IDENTITY_ENCRYPTION_KEY_FILE` (mode 0400/0600 enforced) or a KMS/Vault reference |

**Legacy-format note.** Records written before `3.1.4-fw6` used `crypto-js` AES with a static
passphrase: unauthenticated, MD5-based key derivation, no key version. Both formats are readable;
new writes always use the authenticated envelope; `credential:rotate-encryption` migrates the rest.
An instance that has not run the rotation still holds legacy records, and
`credential:rotate-encryption` (dry run) reports exactly how many.

---

## Access control and identity

| Control | Status | Evidence |
|---|---|---|
| Unique per-user identity | **Implemented** | `identity_user`; no shared accounts by construction |
| Role-based access control | **Implemented** | 82 permissions across 19 categories, deny-by-default, validated at route-mount time |
| Least privilege — defined role tiers | **Implemented** | Six seeded roles: super-admin, admin, super-user, org-admin, user, read-only |
| Separation of duties for secrets | **Implemented** | `credentials:reveal` is held only by admin and super-admin. `super-user` can audit the entire system without ever seeing a credential value |
| Credential values not exposed by default | **Implemented** | `GET /credentials/:id` returns redacted values; `/reveal` requires the permission and is audited |
| Multi-factor authentication | **Available** | TOTP (RFC 6238) with hashed recovery codes; `MfaPolicyService` can require it org-wide or per-role. Off until configured |
| SSO / federated identity | **Available** | `LoginMethod` with per-provider config; client secret encrypted at rest |
| Brute-force protection | **Implemented** | Two composed rate limiters on `/auth/login` — per-IP **and** per-account |
| Session revocation | **Implemented** | Individual and bulk; `session:revoke-all`, and every password change revokes all sessions |
| Forced credential rotation | **Implemented** | `mustChangePassword`; enforced on every route until satisfied |
| Password policy | **Implemented** | Length, character-class and published-example-denylist checks (`identity/crypto/passwords.ts`) |
| Automatic session expiry | **Implemented** | Refresh window with expiry recorded per session |
| Tenant isolation | **Implemented** | Every content query scoped by `workspaceId`; verified no cross-tenant IDOR in an independent review (2026-08-07) |
| Break-glass / recovery access | **Implemented** | 8 recovery CLI commands; passwords read from `/dev/tty` only — never a flag, pipe or environment variable |
| Periodic access review | **Organisational** | `flowise admin:list` produces the data; the review itself is a process |

---

## Audit and monitoring

| Control | Status | Evidence |
|---|---|---|
| Security event logging | **Implemented** | One append-only trail across six domains: authentication, authorization, identity administration, credential use, flow changes, data access |
| Append-only by construction | **Implemented** | No `updatedDate`, no soft-delete, no update path on `AuditEvent` |
| Gap detection | **Implemented** | Monotonic `seqNo`; a missing number is evidence of tampering or a failed insert |
| Who / what / when / where | **Implemented** | Subject, target, scope, route pattern, IP, user agent on every event |
| Secrets never in the trail | **Implemented** | Central redactor drops any key whose name matches a secret-shaped pattern |
| Credential disclosure recorded | **Implemented** | `credential.decrypt` written on every use, by reference, never by value |
| Export for review | **Implemented** | `flowise audit:export` → JSONL plus a SHA-256 manifest with the seqNo range covered |
| Tamper **evidence** | **Implemented** | Re-exporting a range must reproduce the digest; a mismatch proves rows changed |
| Tamper **proofing** | **Gap** | Stated plainly: an actor with database write access could rewrite history and re-export. A hash-chained or externally-shipped log would be required, and is not implemented |
| Export is itself audited | **Implemented** | `identity.recovery.audit.export` records who took a copy of the log |
| Retention period enforcement | **Gap** | No automatic pruning or archival. Events accumulate indefinitely; retention is currently a manual decision |
| Log review cadence | **Organisational** | The export exists to make review possible; performing it is a process |
| Alerting on security events | **Gap** | No alerting integration. Events are recorded, not pushed |

---

## Application security

| Control | Status | Evidence |
|---|---|---|
| No unauthenticated remote code execution | **Implemented** | Independently assessed 2026-08-07: none found |
| Code sandbox cannot reach the host filesystem | **Implemented** | 20 host-access builtins denied in code regardless of configuration (`filterDangerousBuiltIns`) |
| Sandbox containment not defeatable by config | **Implemented** | The denylist is in code; the escape hatch requires an exact acknowledgement string |
| Runtime variables cannot read process secrets | **Implemented** | `FLOWISE_VAR_` prefix required; the environment must opt in |
| SSRF protection | **Implemented** | Deny list covers cloud metadata (`169.254.169.254`), all RFC1918, loopback, `::1`, across redirect chains |
| Public flows cannot execute code | **Implemented** | Publishing a flow containing a code-execution node is refused |
| SQL injection | **Implemented** | TypeORM-parameterised throughout; raw SQL only in migrations and in `doctor` with whitelisted identifiers |
| Dependency currency | **Deployment** | Reviewed 2026-08-07, no vulnerable pins found. Continuous scanning is a **Gap** — no `npm audit` gate in CI |
| Sandbox uses a supported runtime | **Gap** | `vm2` is deprecated and unpatchable. Escapes are blocked by configuration (`Proxy` removed, `eval:false`), not by the library. Replacement with `isolated-vm` or the E2B remote sandbox is outstanding |

---

## Toggles — everything that can be turned off, and what it costs

Every safety control here can be disabled for tracing, and every one warns loudly when it is. This
table exists so that "we turned it off to debug" is a recorded decision rather than a discovery.

| Variable | Default | Setting it off means |
|---|---|---|
| `CREDENTIAL_ENVELOPE_ENCRYPTION=false` | on | New credentials written in the legacy unauthenticated format. Reading both formats always works, so this can be flipped back without stranding data |
| `TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS` | off | Code nodes may `require('fs')`, `child_process` etc. Anyone who can author a flow can read every stored secret |
| `FLOWISE_VAR_ALLOW_UNPREFIXED=true` | off | Runtime variables resolve arbitrary `process.env`. On a multi-user instance this is a full RBAC bypass |
| `HTTP_SECURITY_CHECK=false` | on | SSRF deny list disabled |
| `IDENTITY_COOKIE_SECURE=false` | on in production | Session cookies may travel over plaintext |

---

## What is missing, in the order it should be fixed

1. **Audit retention policy and pruning** — events accumulate indefinitely. Frameworks specify a
   retention period (PCI-DSS 10.7: one year, three months immediately available). Needs a documented
   period and an enforcement mechanism.
2. **`vm2` replacement** — the only control that is configuration rather than architecture.
3. **HSTS at the edge** — one line, closes the first-visit downgrade window.
4. **Dependency scanning in CI** — currently a point-in-time review.
5. **Alerting** — events are recorded but nothing is notified.
6. **Hash-chained audit log** — would upgrade tamper *evidence* to tamper *proofing*.

## Organisational controls — accounted for, not implemented here

Named so a reader can see they were considered: security policies and their annual review, risk
assessment, vendor management, incident response plan and testing, business continuity and disaster
recovery, workforce training, background checks, physical security of the hosting environment,
Business Associate Agreements (HIPAA), and the SOC 2 observation window itself. None of these is a
software feature; all are required by the frameworks.

## Data classification

**Gap, and a prerequisite for a HIPAA or GDPR conversation.** Flow-Wiser stores flow definitions,
credentials, chat messages and execution history. Chat messages and execution history may contain
whatever a user sends to a flow, which in a healthcare deployment could include PHI. Nothing in the
product currently classifies, tags, or applies differential retention to that data. Any deployment
handling regulated data needs a documented inventory of what flows through it before this document
can be used to answer a questionnaire about it.
