import { DataSource } from 'typeorm'
import { AuditAction, AuditEvent, AuditOutcome, AuditSubjectType, AuthFailureReason } from '../../database/entities/identity/AuditEvent'
import { Organization } from '../../database/entities/identity/Organization'
import { MemberStatus, OrganizationUser } from '../../database/entities/identity/OrganizationUser'
import { Session, SessionAuthMethod, SessionRevokeReason } from '../../database/entities/identity/Session'
import { User } from '../../database/entities/identity/User'
import { WorkspaceUser } from '../../database/entities/identity/WorkspaceUser'
import logger from '../../utils/logger'
import { hash, needsRehash, PasswordViolation, UnsupportedHashError, validatePassword, verify, verifyDummy } from '../crypto/passwords'
import { isKnownPermission, withImpliedViewPermissions } from '../rbac/Permissions'
import { AuthenticatedUser, FeatureFlags } from '../rbac/types'
import { AuditService } from './AuditService'
import { IssuedSession, SessionInvalidReason, SessionService } from './SessionService'

/**
 * Identity — AuthService (SPEC-AUTH-RBAC.md §A.1, §E; REQUIREMENTS-AUTH-RBAC.md §2, §5, §10).
 *
 * The four verbs behind `/auth`: {@link AuthService.login}, {@link AuthService.logout},
 * {@link AuthService.refresh}, {@link AuthService.resolve} — plus {@link AuthService.authenticate},
 * which turns the pair of cookies a browser presents back into a principal.
 *
 * ── Two properties this file exists to hold ──────────────────────────────────────────────────
 *  1. **Fail closed** (REQUIREMENTS §2). Every path that cannot positively establish who the caller
 *     is returns a failure. There is no branch that falls through to success on an exception, and
 *     `login` catches everything: an unreadable session pepper, a dead connection or a malformed row
 *     must deny, never admit.
 *  2. **No account-existence oracle.** An unknown address, a wrong password and a locked account are
 *     indistinguishable to the caller — same status, same body, and comparable elapsed time, because
 *     every one of them burns a real bcrypt verification (`passwords.verifyDummy`, whose doc explains
 *     why this matters). The three cases ARE distinguished in the audit trail, which is where the
 *     operator can see them and the attacker cannot.
 */

/**
 * Canonical login-failure messages.
 *
 * These are the literals the shipped client compares against — `ErrorMessage` in
 * `packages/ui/src/store/constant.js:29-38` (spec §0.5). Declared here rather than imported from
 * `packages/server/src/utils/constants.ts` because that module is a server-side vocabulary and does
 * not carry them, and because the four strings are a wire contract that should be visible at the
 * place that emits them.
 */
export const LoginErrorMessage = {
    /** `constant.js:34`. Deliberately ambiguous — it is the ONLY message a failed credential ever produces. */
    UNKNOWN_USER: 'Unknown Username or Password',
    /** `constant.js:36` — the account exists and the password was right, but the membership is not active. */
    INACTIVE_USER: 'Inactive User',
    /** `constant.js:37` — authenticated, but with no workspace there is no scope to grant (spec §F-12). */
    NO_WORKSPACE: 'No Workspace Assigned',
    /** `constant.js:38` */
    UNKNOWN_ERROR: 'Unknown Error'
} as const

/**
 * `INCORRECT_PASSWORD: 'Incorrect Password'` (`constant.js:35`) is deliberately NEVER emitted by
 * this service. It is the exact string that turns the login endpoint into an account-existence
 * oracle: "Unknown Username or Password" for an address that does not exist and "Incorrect Password"
 * for one that does tells an attacker which is which for free. Spec §0.5 records that the client
 * knows the literal; nothing obliges the server to produce it, and this one does not.
 */

/** Why a login did not produce a session. Stable and safe to switch on; maps to HTTP in the route layer. */
export enum LoginFailure {
    /** Unknown address, wrong password, unverifiable stored hash, or a locked account — one indistinguishable outcome. */
    INVALID_CREDENTIALS = 'invalid_credentials',
    /** Credential was correct; every organization membership is suspended (audit code -3). */
    INACTIVE_USER = 'inactive_user',
    /** Credential was correct; no workspace assignment exists, so there is no permission scope (audit code -4). */
    NO_WORKSPACE = 'no_workspace',
    /** The account authenticates through an identity provider and the caller must be sent there (§F-7). */
    SSO_REQUIRED = 'sso_required',
    /** Something threw. Denied rather than passed through. */
    INTERNAL_ERROR = 'internal_error'
}

/** Request provenance, recorded on every audit event (§10 "where"). */
export interface AuthContext {
    ip?: string | null
    userAgent?: string | null
    /** Matched route PATTERN, never the raw URL. */
    route?: string | null
}

/**
 * The login payload, field-for-field as the shipped client consumes it.
 *
 * The field set is fixed by `AuthUtils.extractUser` + `AuthUtils.updateStateAndLocalStorage`
 * (`packages/ui/src/utils/authUtils.js:35-71`), which the reducer applies verbatim
 * (`authSlice.js:24-26`). Spec §A.1 enumerates it. Adding a field is safe (the client copies only
 * what it names); removing one is not.
 */
