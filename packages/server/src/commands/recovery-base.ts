import fs from 'fs'
import os from 'os'
import path from 'path'
import tty from 'tty'
import { DataSource } from 'typeorm'
import { AuditAction, AuditOutcome, AuditSubjectType } from '../database/entities/identity/AuditEvent'
import { Assistant } from '../database/entities/Assistant'
import { ChatFlow } from '../database/entities/ChatFlow'
import { Credential } from '../database/entities/Credential'
import {
    AuditEvent,
    LoginMethod,
    MfaFactor,
    MfaRecoveryCode,
    Organization,
    OrganizationUser,
    Role,
    Session,
    Token,
    User,
    Workspace,
    WorkspaceUser
} from '../database/entities/identity'
import { PasswordPolicyError, PasswordViolation, hash, validatePassword } from '../identity/crypto/passwords'
import { AuditService } from '../identity/services/AuditService'
import { BaseCommand } from './base'

/**
 * Shared machinery for the recovery CLI (REQUIREMENTS-MIGRATION.md §7).
 *
 * §7: "Every identity operation must be performable **without a working UI and without a working
 * login**, because the failure modes that need recovery are exactly the ones that break both."
 *
 * That sentence drives every decision in this file.
 *
 * ── Why this file exists at all, next to `base.ts` ───────────────────────────────────────────
 * `BaseCommand` is the environment/flag plumbing every Flowise command shares, and the recovery
 * commands still want it (a break-glass operator must be able to say `--DATABASE_PATH=/data` the
 * same way `flowise start` does). What it does NOT give is a database connection, an audit sink or
 * a password prompt, and all three are needed identically by eight commands. They live here rather
 * than being copied eight times, for the same reason `base.ts` exists.
 *
 * ── Why the recovery DataSource is built here instead of reusing `../DataSource` ─────────────
 * `DataSource.getDataSource()` binds the FULL entity graph — every table the running server knows
 * about, resolved through `database/entities/index.ts`. A recovery tool that imports the whole
 * application's entity map inherits every one of that map's failure modes: one entity that fails to
 * resolve and the tool that was supposed to diagnose the instance cannot open the database either.
 * The recovery commands therefore open their own connection over an EXPLICIT, minimal entity list —
 * the identity cluster plus the three tables `doctor` has to read. Everything else `doctor` needs it
 * reads through the query runner as SQL, which needs no entity metadata at all and consequently
 * cannot be broken by a bad decorator.
 *
 * The connection parameters are read from the same environment as the server's (`DATABASE_TYPE`,
 * `DATABASE_PATH`, …), so "run it against the data directory" is literally the same configuration —
 * §7: "The CLI requires filesystem access to the data directory. That is the security boundary."
 *
 * ── Never runs migrations ────────────────────────────────────────────────────────────────────
 * `migrationsRun` and `synchronize` are both false and no migration list is registered. Recovery
 * must never mutate schema as a side effect of being run: MIGRATION §8 requires an upgrade to be
 * preceded by a verified backup, and a `doctor` invocation that silently migrated the database
 * would defeat that in the one situation where the operator is least able to notice.
 */

/** The audit `route` for everything the recovery CLI writes — the trail must say where it came from. */
export const RECOVERY_ROUTE = 'cli:flow-wiser'

/** Subject label for every recovery event. Break-glass is a SYSTEM actor, never a user session. */
export const RECOVERY_SUBJECT_LABEL = 'recovery-cli'

/**
 * Action catalog for the recovery CLI.
 *
 * `AuditEvent.ts` deliberately keeps `action` a plain varchar so a new action needs no migration,
 * and states that the catalog lives with the services. This is the recovery half of that catalog,
 * in the same `<domain>.<object>.<verb>` vocabulary the identity services already use.
 */
