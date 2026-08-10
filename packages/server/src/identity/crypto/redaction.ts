/**
 * Central redaction.
 *
 * REQUIREMENTS-AUTH-RBAC.md §9 states the rule and, unusually, also states how it must be
 * implemented: "Encrypted values never appear in logs, audit records, API responses, or error
 * messages. **Redaction is enforced centrally, not per call site.**" §10 repeats it for the audit
 * trail: "Never contains secrets. Credential values, tokens, MFA seeds and password hashes are
 * recorded by reference, never by value."
 *
 * Per-call-site redaction fails for a reason worth writing down: it is a rule about every future
 * line of code, enforced by everyone remembering it. One forgotten `logger.debug({ user })` and a
 * password hash is in a log file forever. So this module is the thing a logger, an audit sink and
 * an error serialiser pass values THROUGH — the call site does not choose, it only writes.
 *
 * ── Two independent gates ────────────────────────────────────────────────────────────────────
 *   1. **By key name.** `{ clientSecret: 'hunter2' }` is redacted because of the key, whatever the
 *      value looks like. This is the reliable half — the names are enumerated in
 *      {@link SECRET_KEY_NAMES} and {@link SECRET_KEY_KEYWORDS}, both exported so tests can assert
 *      that every encrypted or hashed column in the identity schema is covered.
 *   2. **By value shape.** A JWT, a bcrypt hash, a `Bearer` header, a PEM private key or a long
 *      base64 blob is redacted wherever it appears — including inside a string that was never a
 *      key/value pair at all, such as an exception message or a URL with inline credentials. This
 *      is the heuristic half: it exists because secrets leak most often through values nobody
 *      labelled.
 *
 * ── Deliberately biased toward over-redaction ────────────────────────────────────────────────
 * A redacted field costs a debugging session. A leaked one costs the credential. Where the two
 * conflict, the field goes. The one concession is {@link REDACTION_ALLOWLIST}: the
 * EncryptionMetadata siblings (`XKeyId`, `XKeyVersion`, `XAlgorithm`, `XNonce`, `XSalt`) contain
 * the word "secret" for columns like `MfaFactor.secretNonce`, yet none of them is secret and the
 * key version in particular is what makes a rotation auditable. They are named individually rather
 * than pattern-matched, so the exception cannot quietly widen.
 *
 * ── What this is not ─────────────────────────────────────────────────────────────────────────
 * Not a security boundary against an attacker who controls the data being logged — a determined
 * one can always encode a secret into a shape no heuristic recognises. It is a guarantee about
 * OUR OWN code paths: the values this system stores encrypted or hashed do not reach a sink in
 * readable form.
 */

/** What a removed value is replaced with. A fixed marker, so a log reader can tell "absent" from "withheld". */
export const REDACTION_MARKER = '[redacted]'

/** Guards against a hostile or accidentally recursive structure turning a log call into a hang */
const MAX_DEPTH = 12

/**
 * Field names redacted on sight, after normalisation (lower-cased, `_`/`-`/spaces removed) — so
 * `client_secret`, `clientSecret` and `CLIENT-SECRET` are one entry.
 *
 * Every encrypted or hashed column in `database/entities/identity/` appears here:
 *   `User.credential`, `MfaFactor.secret`, `MfaRecoveryCode.codeHash`, `Token.tokenHash`,
 *   `LoginMethod.clientSecret`, `Session.refreshTokenHash`, plus the ambient wire names the HTTP
 *   layer uses (`password`, `newPassword`, `confirmPassword`, `token`, …).
 *
 * Exported so a test can assert coverage — see the module header.
 */
