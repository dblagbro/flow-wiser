import bcrypt from 'bcryptjs'

/**
 * Password hashing.
 *
 * REQUIREMENTS-AUTH-RBAC.md §9: "Passwords and recovery codes are hashed (argon2id or bcrypt),
 * never encrypted; they are never decryptable, by us or anyone." Nothing in this file is
 * reversible, and nothing in it takes a key — which is why `User.credential`,
 * `MfaRecoveryCode.codeHash` and `Token.tokenHash` carry none of the EncryptionMetadata columns
 * (see `database/entities/identity/EncryptionMetadata.ts`, "Hashes are not encryption").
 *
 * ── Algorithm choice: bcrypt, not argon2id ───────────────────────────────────────────────────
 * §9 permits either. argon2id is the better primitive (memory-hard, so GPU/ASIC cracking is far
 * more expensive), but `argon2` is a native addon and is NOT in `packages/server/package.json` —
 * and this work is constrained to add no new runtime dependency. `bcryptjs` IS already a
 * dependency (`packages/server/package.json`, with `@types/bcryptjs`), so bcrypt is what ships.
 *
 * That choice is also what makes REQUIREMENTS-MIGRATION.md §5 possible: "the existing password
 * hash is carried across if its format is verifiable (bcrypt), so the operator is not locked out
 * mid-upgrade". A bcrypt-native verifier reads those hashes directly.
 *
 * ── The upgrade path to argon2id ─────────────────────────────────────────────────────────────
 * {@link PREFERRED_ALGORITHM} is the single switch. When `argon2` becomes an allowed dependency:
 *   1. flip `PREFERRED_ALGORITHM` to `PasswordAlgorithm.ARGON2ID` and implement the two argon2
 *      branches marked `ARGON2 UPGRADE POINT` below;
 *   2. every stored bcrypt hash then makes {@link needsRehash} return `true`, so each user is
 *      transparently migrated on their next successful login — no reset, no mass invalidation.
 * {@link identifyAlgorithm} and {@link verify} already recognise argon2id PHC strings and fail
 * *loudly* rather than reporting "wrong password" if one is encountered without a backend, so a
 * partially rolled-back deployment cannot silently lock a user out.
 *
 * ── bcrypt's 72-byte input limit ─────────────────────────────────────────────────────────────
 * bcrypt ignores input past 72 bytes. The usual mitigation — SHA-256 the password first — is
 * deliberately NOT used here: it would make our hashes incompatible with the upstream hashes
 * MIGRATION §5 requires us to verify. Instead the limit is enforced as a policy violation
 * ({@link PasswordViolation.EXCEEDS_BCRYPT_INPUT_LIMIT}) so a long passphrase is rejected at the
 * door rather than silently truncated, and the argon2id upgrade removes the limit entirely.
 */

/** Hashing constructions this module can produce or recognise (§9 permits argon2id or bcrypt) */
export enum PasswordAlgorithm {
    ARGON2ID = 'argon2id',
    BCRYPT = 'bcrypt'
}

/**
 * The algorithm new hashes are produced with. See "The upgrade path to argon2id" above — this is
 * the only line that has to change, because {@link needsRehash} keys off it.
 */
export const PREFERRED_ALGORITHM: PasswordAlgorithm = PasswordAlgorithm.BCRYPT

/**
 * bcrypt cost (log2 of rounds). 12 ≈ 250 ms on a 2024 server core.
 *
 * The Apache-2.0 tree publishes `PASSWORD_SALT_HASH_ROUNDS=10` (`packages/server/.env.example:124`).
 * 10 is roughly 4× cheaper to attack, and the value has not moved with hardware, so the default
 * here is raised to 12 rather than inherited. Because the cost is embedded in every hash string,
 * raising it later is not a flag day: {@link needsRehash} reports every under-cost hash and the
 * next successful login re-hashes it.
 */
export const DEFAULT_BCRYPT_COST = 12

/** Below this a hash is cheap enough to be worth attacking offline; above it logins get slow enough to be a DoS surface */
const MIN_BCRYPT_COST = 10
const MAX_BCRYPT_COST = 15

/** bcrypt reads at most 72 bytes of the password — see the header note on why we do not pre-hash */
export const BCRYPT_INPUT_LIMIT_BYTES = 72