export const RecoveryAuditAction = {
    ADMIN_CREATE: 'identity.recovery.admin.create',
    ADMIN_RESET_PASSWORD: 'identity.recovery.admin.reset_password',
    ADMIN_LIST: 'identity.recovery.admin.list',
    ADMIN_UNLOCK: 'identity.recovery.admin.unlock',
    MFA_DISABLE: 'identity.recovery.mfa.disable',
    SSO_DISABLE: 'identity.recovery.sso.disable',
    SESSION_REVOKE_ALL: 'identity.recovery.session.revoke_all',
    DOCTOR: 'identity.recovery.doctor',
    /** Emitted when a command has to seed a missing system role / organization / workspace to do its job. */
    ROLE_SEED: 'identity.recovery.role.seed',
    ORGANIZATION_CREATE: 'identity.recovery.organization.create',
    WORKSPACE_CREATE: 'identity.recovery.workspace.create'
} as const

/**
 * WHO ran the command, as far as the host can tell.
 *
 * There is no authenticated principal — that is the entire point of break-glass — so the trail
 * records the operating-system identity instead. It is not an authentication claim and must never be
 * treated as one; it is the forensic breadcrumb that turns "something cleared the lockout at 03:14"
 * into "an ssh session as `ops` on `app-02` cleared the lockout at 03:14".
 */
export interface RecoveryActor {
    osUser: string
    hostname: string
    pid: number
}

export const describeActor = (): RecoveryActor => {
    let osUser = 'unknown'
    try {
        osUser = os.userInfo().username
    } catch {
        // userInfo() throws when the uid has no passwd entry — common inside containers. Not fatal.
    }
    return { osUser, hostname: os.hostname(), pid: process.pid }
}

// ── Password prompting ───────────────────────────────────────────────────────────────────────

/**
 * Raised when a password could not be obtained interactively. Never carries the candidate.
 */
export class PromptError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PromptError'
    }
}

export interface SecretPromptStreams {
    /** Defaults to `/dev/tty`. Injected by tests; there is deliberately no env or argv fallback. */
    input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
    output?: NodeJS.WritableStream
}

interface OpenedTty extends SecretPromptStreams {
    close: () => void
}

/**
 * Open the controlling terminal.
 *
 * `/dev/tty` and NOT `process.stdin`, because they are not the same thing: stdin can be a pipe, a
 * file or /dev/null, and reading a password from a pipe re-creates exactly the leak §7 forbids —
 * `echo hunter2 | flow-wiser admin:create` puts the secret in shell history just as surely as
 * `--password hunter2` does. Reading the terminal directly means the value can only have come from
 * a human typing it.
 *
 * Falls back to `process.stdin` only when it IS a terminal (Windows has no `/dev/tty`); if neither
 * is a terminal the caller gets a `PromptError` and the command aborts. Failing is correct: the
 * alternative is a break-glass tool that can be driven from a script, which is a credential-stuffing
 * primitive rather than a recovery tool.
 */
const openTty = (): OpenedTty => {
    try {
        const readFd = fs.openSync('/dev/tty', 'r')
        const writeFd = fs.openSync('/dev/tty', 'w')
        const input = new tty.ReadStream(readFd)
        const output = new tty.WriteStream(writeFd)
        return {
            input,
            output,
            close: () => {
                try {
                    input.destroy()
                    output.destroy()
                } catch {
                    // Closing a terminal we already finished with is not worth failing a recovery over.
                }
            }
        }
    } catch {
        if (process.stdin.isTTY) return { input: process.stdin, output: process.stderr, close: () => undefined }
        throw new PromptError(
            'No terminal is available to read a password from. Recovery passwords are typed, never passed as arguments, ' +
                'piped or read from the environment (REQUIREMENTS-MIGRATION.md §7). Run this command from an interactive shell ' +
                '(with `docker exec -it`, not `docker exec`).'
        )
    }
}

/**
 * Read one line with echo suppressed.
 *
 * Nothing typed is ever written back to the terminal — not the characters, not a per-character mask.
 * A mask leaks the length, which for a passphrase is a meaningful fraction of its entropy, and the
 * `sudo` convention (show nothing) is the one operators already expect.
 *
 * Raw mode is what actually disables the kernel's echo; the character loop below then has to do the
 * line editing the line discipline would otherwise have done — hence the explicit backspace, ^C and
 * ^D handling. Raw mode is restored in `finally`, so a thrown error cannot leave the operator with a
 * terminal that no longer echoes.
 */