export interface LoginPayload {
    id: string
    email: string
    name: string | null
    /** `active` | `invited` | `inactive` — projected from OrganizationUser (spec §F-1 decision). */
    status: string
    /** §F-2 resolved: the NAME of the role held in the active workspace. Nothing renders it, but it is the only value consistent with §D.6. */
    role: string
    isSSO: boolean
    activeOrganizationId: string
    activeOrganizationSubscriptionId: string | null
    activeOrganizationCustomerId: string | null
    /** No `productId` column exists — Flow-Wiser gates nothing on billing (Organization.ts). Always null. */
    activeOrganizationProductId: string | null
    activeWorkspaceId: string
    /** The workspace NAME, not an id — it is rendered directly (spec §A.1, WorkspaceSwitcher:263). */
    activeWorkspace: string
    lastLogin: string
    /** Becomes the client's `isGlobal`, which bypasses all client-side permission checks (spec invariant 4). */
    isOrganizationAdmin: boolean
    assignedWorkspaces: { id: string; name: string }[]
    /** Flat array of `<category>:<action>` strings, scoped to the ACTIVE workspace (spec §E.6). */
    permissions: string[]
    features: FeatureFlags
    /**
     * §F-4 resolved: always null. The client stores it in Redux and never reads it back, no request
     * attaches it, and `authSlice` resets it to null on reload. Emitting a real token here would
     * create a second credential with no revocation path while implying a bearer scheme the UI does
     * not implement — the cookie is the session (§E.1). The key is present so the client's
     * `state.token = payload.token` assignment behaves identically to before.
     */
    token: null
    /**
     * MIGRATION §6 — extra, non-contractual field. `extractUser` copies only the names it lists, so
     * the shipped client ignores this; it exists so the session middleware and any new UI can see
     * that the account must change its password before it is allowed anywhere else.
     */
    mustChangePassword: boolean
}

export type LoginResult =
    | { ok: true; payload: LoginPayload; session: IssuedSession }
    | {
          ok: false
          failure: LoginFailure
          /** Rendered verbatim as the sign-in banner (`signIn.jsx:93`). */
          message: string
          /**
           * Present ONLY for {@link LoginFailure.SSO_REQUIRED}. The route layer turns it into the
           * double-nested §F-7 body; every other failure omits it, because `signIn.jsx:90` treats a
           * truthy `redirectUrl` as "navigate away" and would replace the error banner with a page load.
           */
          redirectUrl?: string
      }

export type RefreshResult = { ok: true; sessionId: string; issued: IssuedSession } | { ok: false; reason: SessionInvalidReason }

/**
 * Why a self-service password change was refused. Stable and safe to switch on; the route layer maps
 * each one onto its HTTP status, so a new failure cannot silently acquire the status of an old one.
 */
export enum PasswordChangeFailure {
    /** The body named an account other than the caller's. */
    WRONG_SUBJECT = 'wrong_subject',
    /** The current password did not verify — or the account has no local credential to verify against. */
    INVALID_CREDENTIALS = 'invalid_credentials',
    /** The account authenticates through an identity provider and has no local password to replace. */
    NO_LOCAL_CREDENTIAL = 'no_local_credential',
    /** The proposed password failed `crypto/passwords.validatePassword`. */
    WEAK_PASSWORD = 'weak_password',
    /** The proposed password IS the current one. A no-op change that reports success is a lie. */
    UNCHANGED = 'unchanged',
    /** Something threw. Refused rather than passed through. */
    INTERNAL_ERROR = 'internal_error'
}

export type PasswordChangeResult =
    | {
          ok: true
          userId: string
          email: string
          /** Sessions killed by the change, INCLUDING the caller's own — which is then reissued. */
          sessionsRevoked: number
          /** The caller's replacement session. The route sets it as cookies so the change does not log them out. */
          session: IssuedSession
      }
    | {
          ok: false
          failure: PasswordChangeFailure
          /** Rendered verbatim by `views/auth/resetPassword.jsx:134`. */
          message: string
          /** Present only for {@link PasswordChangeFailure.WEAK_PASSWORD}. */
          violations?: PasswordViolation[]
      }

/** One human-readable sentence per policy violation, in the vocabulary the client already renders. */
const PASSWORD_VIOLATION_TEXT: Record<PasswordViolation, string> = {
    [PasswordViolation.BLANK]: 'Password cannot be left blank',
    [PasswordViolation.TOO_SHORT]: 'Password must be at least 8 characters',
    [PasswordViolation.TOO_LONG]: 'Password must not be more than 128 characters',
    [PasswordViolation.MISSING_LOWERCASE]: 'Password must contain at least one lowercase letter',
    [PasswordViolation.MISSING_UPPERCASE]: 'Password must contain at least one uppercase letter',
    [PasswordViolation.MISSING_DIGIT]: 'Password must contain at least one digit',
    [PasswordViolation.MISSING_SPECIAL]: 'Password must contain at least one special character',
    [PasswordViolation.PUBLISHED_EXAMPLE]: 'Password is a value published in this project or in every quick-start guide',
    [PasswordViolation.EXCEEDS_BCRYPT_INPUT_LIMIT]: 'Password is longer than 72 bytes, so the tail would be ignored'
}

export const describePasswordViolations = (violations: readonly PasswordViolation[]): string =>
    violations.map((violation) => PASSWORD_VIOLATION_TEXT[violation] ?? String(violation)).join('; ')

/** What {@link AuthService.authenticate} hands the route layer. */
export interface AuthenticatedPrincipal {
    user: AuthenticatedUser
    session: Session
    mustChangePassword: boolean
}

/**
 * Feature flags (spec §B.4). All eleven, all on.
 *
 * They gate availability, not authority, and REQUIREMENTS-AUTH-RBAC.md lists
 * "feature-flag licensing/quotas" as an explicit v1 non-goal — "Flow-Wiser has nothing to gate".
 * They are still EMITTED because the client denies when `features` is absent, is an array, or is an
 * empty object (`RequireAuth.jsx:17`), so omitting the map would lock every gated screen.
 */