/**
 * Policy floor, from SPEC-AUTH-RBAC.md §F-11: the only policy expressed anywhere in the
 * Apache-2.0 sources is the client-side zod schema (`packages/ui/src/utils/validation.js`) — min 8,
 * max 128, ≥1 lowercase, ≥1 uppercase, ≥1 digit, ≥1 special. §F-11 requires the server to enforce
 * *at least* that, because client validation is bypassable.
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

/** Anything that is not a letter or a digit counts as "special" — matches the client's intent without importing its regex */
const SPECIAL_CHARACTER = /[^A-Za-z0-9]/

/**
 * Values published in this repository or in its documentation, and the handful of defaults that
 * are published everywhere else.
 *
 * REQUIREMENTS §1 makes refusing these a hard requirement for the encryption key
 * ("Refuse to start when the key equals any known published example value"), and
 * REQUIREMENTS-MIGRATION.md §4 extends the same check to bootstrap passwords: the bootstrap
 * "refuses to run with a weak, blank, or known-published password — the same check that rejects
 * `myencryptionkey` for the encryption key".
 *
 * Exported because `keyring.ts` applies the identical list to key material — one list, so a value
 * added here cannot be forgotten there. Matching is case-insensitive and whitespace-trimmed.
 *
 * This is NOT a general-purpose weak-password dictionary. It is the "published example" denylist;
 * a full dictionary check belongs in the account service, where a breach corpus can be consulted.
 */
export const PUBLISHED_EXAMPLE_SECRETS: readonly string[] = [
    // Published in `packages/server/.env.example:25`, `docker/.env.example:25`,
    // `docker/worker/.env.example:25` — the value REQUIREMENTS §1 names explicitly.
    'myencryptionkey',
    // Published in `packages/server/.env.example:13` / `docker/.env.example:13`
    'mypassword',
    // Published in `packages/server/.env.example:100` / `docker/.env.example:101`
    'smtp_password',
    // Defaults that appear in the project's own docs and in every quick-start guide ever written
    'password',
    'password1',
    'password123',
    'passw0rd',
    'admin',
    'admin123',
    'administrator',
    'changeme',
    'change_me',
    'secret',
    'mysecret',
    'letmein',
    'flowise',
    'flowiseai',
    'flowwiser',
    'flow-wiser',
    'test',
    'test123',
    'testtest',
    '12345678',
    '123456789',
    'qwerty123',
    'default',
    'example'
]

const DENYLIST = new Set(PUBLISHED_EXAMPLE_SECRETS.map((value) => value.toLowerCase()))

/** Why a candidate password was rejected. Structured so a caller can decide what to disclose (SPEC §F-11). */
export enum PasswordViolation {
    /** Empty, or nothing but whitespace. REQUIREMENTS §2: "startup refuses default/blank credentials". */
    BLANK = 'blank',
    TOO_SHORT = 'too-short',
    TOO_LONG = 'too-long',
    MISSING_LOWERCASE = 'missing-lowercase',
    MISSING_UPPERCASE = 'missing-uppercase',
    MISSING_DIGIT = 'missing-digit',
    MISSING_SPECIAL = 'missing-special',
    /** On the {@link PUBLISHED_EXAMPLE_SECRETS} denylist (REQUIREMENTS §1, MIGRATION §4). */
    PUBLISHED_EXAMPLE = 'published-example',
    /** Longer than bcrypt can read; accepting it would silently ignore the tail (see header). */
    EXCEEDS_BCRYPT_INPUT_LIMIT = 'exceeds-bcrypt-input-limit'
}

/**
 * Raised by {@link hash} for any candidate that fails {@link validatePassword}.
 *
 * The message names the violations, never the candidate — REQUIREMENTS §9: "encrypted values never
 * appear in logs, audit records, API responses, or error messages", and a rejected password is
 * exactly the sort of value that ends up in a stack trace.
 */
export class PasswordPolicyError extends Error {
    readonly violations: readonly PasswordViolation[]

    constructor(violations: readonly PasswordViolation[]) {
        super(`Password rejected by policy: ${violations.join(', ')}`)
        this.name = 'PasswordPolicyError'
        this.violations = violations
    }
}