export const readSecret = async (promptText: string, streams: SecretPromptStreams = {}): Promise<string> => {
    const opened: OpenedTty = streams.input ? { ...streams, close: () => undefined } : openTty()
    const input = opened.input as NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
    const output = opened.output
    const isRaw = typeof input.setRawMode === 'function' && input.isTTY === true

    if (output) output.write(promptText)
    if (isRaw) input.setRawMode!(true)

    try {
        return await new Promise<string>((resolve, reject) => {
            let value = ''
            let settled = false

            const finish = (error: Error | null, result?: string): void => {
                if (settled) return
                settled = true
                input.removeListener('data', onData)
                input.removeListener('end', onEnd)
                input.removeListener('error', onError)
                if (typeof (input as NodeJS.ReadStream).pause === 'function') (input as NodeJS.ReadStream).pause()
                if (output) output.write('\n')
                if (error) reject(error)
                else resolve(result as string)
            }

            const onData = (chunk: Buffer | string): void => {
                for (const character of chunk.toString('utf8')) {
                    switch (character) {
                        case '\r':
                        case '\n':
                            return finish(null, value)
                        // ^C — abort. A cancelled prompt must never be mistaken for an empty password.
                        case '\u0003':
                            return finish(new PromptError('Cancelled at the password prompt. Nothing was changed.'))
                        // ^D — end of input. Same treatment: not a password.
                        case '\u0004':
                            return finish(new PromptError('End of input at the password prompt. Nothing was changed.'))
                        case '\u007f':
                        case '\b':
                            value = value.slice(0, -1)
                            break
                        // Swallow the introducer of an escape sequence (arrow keys, function keys) rather
                        // than letting `[A` become three characters of "password".
                        case '\u001b':
                            break
                        default:
                            value += character
                    }
                }
            }

            const onEnd = (): void => finish(null, value)
            const onError = (error: Error): void => finish(error)

            input.on('data', onData)
            input.on('end', onEnd)
            input.on('error', onError)
            if (typeof (input as NodeJS.ReadStream).resume === 'function') (input as NodeJS.ReadStream).resume()
        })
    } finally {
        if (isRaw) input.setRawMode!(false)
        opened.close()
    }
}

/**
 * Prompt for a new password twice and return it only if both entries match AND the policy accepts it.
 *
 * The policy check is `identity/crypto/passwords.validatePassword` — the SAME function
 * `BootstrapService.readAccounts()` applies to `FLOWISE_BOOTSTRAP_PASSWORD`, which is what
 * MIGRATION §4 means by "the same check". There is deliberately no `--force` and no
 * `--allow-weak-password`: a break-glass escape hatch from the password policy is the first thing
 * anyone would reach for at 03:00, and it would be permanent.
 *
 * The confirmation entry is not politeness. Echo is off, so a typo is invisible, and the failure
 * mode of a mistyped RECOVERY password is being locked out of the tool that exists to fix lockouts.
 *
 * The violations are reported; the candidate never is (`passwords.ts`: the message names the
 * violations, never the candidate).
 */
export const promptNewPassword = async (
    label: string,
    streams: SecretPromptStreams = {}
): Promise<{ password: string; violations: PasswordViolation[] }> => {
    const password = await readSecret(`New password for ${label}: `, streams)
    const confirmation = await readSecret('Repeat password: ', streams)
    if (password !== confirmation) throw new PromptError('The two entries did not match. Nothing was changed.')

    return { password, violations: validatePassword(password) }
}

/** `hash()` already enforces the policy; this only turns its error into an operator-legible sentence. */
export const hashOrExplain = async (password: string): Promise<string> => {
    try {
        return await hash(password)
    } catch (error) {
        if (error instanceof PasswordPolicyError) throw new PromptError(describeViolations(error.violations))
        throw error
    }
}