const FEATURE_FLAGS: FeatureFlags = {
    'feat:datasets': true,
    'feat:evaluations': true,
    'feat:evaluators': true,
    'feat:login-activity': true,
    'feat:logs': true,
    'feat:roles': true,
    'feat:sso-config': true,
    'feat:users': true,
    'feat:workspaces': true,
    'feat:account': true,
    'feat:files': true
}

/**
 * Lockout policy — REQUIREMENTS-MIGRATION.md §7 names `flowise admin:unlock` ("clear lockout /
 * failed attempts"), which presupposes one.
 *
 * DOCUMENTED WINDOW: **5 consecutive failed password attempts within 15 minutes locks the account
 * for the remainder of that 15-minute window**, measured from the oldest failure still inside it.
 * Consecutive means "since the last successful login" — one success clears the count.
 *
 * Both numbers are overridable so an operator can trade lockout against helpdesk load:
 *   IDENTITY_LOCKOUT_MAX_ATTEMPTS   default 5
 *   IDENTITY_LOCKOUT_WINDOW_MS      default 900000 (15 minutes)
 *
 * The counter is DERIVED FROM THE AUDIT TRAIL rather than kept in a column or in memory. Three
 * reasons: the trail already records every failure with a reason (§10, and it is append-only, so the
 * count cannot be edited away); a column would need a migration and a second write path that can
 * drift from the trail; and an in-process counter would reset on restart and would not be shared
 * between replicas, which is precisely when an attacker benefits.
 */
const DEFAULT_LOCKOUT_MAX_ATTEMPTS = 5
const DEFAULT_LOCKOUT_WINDOW_MS = 15 * 60 * 1000

/**
 * A blocked attempt is recorded under its OWN action, not as `auth.login`.
 *
 * Two consequences, both wanted. It keeps `identity_login_activity` (which filters on `auth.login`)
 * showing genuine credential failures rather than burying them under the noise of a lockout being
 * hammered. And it keeps the lockout counter from feeding itself: if blocked attempts counted as
 * failures, an attacker could hold an account locked indefinitely by continuing to knock.
 */
const AUTH_LOGIN_BLOCKED = 'auth.login.blocked'
const REASON_ACCOUNT_LOCKED = 'account_locked'

const readPositiveInt = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export interface AuthServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    sessionService?: SessionService
    auditService?: AuditService
    env?: NodeJS.ProcessEnv
}

export class AuthService {
    private readonly injectedDataSource?: DataSource
    private readonly sessions: SessionService
    private readonly audit: AuditService
    private readonly env: NodeJS.ProcessEnv

    constructor(options: AuthServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.sessions = options.sessionService ?? new SessionService({ dataSource: options.dataSource })
        this.audit = options.auditService ?? new AuditService({ dataSource: options.dataSource })
        this.env = options.env ?? process.env
    }

    /** Lazy `require` for the same reason SessionService uses one: a static import would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    private get lockoutMaxAttempts(): number {
        return readPositiveInt(this.env.IDENTITY_LOCKOUT_MAX_ATTEMPTS, DEFAULT_LOCKOUT_MAX_ATTEMPTS)
    }

    private get lockoutWindowMs(): number {
        return readPositiveInt(this.env.IDENTITY_LOCKOUT_WINDOW_MS, DEFAULT_LOCKOUT_WINDOW_MS)
    }

    /** The one body every credential failure produces. A single constructor, so the three cases cannot drift apart. */
    private invalidCredentials(): LoginResult {
        return { ok: false, failure: LoginFailure.INVALID_CREDENTIALS, message: LoginErrorMessage.UNKNOWN_USER }
    }