/** Raised when a stored hash cannot be verified by this build — never confused with "wrong password" */
export class UnsupportedHashError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UnsupportedHashError'
    }
}

const readCost = (): number => {
    const configured = process.env.IDENTITY_PASSWORD_BCRYPT_COST
    if (!configured) return DEFAULT_BCRYPT_COST
    const parsed = Number.parseInt(configured, 10)
    // A malformed or out-of-range value must not silently weaken hashing, so it is ignored rather
    // than clamped toward the caller's intent.
    if (!Number.isInteger(parsed) || parsed < MIN_BCRYPT_COST || parsed > MAX_BCRYPT_COST) return DEFAULT_BCRYPT_COST
    return parsed
}

/** The cost new hashes are produced at, after applying `IDENTITY_PASSWORD_BCRYPT_COST` */
export const activeBcryptCost = (): number => readCost()

/**
 * Every policy violation of `plain`, in a stable order. Empty array = acceptable.
 *
 * Returns all of them rather than the first, so a registration form can show the user everything
 * that is wrong in one pass instead of one rule per attempt.
 */
export const validatePassword = (plain: unknown): PasswordViolation[] => {
    const violations: PasswordViolation[] = []
    if (typeof plain !== 'string' || plain.trim().length === 0) return [PasswordViolation.BLANK]

    if (plain.length < PASSWORD_MIN_LENGTH) violations.push(PasswordViolation.TOO_SHORT)
    if (plain.length > PASSWORD_MAX_LENGTH) violations.push(PasswordViolation.TOO_LONG)
    if (!/[a-z]/.test(plain)) violations.push(PasswordViolation.MISSING_LOWERCASE)
    if (!/[A-Z]/.test(plain)) violations.push(PasswordViolation.MISSING_UPPERCASE)
    if (!/[0-9]/.test(plain)) violations.push(PasswordViolation.MISSING_DIGIT)
    if (!SPECIAL_CHARACTER.test(plain)) violations.push(PasswordViolation.MISSING_SPECIAL)
    if (DENYLIST.has(plain.trim().toLowerCase())) violations.push(PasswordViolation.PUBLISHED_EXAMPLE)
    // Byte length, not character length: one emoji is four bytes of the 72 available.
    if (PREFERRED_ALGORITHM === PasswordAlgorithm.BCRYPT && Buffer.byteLength(plain, 'utf8') > BCRYPT_INPUT_LIMIT_BYTES) {
        violations.push(PasswordViolation.EXCEEDS_BCRYPT_INPUT_LIMIT)
    }

    return violations
}

/**
 * Hash `plain` for storage in `User.credential`.
 *
 * Enforces {@link validatePassword} unconditionally — there is no "skip the policy" option, because
 * REQUIREMENTS §2 requires startup to refuse default/blank credentials and an escape hatch here
 * would be the first thing a bootstrap script reached for. Migrating an existing upstream hash
 * (MIGRATION §5) does not call this function: it stores the hash it already has.
 *
 * @throws {PasswordPolicyError} when `plain` violates the policy.
 */
export const hash = async (plain: string): Promise<string> => {
    const violations = validatePassword(plain)
    if (violations.length > 0) throw new PasswordPolicyError(violations)

    // ARGON2 UPGRADE POINT — branch on PREFERRED_ALGORITHM here.
    // bcrypt generates its own 128-bit salt per call and embeds it in the output string, so two
    // users with the same password never share a hash.
    return bcrypt.hash(plain, readCost())
}

/** Which construction produced `stored`, or `null` if the format is unrecognised (MIGRATION §5: migrate such accounts disabled) */
export const identifyAlgorithm = (stored: unknown): PasswordAlgorithm | null => {
    if (typeof stored !== 'string') return null
    // PHC string format: $argon2id$v=19$m=...,t=...,p=...$salt$hash
    if (stored.startsWith('$argon2id$') || stored.startsWith('$argon2i$') || stored.startsWith('$argon2d$')) {
        return PasswordAlgorithm.ARGON2ID
    }
    // Modular crypt format: $2a$, $2b$, $2y$ (and the legacy $2$/$2x$ we do not accept), cost, 53 chars of salt+digest
    if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(stored)) return PasswordAlgorithm.BCRYPT
    return null
}