const VIOLATION_TEXT: Record<PasswordViolation, string> = {
    [PasswordViolation.BLANK]: 'it is blank',
    [PasswordViolation.TOO_SHORT]: 'it is shorter than 8 characters',
    [PasswordViolation.TOO_LONG]: 'it is longer than 128 characters',
    [PasswordViolation.MISSING_LOWERCASE]: 'it has no lower-case letter',
    [PasswordViolation.MISSING_UPPERCASE]: 'it has no upper-case letter',
    [PasswordViolation.MISSING_DIGIT]: 'it has no digit',
    [PasswordViolation.MISSING_SPECIAL]: 'it has no special character',
    [PasswordViolation.PUBLISHED_EXAMPLE]: 'it is a value published in this project or in every quick-start guide',
    [PasswordViolation.EXCEEDS_BCRYPT_INPUT_LIMIT]: 'it is longer than the 72 bytes bcrypt can read, so the tail would be ignored'
}

export const describeViolations = (violations: readonly PasswordViolation[]): string =>
    `Password refused by policy: ${violations.map((violation) => VIOLATION_TEXT[violation] ?? violation).join('; ')}.`

// ── The recovery DataSource ──────────────────────────────────────────────────────────────────

/**
 * The explicit, minimal entity set. See the header for why this is not `entities` from
 * `database/entities/index.ts`.
 *
 * `LoginActivity` is excluded on purpose: it is a `@ViewEntity`, so registering it makes the
 * connection depend on the view having been created. A database whose identity migrations only
 * half-applied is precisely the case `doctor` has to survive, and it must not fail to CONNECT
 * because of the very defect it was run to report.
 */
const RECOVERY_ENTITIES = [
    User,
    Organization,
    OrganizationUser,
    Workspace,
    WorkspaceUser,
    Role,
    LoginMethod,
    Session,
    Token,
    MfaFactor,
    MfaRecoveryCode,
    AuditEvent,
    ChatFlow,
    Credential,
    Assistant
]

/** Same shape as `DataSource.getDatabaseSSLFromEnv`, re-derived rather than imported — see the header. */
const sslFromEnv = (env: NodeJS.ProcessEnv): boolean | { rejectUnauthorized: boolean; ca: Buffer } | undefined => {
    if (env.DATABASE_SSL_KEY_BASE64) {
        return { rejectUnauthorized: env.DATABASE_REJECT_UNAUTHORIZED === 'true', ca: Buffer.from(env.DATABASE_SSL_KEY_BASE64, 'base64') }
    }
    if (env.DATABASE_SSL === 'true') return true
    return undefined
}

/** Where a default SQLite deployment keeps its data directory — identical to `DataSource.init()`. */
export const defaultSqliteDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
    env.DATABASE_PATH ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.flowise')

/**
 * Build (but do not open) the recovery connection from the environment.
 *
 * Exported so `doctor` can report the target it is about to inspect before anything is opened —
 * "which database am I actually looking at" is the first question of every recovery session, and
 * getting it wrong is how an operator fixes the staging instance at 03:00.
 */