    /**
     * `POST /auth/login` (spec §A.1).
     *
     * Order is load-bearing:
     *   1. normalise the address, then look the account up;
     *   2. NO ACCOUNT → burn a real bcrypt verification and return the generic failure;
     *   3. locked → burn a real bcrypt verification and return the SAME generic failure;
     *   4. verify; wrong → the same generic failure again;
     *   5. only now resolve membership, workspace, role and permissions;
     *   6. issue the session and record the success.
     *
     * Steps 2–4 all cost one bcrypt at the current cost and one audit write, which is what makes the
     * three indistinguishable in elapsed time as well as in body. Steps 5–6 run only after the
     * credential is proven, so their cost cannot leak anything.
     */
    async login(email: unknown, password: unknown, context: AuthContext = {}): Promise<LoginResult> {
        const normalisedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
        const auditBase = { route: context.route ?? null, ipAddress: context.ip ?? null, userAgent: context.userAgent ?? null }

        try {
            if (!normalisedEmail || typeof password !== 'string' || password.length === 0) {
                // A malformed request is still a login attempt: burn the time and record it, so
                // probing with an empty body is neither faster nor quieter than a real guess.
                await verifyDummy()
                await this.audit.loginFailure({ email: normalisedEmail, reason: AuthFailureReason.UNKNOWN_USER, ...auditBase })
                return this.invalidCredentials()
            }

            const user = await this.getDataSource()
                .getRepository(User)
                .findOne({
                    where: { email: normalisedEmail },
                    // `credential` is `select: false` on the entity, so it has to be asked for by name.
                    select: { id: true, email: true, name: true, credential: true, isSSO: true, mustChangePassword: true }
                })

            if (!user) {
                await verifyDummy()
                await this.audit.loginFailure({ email: normalisedEmail, reason: AuthFailureReason.UNKNOWN_USER, ...auditBase })
                return this.invalidCredentials()
            }

            const lock = await this.lockoutState(user.id)
            if (lock.locked) {
                await verifyDummy()
                await this.audit.record({
                    action: AUTH_LOGIN_BLOCKED,
                    outcome: AuditOutcome.FAILURE,
                    subject: { type: AuditSubjectType.USER, id: user.id, label: normalisedEmail },
                    target: { type: 'login_method', id: 'local' },
                    reason: REASON_ACCOUNT_LOCKED,
                    detail: { failures: lock.failures, unlocksAt: lock.unlocksAt?.toISOString() ?? null },
                    message: `Login blocked for ${normalisedEmail}: ${lock.failures} consecutive failures`,
                    ...auditBase
                })
                return this.invalidCredentials()
            }

            let passwordOk = false
            try {
                passwordOk = await verify(password, user.credential ?? null)
            } catch (error) {
                if (error instanceof UnsupportedHashError) {
                    // MIGRATION §5: a hash this build cannot verify is an OPERATOR problem, not a
                    // wrong password. Loud in the log, generic on the wire — telling the caller that
                    // this specific account has an unverifiable hash would confirm it exists.
                    logger.error(`❌ [AuthService] ${normalisedEmail} has a stored hash this build cannot verify: ${error.message}`)
                    await this.audit.loginFailure({
                        email: normalisedEmail,
                        userId: user.id,
                        reason: AuthFailureReason.INCORRECT_CREDENTIAL,
                        detail: { unsupportedHash: true },
                        ...auditBase
                    })
                    return this.invalidCredentials()
                }
                throw error
            }

            if (!passwordOk) {
                await this.audit.loginFailure({
                    email: normalisedEmail,
                    userId: user.id,
                    reason: AuthFailureReason.INCORRECT_CREDENTIAL,
                    // `credential === null` is an SSO-only or invited-not-registered account; it is a
                    // wrong password on the wire either way, but the operator can see the difference.
                    detail: user.credential ? undefined : { noLocalCredential: true },
                    ...auditBase
                })

                // §F-7 — the ONLY case that emits the double-nested redirect. Default OFF, because
                // "this address exists and signs in via SSO" is an existence oracle; a deployment
                // that has decided SSO usability is worth that trade sets the variable.
                if (!user.credential && user.isSSO && this.env.IDENTITY_SSO_LOGIN_REDIRECT === 'true') {
                    return {
                        ok: false,
                        failure: LoginFailure.SSO_REQUIRED,
                        message: LoginErrorMessage.UNKNOWN_USER,
                        redirectUrl: this.signInResolverUrl()
                    }
                }
                return this.invalidCredentials()
            }

            // ── Credential proven from here on ────────────────────────────────────────────────
            const scope = await this.resolveScope(user.id)
            if (scope.failure) {
                await this.audit.loginFailure({
                    email: normalisedEmail,
                    userId: user.id,
                    reason:
                        scope.failure === LoginFailure.INACTIVE_USER
                            ? AuthFailureReason.USER_DISABLED
                            : AuthFailureReason.NO_ASSIGNED_WORKSPACE,
                    ...auditBase
                })
                return {
                    ok: false,
                    failure: scope.failure,
                    message: scope.failure === LoginFailure.INACTIVE_USER ? LoginErrorMessage.INACTIVE_USER : LoginErrorMessage.NO_WORKSPACE
                }
            }

            const session = await this.sessions.issue({
                userId: user.id,
                activeWorkspaceId: scope.activeWorkspaceId,
                authMethod: SessionAuthMethod.LOCAL,
                userAgent: context.userAgent ?? null,
                ip: context.ip ?? null
            })

            const loginAt = new Date()
            await this.getDataSource()
                .getRepository(OrganizationUser)
                .update({ organizationId: scope.organizationId, userId: user.id }, { lastLogin: loginAt })

            await this.upgradeStoredHash(user, password)

            await this.audit.loginSuccess({
                userId: user.id,
                email: normalisedEmail,
                sessionId: session.sessionId,
                loginMethod: 'local',
                scope: { organizationId: scope.organizationId, workspaceId: scope.activeWorkspaceId },
                detail: { mustChangePassword: user.mustChangePassword === true },
                ...auditBase
            })

            return {
                ok: true,
                session,
                payload: {
                    id: user.id,
                    email: user.email,
                    name: user.name ?? null,
                    status: scope.status,
                    role: scope.roleName,
                    isSSO: user.isSSO === true,
                    activeOrganizationId: scope.organizationId,
                    activeOrganizationSubscriptionId: scope.subscriptionId,
                    activeOrganizationCustomerId: scope.customerId,
                    activeOrganizationProductId: null,
                    activeWorkspaceId: scope.activeWorkspaceId,
                    activeWorkspace: scope.activeWorkspaceName,
                    lastLogin: loginAt.toISOString(),
                    isOrganizationAdmin: scope.isOrganizationAdmin,
                    assignedWorkspaces: scope.assignedWorkspaces,
                    permissions: scope.permissions,
                    features: FEATURE_FLAGS,
                    token: null,
                    mustChangePassword: user.mustChangePassword === true
                }
            }
        } catch (error) {
            // Fail closed (REQUIREMENTS §2). Nothing below this line can turn into a session.
            logger.error(`❌ [AuthService] login failed closed for ${normalisedEmail || '<blank>'}: ${message(error)}`)
            try {
                await this.audit.loginFailure({
                    email: normalisedEmail,
                    reason: AuthFailureReason.INCORRECT_CREDENTIAL,
                    detail: { internalError: true },
                    ...auditBase
                })
            } catch {
                // Auditing must never turn a denial into a crash.
            }
            return { ok: false, failure: LoginFailure.INTERNAL_ERROR, message: LoginErrorMessage.UNKNOWN_ERROR }
        }
    }