/** The cost embedded in a bcrypt hash string, or `null` if `stored` is not a bcrypt hash */
const bcryptCostOf = (stored: string): number | null => {
    const match = /^\$2[aby]\$(\d{2})\$/.exec(stored)
    return match ? Number.parseInt(match[1], 10) : null
}

/**
 * A dummy hash for the unknown-user path.
 *
 * Built from a real generated salt (which is cheap — no key expansion happens until `hash` runs)
 * at the CURRENT cost, so {@link verifyDummy} burns the same work as a genuine verification even
 * after the cost is raised. It is never compared against anything: the point is the elapsed time.
 */
const dummySalt = (): string => bcrypt.genSaltSync(readCost())

/** Arbitrary constant. Never a valid credential — it fails the policy, so it can never be a real user's password. */
const DUMMY_PASSWORD = 'flow-wiser-dummy-verification-input'

/**
 * Burn the time a real {@link verify} would take, then report failure.
 *
 * REQUIREMENTS §10 records "login success/failure (+ reason)", which means the failure paths are
 * exercised constantly and their timing is observable. Without this, "no such user" returns in
 * microseconds while "wrong password" takes ~250 ms, and the login endpoint becomes an account
 * enumeration oracle. The login service MUST call this on every path where a user record, or the
 * user's `credential`, is absent.
 *
 * Always resolves `false`, so a caller cannot accidentally treat it as success.
 */
export const verifyDummy = async (): Promise<false> => {
    await bcrypt.hash(DUMMY_PASSWORD, dummySalt())
    return false
}

/**
 * Verify `plain` against a stored hash.
 *
 * Comparison is length-independent: `bcryptjs` compares through its `safeStringCompare`
 * (`node_modules/bcryptjs/dist/bcrypt.js:240`), which walks the full string and accumulates a
 * difference rather than returning at the first mismatched byte.
 *
 * A malformed or absent hash burns dummy time before returning `false`, for the same enumeration
 * reason as {@link verifyDummy} — an account whose `credential` is `null` (an SSO-only or
 * not-yet-registered user, see `User.credential`) must be indistinguishable from a wrong password.
 *
 * @throws {UnsupportedHashError} when the hash is a recognised format this build cannot verify.
 *         Deliberately NOT `false`: an argon2id hash on a build without an argon2 backend is an
 *         operator error, and reporting it as a wrong password would send the user to reset a
 *         perfectly good credential.
 */
export const verify = async (plain: unknown, stored: unknown): Promise<boolean> => {
    const algorithm = identifyAlgorithm(stored)

    if (algorithm === PasswordAlgorithm.ARGON2ID) {
        // ARGON2 UPGRADE POINT — verify through the argon2 backend here.
        throw new UnsupportedHashError('Stored credential is an argon2id hash, but this build has no argon2 backend')
    }

    if (typeof plain !== 'string' || plain.length === 0 || algorithm !== PasswordAlgorithm.BCRYPT) {
        return verifyDummy()
    }

    try {
        return await bcrypt.compare(plain, stored as string)
    } catch {
        // bcryptjs throws on a hash it cannot parse. `identifyAlgorithm` should have caught that,
        // so this is belt-and-braces: fail closed, and do not leak the difference through timing.
        return verifyDummy()
    }
}

/**
 * Should `stored` be replaced by a fresh {@link hash} of the same password?
 *
 * Call it after a SUCCESSFUL {@link verify} — that is the one moment the plaintext is in hand and
 * can be re-hashed without involving the user. Returns `true` when:
 *   - the hash was produced by an algorithm we no longer prefer (the argon2id migration), or
 *   - it is a bcrypt hash below the current cost (a cost raise), or
 *   - the format is unrecognised (MIGRATION §5's "cannot be identified" case — the caller should
 *     treat that as an account to disable rather than silently re-hash, but it is not "current").
 */
export const needsRehash = (stored: unknown): boolean => {
    const algorithm = identifyAlgorithm(stored)
    if (algorithm === null) return true
    if (algorithm !== PREFERRED_ALGORITHM) return true
    if (algorithm === PasswordAlgorithm.BCRYPT) {
        const cost = bcryptCostOf(stored as string)
        return cost === null || cost < readCost()
    }
    return false
}