export const buildRecoveryDataSource = (env: NodeJS.ProcessEnv = process.env): { dataSource: DataSource; describe: string } => {
    const type = env.DATABASE_TYPE ?? 'sqlite'
    const common = { synchronize: false, migrationsRun: false, entities: RECOVERY_ENTITIES, migrations: [] as never[] }

    switch (type) {
        case 'mysql':
        case 'mariadb':
            return {
                dataSource: new DataSource({
                    type,
                    host: env.DATABASE_HOST,
                    port: Number.parseInt(env.DATABASE_PORT || '3306', 10),
                    username: env.DATABASE_USER,
                    password: env.DATABASE_PASSWORD,
                    database: env.DATABASE_NAME,
                    charset: 'utf8mb4',
                    ssl: sslFromEnv(env),
                    ...common
                }),
                describe: `${type} ${env.DATABASE_USER ?? ''}@${env.DATABASE_HOST ?? 'localhost'}:${env.DATABASE_PORT ?? 3306}/${
                    env.DATABASE_NAME ?? ''
                }`
            }
        case 'postgres':
            return {
                dataSource: new DataSource({
                    type: 'postgres',
                    host: env.DATABASE_HOST,
                    port: Number.parseInt(env.DATABASE_PORT || '5432', 10),
                    username: env.DATABASE_USER,
                    password: env.DATABASE_PASSWORD,
                    database: env.DATABASE_NAME,
                    ssl: sslFromEnv(env),
                    ...common
                }),
                describe: `postgres ${env.DATABASE_USER ?? ''}@${env.DATABASE_HOST ?? 'localhost'}:${env.DATABASE_PORT ?? 5432}/${
                    env.DATABASE_NAME ?? ''
                }`
            }
        default: {
            const file = path.resolve(defaultSqliteDirectory(env), 'database.sqlite')
            return { dataSource: new DataSource({ type: 'sqlite', database: file, ...common }), describe: `sqlite ${file}` }
        }
    }
}

// ── The command base class ───────────────────────────────────────────────────────────────────

/**
 * Base for every recovery command.
 *
 * Owns the three things all eight share and none should re-implement: opening the recovery
 * connection, exposing an `AuditService` bound to it, and guaranteeing the connection is closed and
 * a non-zero status is returned on failure. `runRecovery()` is what subclasses write.
 */
export abstract class RecoveryCommand extends BaseCommand {
    protected dataSource!: DataSource
    protected audit!: AuditService
    protected actor: RecoveryActor = describeActor()
    /** Set by a subclass when the command completed but reported problems — `doctor` uses it. */
    protected exitWithFailure = false

    protected abstract runRecovery(): Promise<void>

    async run(): Promise<void> {
        const built = buildRecoveryDataSource(process.env)
        this.dataSource = built.dataSource
        this.audit = new AuditService({ dataSource: this.dataSource })

        try {
            await this.dataSource.initialize()
        } catch (error) {
            this.log(`Could not open the database (${built.describe}).`)
            this.log(`  ${messageOf(error)}`)
            this.log('The recovery CLI needs filesystem access to the data directory (REQUIREMENTS-MIGRATION.md §7).')
            this.log('Check DATABASE_TYPE / DATABASE_PATH, or pass them as flags: --DATABASE_PATH=/root/.flowise')
            await this.failExit()
            return
        }

        try {
            await this.runRecovery()
        } catch (error) {
            // A recovery command that fails must say why in plain words. Operators run these under
            // pressure, and `[object Object]` at 03:00 is the difference between a fix and an outage.
            this.log('')
            this.log(`FAILED: ${messageOf(error)}`)
            this.exitWithFailure = true
        } finally {
            try {
                if (this.dataSource.isInitialized) await this.dataSource.destroy()
            } catch {
                // Nothing useful left to do; the work is already committed or already rolled back.
            }
        }

        if (this.exitWithFailure) await this.failExit()
        else await this.gracefullyExit()
    }

    /** Delegates to {@link recordRecoveryEvent} with this command's audit sink and actor. */
    protected async recordRecovery(input: RecoveryEventInput): Promise<void> {
        await recordRecoveryEvent(this.audit, this.actor, input)
    }
}

export interface RecoveryEventInput {
    action: string
    outcome: AuditOutcome
    targetType?: string | null
    targetId?: string | null
    organizationId?: string | null
    workspaceId?: string | null
    reason?: string | null
    message: string
    detail?: Record<string, unknown>
}

/**
 * Append one recovery event.
 *
 * A free function and not only a method, because the OPERATIONS (`createAdminAccount`,
 * `resetAdminPassword`, …) are the things that must not be able to run un-audited, and they are
 * deliberately callable without an oclif command wrapped around them — that is what makes them
 * testable, and a testable operation that skips the audit write in tests proves nothing about §7.
 *
 * §7: "Every recovery command writes an audit record. Break-glass that leaves no trace is
 * indistinguishable from an intrusion."
 */