    /**
     * Consecutive failed `auth.login` events for one account, newest first, stopping at the first
     * success or at the edge of the window.
     *
     * FAILS CLOSED: if the trail cannot be read we cannot prove the account is NOT locked, so it is
     * treated as locked. That is not a denial-of-service risk in practice — the same database has to
     * be readable for the login to resolve a workspace at all — and the alternative is that an
     * attacker who can break the audit sink also switches the lockout off.
     */
    private async lockoutState(userId: string): Promise<{ locked: boolean; failures: number; unlocksAt: Date | null }> {
        const maxAttempts = this.lockoutMaxAttempts
        const windowMs = this.lockoutWindowMs
        const windowStart = new Date(Date.now() - windowMs)

        try {
            const events = await this.getDataSource()
                .getRepository(AuditEvent)
                .find({
                    where: { subjectId: userId, action: AuditAction.AUTH_LOGIN },
                    order: { seqNo: 'DESC' },
                    // One more than could possibly matter, so the walk below always sees either a
                    // success or the window edge without a second query.
                    take: maxAttempts + 1
                })

            let failures = 0
            let oldestCounted: Date | null = null
            for (const event of events) {
                if (event.outcome === AuditOutcome.SUCCESS) break
                const occurredAt = event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt)
                if (occurredAt.getTime() < windowStart.getTime()) break
                failures += 1
                oldestCounted = occurredAt
            }

            const locked = failures >= maxAttempts
            return { locked, failures, unlocksAt: locked && oldestCounted ? new Date(oldestCounted.getTime() + windowMs) : null }
        } catch (error) {
            logger.error(`❌ [AuthService] lockout check failed closed for user ${userId}: ${message(error)}`)
            return { locked: true, failures: maxAttempts, unlocksAt: null }
        }
    }

    /**
     * Re-hash a proven-correct password when the stored hash is below the current cost, or was made
     * by an algorithm we no longer prefer (`passwords.needsRehash`). This is the one moment the
     * plaintext is in hand, so the migration costs the user nothing.
     *
     * `credentialUpdatedDate` is deliberately NOT touched. SessionService treats a session issued
     * before that instant as invalid — bumping it here would revoke the session this very login just
     * created, and every other session the user has, on a change they did not make.
     */
    private async upgradeStoredHash(user: User, plaintext: string): Promise<void> {
        try {
            if (!user.credential || !needsRehash(user.credential)) return
            const rehashed = await hash(plaintext)
            await this.getDataSource().getRepository(User).update({ id: user.id }, { credential: rehashed })
            logger.info(`[AuthService] re-hashed the stored credential for user ${user.id} at the current cost`)
        } catch (error) {
            // A failed opportunistic upgrade must never fail the login it rode in on.
            logger.warn(`[AuthService] credential re-hash skipped for user ${user.id}: ${message(error)}`)
        }
    }

    /**
     * Resolve the tenancy scope a proven credential is entitled to: organization, workspace, role
     * and the effective permission set.
     *
     * Permissions come from the role held in the ACTIVE workspace and nowhere else (spec §D.6, §E.6)
     * — which is why `POST /workspace/switch` has to re-issue the whole payload.
     */
    private async resolveScope(userId: string): Promise<
        | { failure: LoginFailure }
        | {
              failure?: undefined
              organizationId: string
              subscriptionId: string | null
              customerId: string | null
              status: string
              isOrganizationAdmin: boolean
              activeWorkspaceId: string
              activeWorkspaceName: string
              roleName: string
              permissions: string[]
              assignedWorkspaces: { id: string; name: string }[]
          }
    > {
        const dataSource = this.getDataSource()
        const memberships = await dataSource.getRepository(OrganizationUser).find({ where: { userId }, order: { createdDate: 'ASC' } })
        if (memberships.length === 0) return { failure: LoginFailure.NO_WORKSPACE }

        const membership = memberships.find((row) => row.status === MemberStatus.ACTIVE)
        // Every membership suspended (or still only invited) is 'Inactive User' — audit code -3.
        if (!membership) return { failure: LoginFailure.INACTIVE_USER }

        const organization = await dataSource.getRepository(Organization).findOne({ where: { id: membership.organizationId } })
        if (!organization) return { failure: LoginFailure.NO_WORKSPACE }

        const assignments = await dataSource
            .getRepository(WorkspaceUser)
            .find({ where: { userId }, relations: { workspace: true, role: true }, order: { createdDate: 'ASC' } })

        // Tenancy is derived server-side, never from the request (REQUIREMENTS §4): only workspaces
        // inside the organization the membership names are eligible.
        const inOrganization = assignments.filter((row) => row.workspace && row.workspace.organizationId === organization.id)
        if (inOrganization.length === 0) return { failure: LoginFailure.NO_WORKSPACE }

        // The org default is the landing workspace when the user is in it; otherwise the oldest
        // assignment, so the choice is stable across logins rather than engine-order dependent.
        const active = inOrganization.find((row) => row.workspace.isOrgDefault) ?? inOrganization[0]
        if (!active.role) return { failure: LoginFailure.NO_WORKSPACE }

        return {
            organizationId: organization.id,
            subscriptionId: organization.subscriptionId ?? null,
            customerId: organization.customerId ?? null,
            status: membership.status,
            isOrganizationAdmin: membership.isOrgOwner === true,
            activeWorkspaceId: active.workspaceId,
            activeWorkspaceName: active.workspace.name,
            roleName: active.role.name,
            permissions: parseRolePermissions(active.role.permissions),
            assignedWorkspaces: inOrganization.map((row) => ({ id: row.workspace.id, name: row.workspace.name }))
        }
    }

    /**
     * Turn the cookie pair back into a principal, for the endpoints that require a session
     * (`GET /auth/permissions/:type`, logout).
     *
     * Re-resolves permissions from the database rather than trusting anything the client holds —
     * spec §E.6 warns that the client's copy is a cached snapshot that a role edit does not reach.
     * Returns null on every invalid outcome; the caller cannot tell WHY, which is correct for an
     * endpoint that only needs to know whether to proceed.
     */
    async authenticate(sessionId: string | undefined, refreshSecret: string | undefined): Promise<AuthenticatedPrincipal | null> {
        try {
            if (!sessionId || !refreshSecret) return null
            const validation = await this.sessions.validate(sessionId, refreshSecret)
            if (!validation.valid) return null

            const dataSource = this.getDataSource()
            const user = await dataSource.getRepository(User).findOne({ where: { id: validation.session.userId } })
            if (!user) return null

            const scope = await this.resolveScope(user.id)
            if (scope.failure) return null

            return {
                session: validation.session,
                mustChangePassword: user.mustChangePassword === true,
                user: {
                    id: user.id,
                    permissions: scope.permissions,
                    features: FEATURE_FLAGS,
                    isOrganizationAdmin: scope.isOrganizationAdmin,
                    activeWorkspaceId: scope.activeWorkspaceId,
                    activeWorkspace: scope.activeWorkspaceName,
                    activeOrganizationId: scope.organizationId,
                    activeOrganizationSubscriptionId: scope.subscriptionId ?? undefined,
                    activeOrganizationCustomerId: scope.customerId ?? undefined
                }
            }
        } catch (error) {
            logger.error(`❌ [AuthService] authenticate failed closed: ${message(error)}`)
            return null
        }
    }

    /**
     * `POST /auth/logout` (and `POST /account/logout`, spec §E.5).
     *
     * Always reports success. The endpoint is whitelisted precisely so it works with an already-dead
     * session (spec §E.5), and a logout that 401s would leave the client's cookies in place — the
     * opposite of what was asked for. `redirectTo` is required by the shipped client
     * (`WorkspaceSwitcher/index.jsx:212`) and is a fixed, server-chosen local path: §F-5 notes it is
     * fed straight into `window.location.href`, so it is never taken from the request.
     */
    async logout(sessionId: string | undefined, context: AuthContext = {}): Promise<{ message: string; redirectTo: string }> {
        try {
            if (sessionId) {
                const session = await this.getDataSource()
                    .getRepository(Session)
                    .findOne({ where: { id: sessionId } })
                const revoked = await this.sessions.revoke(sessionId, SessionRevokeReason.LOGOUT)
                if (revoked && session) {
                    await this.audit.logout({
                        userId: session.userId,
                        sessionId,
                        scope: { workspaceId: session.activeWorkspaceId ?? null },
                        route: context.route ?? null,
                        ipAddress: context.ip ?? null,
                        userAgent: context.userAgent ?? null
                    })
                }
            }
        } catch (error) {
            // Never fail a logout: the caller is entitled to have its cookies cleared regardless.
            logger.warn(`[AuthService] logout bookkeeping failed for session ${sessionId ?? 'none'}: ${message(error)}`)
        }

        // `'logged_out'` is compared for equality by the client (spec §0.5); anything else is a no-op
        // and the user stays logged in.
        return { message: 'logged_out', redirectTo: this.signInUrl() }
    }

    /**
     * `POST /account/reset-password`, session-authenticated branch — the exit from MIGRATION §6.
     *
     * ── Why this method has to exist ─────────────────────────────────────────────────────────────
     * `admin:create` and `admin:reset-password` both set `mustChangePassword = true`, and until this
     * method landed NOTHING anywhere set it back to false. A fresh install therefore signed in
     * successfully and was then answered 403 `must_change_password` by `middleware/session.ts` on
     * every other route, permanently. The middleware allowlist already named this path; this is the
     * handler behind it.
     *
     * ── The current password is required, and is the whole security model ────────────────────────
     * The session cookie alone is NOT sufficient authority to replace a credential: a stolen cookie
     * would otherwise become permanent account ownership in one request. Proving the current password
     * is what makes the change an act of the account holder rather than of whoever holds the cookie.
     * That is also why the FORGOTTEN-password flow is a different endpoint with a different proof (a
     * mailed token) and answers 501 here — see `routes/account.ts`.
     *
     * ── Order is load-bearing ────────────────────────────────────────────────────────────────────
     *   1. the body may not name a different account   → WRONG_SUBJECT
     *   2. the account must have a local credential    → NO_LOCAL_CREDENTIAL
     *   3. the CURRENT password must verify            → INVALID_CREDENTIALS
     *   4. only then is the proposed password examined → WEAK_PASSWORD / UNCHANGED
     * Steps 4 onwards run only after the caller has proven the current credential, so nothing about
     * the policy or about the stored hash can be probed with a stolen cookie alone.
     *
     * ── Every session dies, and the caller's is reissued ─────────────────────────────────────────
     * `credentialUpdatedDate` alone would invalidate them lazily (spec §D.12); the rows are revoked
     * explicitly as well so `identity_session` carries `credential_changed` as the reason, exactly as
     * `admin:reset-password` does. The caller then gets a NEW session rather than being logged out:
     * their old one was issued before `credentialUpdatedDate` and has just stopped validating, and a
     * forced change that ends in a logout screen is indistinguishable from a failure.
     */
    async changeOwnPassword(
        principal: { userId: string; activeWorkspaceId?: string | null },
        input: { email?: unknown; currentPassword?: unknown; newPassword?: unknown },
        context: AuthContext = {}
    ): Promise<PasswordChangeResult> {
        const auditBase = { route: context.route ?? null, ipAddress: context.ip ?? null, userAgent: context.userAgent ?? null }

        /** Refusals are audited too — a failed attempt to replace a credential is worth at least as much as a successful one (§10). */
        const refuse = async (
            failure: PasswordChangeFailure,
            message: string,
            email: string | null,
            detail?: Record<string, unknown>,
            violations?: PasswordViolation[]
        ): Promise<PasswordChangeResult> => {
            try {
                await this.audit.record({
                    action: AuditAction.AUTH_PASSWORD_CHANGE,
                    outcome: AuditOutcome.FAILURE,
                    subject: { type: AuditSubjectType.USER, id: principal.userId, label: email },
                    target: { type: 'user', id: principal.userId },
                    reason: failure,
                    message,
                    detail,
                    ...auditBase
                })
            } catch {
                // Auditing must never turn a refusal into a crash.
            }
            return violations ? { ok: false, failure, message, violations } : { ok: false, failure, message }
        }

        try {
            const user = await this.getDataSource()
                .getRepository(User)
                .findOne({
                    where: { id: principal.userId },
                    // `credential` is `select: false` on the entity, so it has to be asked for by name.
                    select: { id: true, email: true, credential: true, isSSO: true, mustChangePassword: true }
                })
            if (!user) {
                return await refuse(
                    PasswordChangeFailure.INTERNAL_ERROR,
                    LoginErrorMessage.UNKNOWN_ERROR,
                    null,
                    { sessionWithoutUser: true }
                )
            }

            // The body carries an `email` because the shipped client sends one (`resetPassword.jsx`).
            // It is never used to SELECT the account — the session decides that — and a mismatch is a
            // refusal rather than a silent ignore, so an attempt to change somebody else's password
            // is visible in the trail instead of quietly succeeding against the wrong row.
            if (typeof input.email === 'string' && input.email.trim().length > 0) {
                if (input.email.trim().toLowerCase() !== user.email.toLowerCase()) {
                    return await refuse(
                        PasswordChangeFailure.WRONG_SUBJECT,
                        'A password can only be changed by its own account holder.',
                        user.email,
                        { attemptedAnotherAccount: true }
                    )
                }
            }

            if (!user.credential) {
                // Nothing to prove and nothing to replace. `flowise admin:clear-password-change` is
                // the exit for this account; see `commands/admin/clear-password-change.ts`.
                return await refuse(
                    PasswordChangeFailure.NO_LOCAL_CREDENTIAL,
                    'This account signs in through an identity provider and has no local password to change.',
                    user.email,
                    { hasLocalLogin: false, isSSO: user.isSSO === true }
                )
            }

            const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : ''
            let currentOk = false
            try {
                currentOk = currentPassword.length > 0 && (await verify(currentPassword, user.credential))
            } catch (error) {
                if (error instanceof UnsupportedHashError) {
                    // MIGRATION §5 — an operator problem, not a wrong password. The CLI is the exit.
                    logger.error(`❌ [AuthService] ${user.email} has a stored hash this build cannot verify: ${error.message}`)
                    return await refuse(
                        PasswordChangeFailure.INVALID_CREDENTIALS,
                        LoginErrorMessage.UNKNOWN_USER,
                        user.email,
                        { unsupportedHash: true }
                    )
                }
                throw error
            }
            if (!currentOk) {
                return await refuse(PasswordChangeFailure.INVALID_CREDENTIALS, LoginErrorMessage.UNKNOWN_USER, user.email)
            }

            // ── Current credential proven from here on ────────────────────────────────────────
            const newPassword = typeof input.newPassword === 'string' ? input.newPassword : ''
            const violations = validatePassword(newPassword)
            if (violations.length > 0) {
                return await refuse(
                    PasswordChangeFailure.WEAK_PASSWORD,
                    describePasswordViolations(violations),
                    user.email,
                    // The violations, never the candidate (§9, §10).
                    { violations },
                    violations
                )
            }

            // Compared against the STORED HASH rather than against the plaintext just supplied, so
            // the check still holds when a caller omits `currentPassword`'s exact spelling but lands
            // on the same value some other way. A change that changes nothing must not clear the
            // §6 flag: that would turn "you must pick a new password" into "you must press submit".
            if (await verify(newPassword, user.credential)) {
                return await refuse(
                    PasswordChangeFailure.UNCHANGED,
                    'The new password must be different from the current one.',
                    user.email,
                    // NOT `reusedCurrentCredential`, and not any spelling containing `password`
                    // either: `crypto/redaction.ts` drops a key whose NAME contains `credential`
                    // just as readily. Verified against a live trail — the first spelling of this
                    // key arrived as the literal string "[redacted]".
                    { submittedValueUnchanged: true }
                )
            }

            const credential = await hash(newPassword)
            const changedAt = new Date()
            await this.getDataSource().getRepository(User).update(
                { id: user.id },
                {
                    credential,
                    // Sessions issued before this instant stop validating (User.credentialUpdatedDate).
                    credentialUpdatedDate: changedAt,
                    // THE POINT OF THE WHOLE ENDPOINT.
                    mustChangePassword: false
                }
            )

            const sessionsRevoked = await this.sessions.revokeAllForUser(user.id, SessionRevokeReason.CREDENTIAL_CHANGED)
            const session = await this.sessions.issue({
                userId: user.id,
                activeWorkspaceId: principal.activeWorkspaceId ?? null,
                authMethod: SessionAuthMethod.LOCAL,
                userAgent: context.userAgent ?? null,
                ip: context.ip ?? null
            })

            await this.audit.record({
                action: AuditAction.AUTH_PASSWORD_CHANGE,
                outcome: AuditOutcome.SUCCESS,
                subject: { type: AuditSubjectType.USER, id: user.id, label: user.email, sessionId: session.sessionId },
                target: { type: 'user', id: user.id },
                message: `${user.email} changed their own password; ${sessionsRevoked} session(s) revoked`,
                // NEITHER hash is recorded (§9). `forcedChangeCleared` rather than the obvious
                // `mustChangePassword`: `crypto/redaction.ts` drops any key whose NAME contains
                // `password`, so the obvious spelling would store the string "[redacted]" in place of
                // the fact. Same trap `admin/create.ts` documents.
                detail: { forcedChangeCleared: user.mustChangePassword === true, sessionsRevoked },
                ...auditBase
            })

            return { ok: true, userId: user.id, email: user.email, sessionsRevoked, session }
        } catch (error) {
            // Fail closed (REQUIREMENTS §2). Nothing below this line can turn into a changed credential.
            logger.error(`❌ [AuthService] password change failed closed for user ${principal.userId}: ${message(error)}`)
            return { ok: false, failure: PasswordChangeFailure.INTERNAL_ERROR, message: LoginErrorMessage.UNKNOWN_ERROR }
        }
    }

    /**
     * `POST /auth/refreshToken` (spec §E.4).
     *
     * Rotates the refresh secret in place, keeping the session id, because the client's only test of
     * success is a truthy `id` in the body and it then replays the original request exactly once.
     */
    async refresh(sessionId: string | undefined, refreshSecret: string | undefined, context: AuthContext = {}): Promise<RefreshResult> {
        try {
            if (!sessionId || !refreshSecret) return { ok: false, reason: SessionInvalidReason.NOT_FOUND }
            const rotated = await this.sessions.refresh(sessionId, refreshSecret)
            if (!rotated.ok) return { ok: false, reason: rotated.reason }

            const session = await this.getDataSource()
                .getRepository(Session)
                .findOne({ where: { id: sessionId } })
            await this.audit.record({
                action: AuditAction.AUTH_SESSION_REFRESH,
                outcome: AuditOutcome.SUCCESS,
                subject: { type: AuditSubjectType.USER, id: session?.userId ?? null, sessionId },
                target: { type: 'session', id: sessionId },
                scope: { workspaceId: session?.activeWorkspaceId ?? null },
                route: context.route ?? null,
                ipAddress: context.ip ?? null,
                userAgent: context.userAgent ?? null
            })
            return { ok: true, sessionId, issued: rotated.issued }
        } catch (error) {
            logger.error(`❌ [AuthService] refresh failed closed for session ${sessionId ?? 'none'}: ${message(error)}`)
            return { ok: false, reason: SessionInvalidReason.INTERNAL_ERROR }
        }
    }

    /**
     * `POST /auth/resolve` (spec §A.1).
     *
     * The `/login` route is a pure resolver page: it renders a backdrop and bounces the browser to
     * whichever concrete sign-in surface applies. An instance with no organization has never been
     * bootstrapped, so the surface is first-run setup; otherwise it is the password/SSO form.
     *
     * Any failure resolves to the sign-in form rather than throwing: the client has no error UI here
     * (`login.jsx:22-23`), so an exception would strand the user on a blank backdrop.
     */
    async resolve(): Promise<{ redirectUrl: string }> {
        try {
            const organizations = await this.getDataSource().getRepository(Organization).count()
            if (organizations === 0) return { redirectUrl: this.env.IDENTITY_SETUP_URL || '/organization-setup' }
            const users = await this.getDataSource().getRepository(User).count()
            if (users === 0) return { redirectUrl: this.env.IDENTITY_SETUP_URL || '/organization-setup' }
        } catch (error) {
            logger.warn(`[AuthService] resolve fell back to the sign-in form: ${message(error)}`)
        }
        return { redirectUrl: this.signInUrl() }
    }

    /** `/signin` — the concrete password form (`packages/ui/src/routes/AuthRoutes.jsx:27`). */
    private signInUrl(): string {
        return this.env.IDENTITY_SIGNIN_URL || '/signin'
    }

    /** `/login` — the resolver page, which re-runs `POST /auth/resolve` and bounces onward (AuthRoutes.jsx:23). */
    private signInResolverUrl(): string {
        return this.env.IDENTITY_LOGIN_RESOLVER_URL || '/login'
    }
}

/**
 * Deny-by-default applied to stored grants (REQUIREMENTS §4): a role row is operator-editable text,
 * so anything in it that is not a registered permission grants nothing, and a malformed value grants
 * nothing at all rather than throwing at login time. §B.6 rule 1 is then mirrored so the effective
 * set always contains the view token its writes imply.
 */
const parseRolePermissions = (raw: unknown): string[] => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return withImpliedViewPermissions(parsed.filter((entry): entry is string => typeof entry === 'string' && isKnownPermission(entry)))
    } catch {
        return []
    }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