export const SECRET_KEY_NAMES: readonly string[] = [
    // Identity columns
    'credential',
    'credentials',
    'secret',
    'clientsecret',
    'codehash',
    'tokenhash',
    'refreshtokenhash',
    'refreshtoken',
    'accesstoken',
    'idtoken',
    'temptoken',
    'sessiontoken',
    'csrftoken',
    'token',
    'tokens',
    // Passwords, in every spelling the wire uses
    'password',
    'passwd',
    'pwd',
    'passphrase',
    'newpassword',
    'oldpassword',
    'currentpassword',
    'confirmpassword',
    'passwordconfirmation',
    'passwordhash',
    // Keys and key material
    'key',
    'apikey',
    'apisecret',
    'secretkey',
    'privatekey',
    'publicprivatekey',
    'accesskey',
    'accesskeyid',
    'secretaccesskey',
    'encryptionkey',
    'signingkey',
    'sessionsecret',
    'cookiesecret',
    'jwtsecret',
    'hmackey',
    'pepper',
    // MFA (§8) — the seed is encrypted, the recovery codes are hashed; neither is ever displayed twice
    'totpsecret',
    'mfasecret',
    'otpsecret',
    'recoverycode',
    'recoverycodes',
    'backupcode',
    'backupcodes',
    'provisioninguri',
    'otpauthurl',
    // Transport headers that carry the above
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'xapikey',
    // Upstream's own key variable, so a config dump cannot print it
    'flowisesecretkeyoverwrite',
    'identityencryptionkey'
]

/**
 * Substrings that make a field name secret wherever they appear, so a name nobody anticipated —
 * `stripeWebhookSecret`, `smtpPassword`, `oauthRefreshToken` — is still caught.
 *
 * `salt` and `nonce` are absent on purpose: they are public inputs by design (EncryptionMetadata.ts),
 * and redacting them would hide the very fields an operator needs to debug a rotation.
 */
export const SECRET_KEY_KEYWORDS: readonly string[] = [
    'password',
    'passwd',
    'passphrase',
    'secret',
    'credential',
    'token',
    'apikey',
    'privatekey',
    'accesskey',
    'encryptionkey',
    'authorization',
    'recoverycode',
    'backupcode'
]

/**
 * Normalised names that are NOT secret despite matching a keyword. Narrow, enumerated, and never
 * a pattern — see "Deliberately biased toward over-redaction" in the module header.
 *
 * These are the EncryptionMetadata siblings for the three encrypted columns that exist today, plus
 * the identifiers that reference a secret without being one. Losing them from logs would defeat
 * §9's "resumable and auditable" rotation, which is diagnosed almost entirely from key versions.
 */
export const REDACTION_ALLOWLIST: readonly string[] = [
    'keyid',
    'keyversion',
    'credentialid',
    'credentialname',
    'credentialupdateddate',
    'tokenid',
    'tokentype',
    'tokenexpiry',
    'secretkeyid',
    'secretkeyversion',
    'secretalgorithm',
    'secretnonce',
    'secretsalt',
    'clientsecretkeyid',
    'clientsecretkeyversion',
    'clientsecretalgorithm',
    'clientsecretnonce',
    'clientsecretsalt'
]

const NAMES = new Set(SECRET_KEY_NAMES)
const ALLOWED = new Set(REDACTION_ALLOWLIST)

/** Lower-case and drop the separators, so one entry covers camelCase, snake_case and kebab-case */
const normalizeKeyName = (name: string): string => name.toLowerCase().replace(/[\s_\-.]/g, '')