export const recordRecoveryEvent = async (audit: AuditService, actor: RecoveryActor, input: RecoveryEventInput): Promise<void> => {
    await audit.record({
        action: input.action,
        outcome: input.outcome,
        subject: { type: AuditSubjectType.SYSTEM, label: RECOVERY_SUBJECT_LABEL },
        target: { type: input.targetType ?? null, id: input.targetId ?? null },
        scope: { organizationId: input.organizationId ?? null, workspaceId: input.workspaceId ?? null },
        route: RECOVERY_ROUTE,
        reason: input.reason ?? null,
        message: input.message,
        detail: { ...(input.detail ?? {}), actor }
    })
}

/**
 * An operator-legible failure. Distinct from a crash: it means the command refused, the reason is in
 * the message, and nothing was written except the FAILURE audit record.
 */
export class RecoveryError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RecoveryError'
    }
}

/** Everything a recovery operation needs that is not specific to the operation itself. */
export interface RecoveryContext {
    dataSource: DataSource
    audit: AuditService
    actor: RecoveryActor
}

/** Addresses are stored lower-cased and matched case-insensitively (`User.email`, `BootstrapService`). */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase()

// ── Lockout, as the login path computes it ───────────────────────────────────────────────────

/**
 * `AuthService` documents the policy: **5 consecutive failed password attempts within 15 minutes
 * locks the account for the remainder of that window**, and the counter is DERIVED FROM THE AUDIT
 * TRAIL rather than stored in a column ("the trail already records every failure with a reason, and
 * it is append-only, so the count cannot be edited away").
 *
 * That derivation is re-implemented here rather than imported because `AuthService.lockoutState` is
 * private, and this is a read of the same append-only table with the same two environment overrides.
 * The numbers are the ONLY thing that could drift, so they are read from the same variables — if
 * `IDENTITY_LOCKOUT_MAX_ATTEMPTS` is set for the server, the CLI honours it too.
 *
 * Consumed by `admin:list` (to show which accounts are locked) and `admin:unlock` (to know what it
 * is clearing, and to report it).
 */
export const LOCKOUT_DEFAULT_MAX_ATTEMPTS = 5
export const LOCKOUT_DEFAULT_WINDOW_MS = 15 * 60 * 1000

/**
 * The action the counter walks. Pinned in `AuditEvent.ts` because the login-activity projection
 * filters on it, which is exactly why it is safe to key the lockout off it here.
 */
export const AUTH_LOGIN_ACTION = AuditAction.AUTH_LOGIN

export interface LockoutState {
    locked: boolean
    /** Consecutive failures inside the window, newest-first, stopping at the first success. */
    failures: number
    unlocksAt: Date | null
    maxAttempts: number
    windowMs: number
}

const readPositiveInt = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const lockoutStateFor = async (dataSource: DataSource, userId: string, env: NodeJS.ProcessEnv = process.env): Promise<LockoutState> => {
    const maxAttempts = readPositiveInt(env.IDENTITY_LOCKOUT_MAX_ATTEMPTS, LOCKOUT_DEFAULT_MAX_ATTEMPTS)
    const windowMs = readPositiveInt(env.IDENTITY_LOCKOUT_WINDOW_MS, LOCKOUT_DEFAULT_WINDOW_MS)
    const windowStart = Date.now() - windowMs

    const events = await dataSource.getRepository(AuditEvent).find({
        where: { subjectId: userId, action: AUTH_LOGIN_ACTION },
        order: { seqNo: 'DESC' },
        take: maxAttempts + 1
    })

    let failures = 0
    let oldestCounted: Date | null = null
    for (const event of events) {
        if (event.outcome === AuditOutcome.SUCCESS) break
        const occurredAt = event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt)
        if (occurredAt.getTime() < windowStart) break
        failures += 1
        oldestCounted = occurredAt
    }

    const locked = failures >= maxAttempts
    return {
        locked,
        failures,
        unlocksAt: locked && oldestCounted ? new Date(oldestCounted.getTime() + windowMs) : null,
        maxAttempts,
        windowMs
    }
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