/** Should a field with this name have its value replaced, whatever the value is? */
export const isSecretKey = (name: string): boolean => {
    const normalized = normalizeKeyName(name)
    if (ALLOWED.has(normalized)) return false
    if (NAMES.has(normalized)) return true
    return SECRET_KEY_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

/**
 * Secret-shaped substrings, replaced in place wherever they occur — including inside a message
 * that is otherwise worth keeping. Each keeps enough context for the line to remain readable
 * ("Bearer [redacted]" says more than "[redacted]").
 *
 * `g` flags are required: these are used with `String.replace` and must hit every occurrence.
 */
export const SECRET_VALUE_PATTERNS: readonly { name: string; pattern: RegExp; replacement: string }[] = [
    /** PEM private key block — checked first, since it spans lines and contains base64 that later rules would nibble at */
    {
        name: 'pem-private-key',
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        replacement: REDACTION_MARKER
    },
    /** `scheme://user:password@host` — credentials in a connection string, the classic accidental log line */
    { name: 'url-userinfo', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replacement: `$1${REDACTION_MARKER}@` },
    { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `Bearer ${REDACTION_MARKER}` },
    { name: 'basic-auth', pattern: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: `Basic ${REDACTION_MARKER}` },
    /** JWT — three base64url segments; the header of a real one always starts `eyJ` */
    { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, replacement: REDACTION_MARKER },
    /** bcrypt modular-crypt hash — §10: password hashes are "recorded by reference, never by value" */
    { name: 'bcrypt-hash', pattern: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, replacement: REDACTION_MARKER },
    /**
     * argon2 PHC string, for the day PREFERRED_ALGORITHM moves (passwords.ts).
     *
     * The comma matters. The original class was `[^\s"',)}\]]+`, which excludes `,` — and every
     * real argon2 string carries `m=65536,t=3,p=4`, so the match stopped at the first comma and
     * left the salt and the digest in clear text. It redacted a comma-free argon2 string perfectly,
     * which is exactly why it survived review and why the test for it is a NEGATIVE one.
     *
     * `$` is included because PHC uses it as the field separator; the run still terminates on
     * whitespace, quotes and brackets so it cannot swallow the rest of a log line.
     */
    { name: 'argon2-hash', pattern: /\$argon2(?:id|i|d)\$[^\s"')}\]]+/g, replacement: REDACTION_MARKER },
    /**
     * libpq keyword/value connection string — `host=db user=x password=secret dbname=y`.
     * The URL form (`postgres://u:p@h`) was already covered by `url-userinfo`; this space-delimited
     * form is what actually appears in a driver error message, and it passed through untouched.
     */
    { name: 'libpq-password', pattern: /\bpassword\s*=\s*[^\s;'"]+/gi, replacement: 'password=' + REDACTION_MARKER },
    { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTION_MARKER },
    /** Provider key prefixes common in credentials stored by flow nodes (OpenAI-style, GitHub, Slack) */
    { name: 'prefixed-api-key', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTION_MARKER },
    { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTION_MARKER },
    { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTION_MARKER }
]

/**
 * Whole-string shapes that are almost certainly key material or ciphertext: a long base64 blob (an
 * `EncryptedValue.ciphertext` is exactly this) or a long hex string (a digest, or hex-encoded key
 * material).
 *
 * Applied only to a COMPLETE string, never inline, because these shapes are too generic to hunt
 * for inside prose — a sentence containing a long word would start disappearing. The thresholds
 * sit above anything the identity schema stores in the clear: a UUID is 36 characters and contains
 * hyphens, so it is untouched.
 */
const WHOLE_VALUE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
    { name: 'base64-blob', pattern: /^[A-Za-z0-9+/]{40,}={0,2}$/ },
    { name: 'hex-blob', pattern: /^[0-9a-fA-F]{64,}$/ }
]

/**
 * Redact a bare string: inline patterns first, then the whole-value heuristics.
 *
 * Exported for the two places that never see a key name — an error message and a raw log line.
 */
export const redactString = (value: string): string => {
    let result = value
    for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
        // `lastIndex` is per-regex state on a `g` regex; `replace` resets it, but be explicit
        // because these RegExp objects are module-level and shared across calls.
        pattern.lastIndex = 0
        result = result.replace(pattern, replacement)
    }
    if (result === value && WHOLE_VALUE_PATTERNS.some(({ pattern }) => pattern.test(value.trim()))) return REDACTION_MARKER
    return result
}

const isPlainish = (value: object): boolean => {
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

const redactValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (value === null || value === undefined) return value

    const type = typeof value
    if (type === 'string') return redactString(value as string)
    if (type === 'number' || type === 'boolean' || type === 'bigint') return value
    // A function or symbol in a log payload is noise at best and a closure over a secret at worst.
    if (type === 'function' || type === 'symbol') return `[${type}]`

    if (depth > MAX_DEPTH) return '[max-depth]'

    const object = value as object
    if (seen.has(object)) return '[circular]'

    if (object instanceof Date) return object
    // Never the contents: raw bytes in a log are usually key material, a nonce, or a decrypted
    // buffer that has not been zeroed yet. The length is the only useful part.
    if (Buffer.isBuffer(object)) return `[Buffer ${object.length} bytes]`
    if (ArrayBuffer.isView(object)) return `[${object.constructor?.name ?? 'TypedArray'}]`

    if (object instanceof Error) {
        // Errors reach log sinks constantly and their messages are assembled from whatever failed —
        // which is exactly where a credential ends up. Message AND stack are both scrubbed.
        const redacted: Record<string, unknown> = {
            name: object.name,
            message: redactString(object.message),
            stack: object.stack ? redactString(object.stack) : undefined
        }
        seen.add(object)
        for (const key of Object.keys(object)) {
            if (key === 'name' || key === 'message' || key === 'stack') continue
            redacted[key] = isSecretKey(key)
                ? REDACTION_MARKER
                : redactValue((object as unknown as Record<string, unknown>)[key], depth + 1, seen)
        }
        return redacted
    }

    seen.add(object)

    if (Array.isArray(object)) return object.map((entry) => redactValue(entry, depth + 1, seen))

    if (object instanceof Map) {
        const result: Record<string, unknown> = {}
        for (const [key, entry] of object.entries()) {
            const name = String(key)
            result[name] = isSecretKey(name) ? REDACTION_MARKER : redactValue(entry, depth + 1, seen)
        }
        return result
    }

    if (object instanceof Set) return [...object].map((entry) => redactValue(entry, depth + 1, seen))

    const result: Record<string, unknown> = {}
    // Own enumerable keys only — a class instance (a TypeORM entity, say) is copied field by field
    // rather than reconstructed, because the point is to produce something inert and loggable, not
    // a working object.
    for (const key of Object.keys(object)) {
        const entry = (object as Record<string, unknown>)[key]
        result[key] = isSecretKey(key) ? REDACTION_MARKER : redactValue(entry, depth + 1, seen)
    }
    // A class instance loses its identity in the clone, so keep the name — "which entity was this?"
    // is usually the question being asked of the log line.
    if (!isPlainish(object) && object.constructor?.name && object.constructor.name !== 'Object') {
        result['@type'] = object.constructor.name
    }
    return result
}

/**
 * Deep-clone `value` with every secret removed. The input is never mutated: a logger must not
 * change the object the application is still using.
 *
 * Intended wiring (not done here — these modules are standalone): the winston formatter, the audit
 * sink, and the Express error handler each pass their payload through this on the way out. Once
 * they do, a call site cannot leak a secret by forgetting to strip it, which is what §9 means by
 * "enforced centrally, not per call site".
 *
 * ── On the return type ───────────────────────────────────────────────────────────────────────
 * `T` in, `T` out is the one unsound line in this file, and it is deliberate. Redaction really can
 * change shape: a `Buffer` comes back as a string, an `Error` as a plain object. It is typed this
 * way because every genuine call site is a logger, an audit sink or an error serialiser handing
 * over a JSON-ish payload — for which the shape IS preserved — and typing it `unknown` would put a
 * cast at every one of those call sites, which is the per-call-site burden §9 exists to remove.
 * Callers that pass binary or Error values should treat the result as opaque and only serialise it.
 */
export const redact = <T>(value: T): T => redactValue(value, 0, new WeakSet<object>()) as T
