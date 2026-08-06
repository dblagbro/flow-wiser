import { DataSource, ObjectLiteral, Repository } from 'typeorm'
import { AuditAction, AuditOutcome, AuditSubjectType } from '../../database/entities/identity/AuditEvent'
import { MfaFactor, MfaFactorStatus } from '../../database/entities/identity/MfaFactor'
import { MfaPolicy, Organization } from '../../database/entities/identity/Organization'
import { Role } from '../../database/entities/identity/Role'
import { Session } from '../../database/entities/identity/Session'
import { User } from '../../database/entities/identity/User'
import { Workspace } from '../../database/entities/identity/Workspace'
import { WorkspaceUser } from '../../database/entities/identity/WorkspaceUser'
import logger from '../../utils/logger'
import { AuditService } from './AuditService'

/**
 * Identity — MfaPolicyService (requirements §8 "MFA — genuinely net-new", MIGRATION §4).
 *
 * This module is the BOTTOM of the MFA dependency graph. `TotpService` and `RecoveryCodeService`
 * import the shared vocabulary from here; nothing here imports either of them. That direction is
 * deliberate — the policy question ("must this user present a second factor?") is answered without
 * knowing which KINDS of factor exist, which is what makes §8's "WebAuthn/passkeys designed for
 * behind the same factor interface" a new row value rather than a new branch in this file.
 *
 * ── The two axes, and why neither alone is enough ────────────────────────────────────────────
 * §8 lists four enforcement modes — off / optional / required-per-role / required-org-wide — and
 * `Organization.ts` records the schema decision that they are not four values of one setting but
 * two independent columns:
 *
 *     effective requirement = (Organization.mfaPolicy === 'required')
 *                          OR (any Role held by the user in the org has requiresMfa)
 *
 * OR-ed, never overridden: a role can TIGHTEN the policy, never relax it. The entity comments give
 * the failure mode each axis exists to prevent, and both are real:
 *
 *   - A role-only model FAILS OPEN. "Required for everyone" would have to be re-applied to every
 *     newly created role, so a role added the day after the policy was set is silently exempt.
 *   - An organization-only model cannot express "required for administrators" without storing a
 *     list of role ids in a column, which no engine keeps referentially honest.
 *
 * ── Evaluated BEFORE a session exists ────────────────────────────────────────────────────────
 * §8: "MFA is evaluated after primary auth (local or SSO) and before a session is issued, so a
 * session never exists in a half-authenticated state." {@link MfaPolicyService.evaluate} is
 * therefore designed to be called by the login service between "the password was correct" and
 * `SessionService.issue()`, with NO session id to pass in and none returned. The recommended
 * sequence is documented on {@link MfaEvaluation}.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────────────────────
 * `evaluate()` THROWS on any infrastructure failure rather than returning "not required".
 * Requirements §2: "if the auth subsystem cannot initialise, refuse connections rather than
 * serving unauthenticated". A policy lookup that degrades to `false` when the database hiccups is
 * exactly the silent bypass §8 cannot tolerate, so the caller is forced to decide — and the only
 * correct decision is to refuse the login.
 */

/**
 * The MFA half of the audit catalog (requirements §10).
 *
 * `AuditEvent.ts` pins `auth.mfa.challenge` as a schema-level literal; the rest live here for the
 * reason that file gives — "the column is a plain varchar precisely so a new action never needs a
 * migration". Re-exported through this module rather than added to `IdentityAuditAction` so the
 * MFA feature owns its own vocabulary.
 */
export const MfaAuditAction = {
    /** A secret was generated and shown as a provisioning URI. NOT yet a usable factor. */
    ENROL_START: 'auth.mfa.enrol.start',
    /** A pending factor was promoted to confirmed by a correct code. */
    ENROL_CONFIRM: 'auth.mfa.enrol.confirm',
    /** A code was presented for verification — success or failure. Pinned by AuditEvent.ts. */
    CHALLENGE: AuditAction.AUTH_MFA_CHALLENGE,
    /** A factor was removed. Requires re-authentication (§8). */
    DISABLE: 'auth.mfa.disable',
    /** A batch of recovery codes was issued; every prior batch stopped being accepted. */
    RECOVERY_GENERATE: 'auth.mfa.recovery.generate',
    /** A single-use recovery code was redeemed — or an attempt to redeem one failed. */
    RECOVERY_CONSUME: 'auth.mfa.recovery.consume',
    /**
     * A bootstrap/break-glass account was let past an enforcement requirement.
     *
     * MIGRATION §4: "That exemption is recorded in the audit trail on every use, because a
     * permanent MFA-exempt account is a standing risk that should be visible rather than
     * forgotten." This is that record.
     */
    POLICY_EXEMPTION: 'auth.mfa.policy.exemption',
    /** A re-authentication challenge guarding a destructive MFA change (§8). */
    REAUTHENTICATE: 'auth.mfa.reauthenticate'
} as const

/**
 * Request-scoped context every MFA operation carries into the audit trail.
 *
 * §10 requires each record to answer who / when / where / which scope, and the services cannot
 * discover `route`, `ipAddress` or `userAgent` on their own — those live on the HTTP request. So
 * the caller supplies them once and every event written on that call inherits them.
 */
export interface MfaActorContext {
    userId: string
    /** The address as the operator would recognise it. Never a credential. */
    email?: string | null
    /**
     * Null during a login-time challenge, and that is the point: §8 evaluates MFA BEFORE a session
     * is issued, so at that moment there is no session id to attribute the event to.
     */
    sessionId?: string | null
    organizationId?: string | null
    workspaceId?: string | null
    /** The matched route PATTERN, never the raw URL (AuditService). */
    route?: string | null
    ipAddress?: string | null
    userAgent?: string | null
}

/** What the login service must do next. Exhaustive by construction — there is no "maybe" state. */
export enum MfaOutcome {
    /** Policy does not require a factor and the user holds none. Issue the session, `mfaSatisfied = false`. */
    NOT_REQUIRED = 'not_required',
    /** The user holds a confirmed factor. Do NOT issue a session until a code verifies. */
    CHALLENGE_REQUIRED = 'challenge_required',
    /** Policy requires a factor and the user holds none. Route to enrolment; do not issue a session. */
    ENROLMENT_REQUIRED = 'enrolment_required',
    /** A requirement existed and was suppressed for a bootstrap/break-glass account (MIGRATION §4). */
    EXEMPT = 'exempt'
}

/**
 * The complete answer, so a caller never has to re-derive part of it.
 *
 * ── The sequence the login service is expected to run ────────────────────────────────────────
 * ```
 *   1. verify the password (or complete the SSO code exchange)
 *   2. const evaluation = await mfaPolicy.evaluate(userId, organizationId, ctx)
 *   3. switch (evaluation.outcome) {
 *        NOT_REQUIRED | EXEMPT  -> sessions.issue({ ..., mfaSatisfied: false })
 *        ENROLMENT_REQUIRED     -> respond "enrolment required"; issue NOTHING
 *        CHALLENGE_REQUIRED     -> the presented code must verify first:
 *                                    totp.verify(...)  or  recoveryCodes.consume(...)
 *                                  then sessions.issue({ ..., mfaSatisfied: true,
 *                                                        mfaFactorId, mfaSatisfiedDate })
 *      }
 * ```
 * Note what is absent: no token, no cookie and no row is created between steps 2 and 3. A client
 * that fails the challenge simply repeats step 1 with the code attached. That is the whole of §8's
 * "a session never exists in a half-authenticated state" — it is a property of the shape of this
 * API, not a rule anyone has to remember.
 */
export interface MfaEvaluation {
    outcome: MfaOutcome
    /** The tenant's demand, AFTER the bootstrap exemption is applied. */
    required: boolean
    /** The tenant's demand BEFORE the exemption — what the policy would have said for anyone else. */
    requiredByPolicy: boolean
    exempt: boolean
    hasConfirmedFactor: boolean
    policy: MfaPolicy
    /** Which roles forced the requirement. Empty when only the org-wide axis fired. */
    requiringRoleIds: string[]
    /** False only when `mfaPolicy = off`, which disables enrolment outright (Organization.ts). */
    enrolmentAllowed: boolean
}

/** How a presented code should be routed. Shared so the login service and the route classify identically. */
export enum MfaChallengeKind {
    TOTP = 'totp',
    RECOVERY = 'recovery'
}

/**
 * Classify a presented code WITHOUT touching the database.
 *
 * A TOTP code is exactly `digits` decimal digits; a recovery code is not (see
 * `RecoveryCodeService` — it always contains a separator and at least one letter). Classifying
 * up-front matters for cost, not just tidiness: recovery verification runs a fixed number of
 * bcrypt comparisons, and doing that on every mistyped authenticator code would turn the challenge
 * endpoint into an amplification target.
 *
 * Ambiguity is impossible by construction, so this never guesses.
 */
export const detectChallengeKind = (code: string, totpDigits = 6): MfaChallengeKind => {
    const compact = code.replace(/[\s-]/g, '')
    return new RegExp(`^\\d{${totpDigits}}$`).test(compact) ? MfaChallengeKind.TOTP : MfaChallengeKind.RECOVERY
}

/**
 * Decides whether an account is a bootstrap/break-glass account, and therefore exempt from MFA
 * ENFORCEMENT (MIGRATION §4).
 *
 * An interface rather than a hard-coded check because the source of truth for "who is a bootstrap
 * account" is a deployment decision: MIGRATION §4 requires the identities to come "from environment
 * or CLI at run time. Never from a file in this repository, never a compiled-in default."
 */
export interface BootstrapAccountResolver {
    isExempt(account: { userId: string; email: string | null }): Promise<boolean> | boolean
}

/**
 * Env-backed resolver — the run-time source MIGRATION §4 mandates.
 *
 *   IDENTITY_BOOTSTRAP_EMAILS       comma-separated addresses provisioned as super-admin at first
 *                                   boot. Matching is case-insensitive and whitespace-trimmed.
 *   IDENTITY_BOOTSTRAP_MFA_EXEMPT   set to `false` to withdraw the exemption once a working
 *                                   authenticator is enrolled. Defaults to enabled, per §4.
 *
 * The exemption is DERIVED from the bootstrap list rather than configured separately, on purpose:
 * a standalone `IDENTITY_MFA_EXEMPT_EMAILS` variable would be a way to exempt an ordinary account
 * from a policy it is subject to, which is a bypass wearing a configuration key. Here, exempting an
 * account means declaring it a break-glass account — with everything else that implies (tenancy §2
 * puts MFA exemption in the super-admin column alongside key management and the recovery CLI).
 *
 * An empty list means nobody is exempt. That is the correct default: an instance that never ran the
 * bootstrap has no break-glass account to protect.
 */
export class EnvBootstrapAccountResolver implements BootstrapAccountResolver {
    private readonly env: NodeJS.ProcessEnv

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.env = env
    }

    isExempt(account: { userId: string; email: string | null }): boolean {
        if ((this.env.IDENTITY_BOOTSTRAP_MFA_EXEMPT ?? 'true').toLowerCase() === 'false') return false
        if (!account.email) return false
        const configured = (this.env.IDENTITY_BOOTSTRAP_EMAILS ?? '')
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0)
        return configured.includes(account.email.trim().toLowerCase())
    }
}

export interface MfaPolicyServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    audit?: AuditService
    bootstrapAccounts?: BootstrapAccountResolver
}

/** Raised when the policy cannot be determined. Never swallowed — see "Fail closed" in the header. */
export class MfaPolicyError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'MfaPolicyError'
    }
}

export class MfaPolicyService {
    private readonly injectedDataSource?: DataSource
    private readonly audit: AuditService
    private readonly bootstrapAccounts: BootstrapAccountResolver

    constructor(options: MfaPolicyServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.audit = options.audit ?? new AuditService({ dataSource: options.dataSource })
        this.bootstrapAccounts = options.bootstrapAccounts ?? new EnvBootstrapAccountResolver()
    }

    /** Lazy `require` for the same reason SessionService uses one: a static import would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    private repo<T extends ObjectLiteral>(entity: new () => T): Repository<T> {
        return this.getDataSource().getRepository<T>(entity)
    }

    /**
     * The organization-wide axis. A missing organization row yields the schema default rather than
     * an error: `Organization.mfaPolicy` defaults to `optional` (Organization.ts explains why not
     * `off`), and a single-organization deployment that has not written the row yet must behave the
     * same as one that has.
     */
    private async organizationPolicy(organizationId: string | null | undefined): Promise<MfaPolicy> {
        if (!organizationId) return MfaPolicy.OPTIONAL
        const organization = await this.repo(Organization).findOne({
            where: { id: organizationId },
            select: { id: true, mfaPolicy: true }
        })
        return organization?.mfaPolicy ?? MfaPolicy.OPTIONAL
    }

    /**
     * The per-role axis: every role the user holds in ANY workspace of `organizationId`, filtered to
     * those with `requiresMfa`.
     *
     * Resolved in three small reads rather than one join, and that is a considered choice. The join
     * would be `WorkspaceUser ⋈ Workspace ⋈ Role`, which TypeORM can only express here through the
     * query builder — and the alias/quoting behaviour of the query builder differs across the four
     * engines this project supports (SQLite, Postgres, MySQL, MariaDB). Three keyed reads over
     * indexed columns are portable, individually cheap, and bounded by the number of workspaces one
     * user belongs to, which is small by construction.
     *
     * Scoping runs through `Workspace.organizationId`, never through a caller-supplied workspace id
     * (requirements §4: "workspace scoping enforced server-side on every query"). Roles are
     * organization-scoped (spec §D.5), so a role in another tenant cannot leak a requirement in.
     */
    private async rolesRequiringMfa(userId: string, organizationId: string | null | undefined): Promise<string[]> {
        if (!organizationId) return []

        const memberships = await this.repo(WorkspaceUser).find({
            where: { userId },
            select: { workspaceId: true, userId: true, roleId: true }
        })
        if (memberships.length === 0) return []

        const workspaces = await this.repo(Workspace).find({
            where: { organizationId },
            select: { id: true, organizationId: true }
        })
        const inOrganization = new Set(workspaces.map((workspace) => workspace.id))

        const roleIds = [...new Set(memberships.filter((row) => inOrganization.has(row.workspaceId)).map((row) => row.roleId))]
        if (roleIds.length === 0) return []

        const requiring: string[] = []
        for (const roleId of roleIds) {
            const role = await this.repo(Role).findOne({
                where: { id: roleId },
                select: { id: true, requiresMfa: true, organizationId: true }
            })
            // A dangling roleId is a data defect, not an exemption. Skipping it silently would make
            // "delete the role, keep the membership" a way to shed an MFA obligation, so it is
            // logged loudly and treated as granting nothing.
            if (!role) {
                logger.error(`[MfaPolicyService] workspace membership for user ${userId} references missing role ${roleId}`)
                continue
            }
            if (role.requiresMfa) requiring.push(role.id)
        }
        return requiring
    }

    /** Does the user hold at least one CONFIRMED factor? A pending one never counts (MfaFactor.ts). */
    async hasConfirmedFactor(userId: string): Promise<boolean> {
        const factor = await this.repo(MfaFactor).findOne({
            where: { userId, status: MfaFactorStatus.CONFIRMED },
            select: { id: true, userId: true, status: true }
        })
        return Boolean(factor)
    }

    /**
     * The full decision. See {@link MfaEvaluation} for the sequence a login service runs around it.
     *
     * @throws {MfaPolicyError} on any infrastructure failure. Never returns "not required" as a
     *         fallback — see "Fail closed" in the module header.
     */
    async evaluate(userId: string, organizationId: string | null | undefined, context?: Partial<MfaActorContext>): Promise<MfaEvaluation> {
        let policy: MfaPolicy
        let requiringRoleIds: string[]
        let hasConfirmedFactor: boolean
        let email: string | null

        try {
            policy = await this.organizationPolicy(organizationId)
            requiringRoleIds = policy === MfaPolicy.OFF ? [] : await this.rolesRequiringMfa(userId, organizationId)
            hasConfirmedFactor = await this.hasConfirmedFactor(userId)
            const user = await this.repo(User).findOne({ where: { id: userId }, select: { id: true, email: true } })
            email = user?.email ?? context?.email ?? null
        } catch (error) {
            throw new MfaPolicyError(`MFA policy could not be determined for user ${userId}: ${getMessage(error)}`)
        }

        // `off` disables enrolment outright and does not challenge existing factors (Organization.ts).
        if (policy === MfaPolicy.OFF) {
            return {
                outcome: MfaOutcome.NOT_REQUIRED,
                required: false,
                requiredByPolicy: false,
                exempt: false,
                hasConfirmedFactor,
                policy,
                requiringRoleIds: [],
                enrolmentAllowed: false
            }
        }

        // The OR that Organization.ts specifies. Order is irrelevant to the result and chosen for
        // readability: the org-wide axis is the cheaper of the two to explain in an audit record.
        const requiredByPolicy = policy === MfaPolicy.REQUIRED || requiringRoleIds.length > 0
        const exempt = requiredByPolicy && (await this.bootstrapAccounts.isExempt({ userId, email }))
        const required = requiredByPolicy && !exempt

        if (exempt) {
            // MIGRATION §4 — "recorded in the audit trail on every use". Written only when the
            // exemption actually SUPPRESSED something: a bootstrap account under an `optional`
            // policy has used no exemption, and logging one would bury the real uses.
            await this.audit.record({
                action: MfaAuditAction.POLICY_EXEMPTION,
                outcome: AuditOutcome.SUCCESS,
                subject: { type: AuditSubjectType.USER, id: userId, label: email, sessionId: context?.sessionId ?? null },
                target: { type: 'user', id: userId },
                scope: { organizationId: organizationId ?? null, workspaceId: context?.workspaceId ?? null },
                route: context?.route ?? null,
                ipAddress: context?.ipAddress ?? null,
                userAgent: context?.userAgent ?? null,
                reason: 'bootstrap_account',
                detail: { policy, requiringRoleIds, hasConfirmedFactor },
                message: `MFA enforcement waived for break-glass account ${email ?? userId}`
            })
        }

        // A user who enrolled is challenged whatever the policy says — that is what `optional` means
        // ("users may enrol; only those who did are challenged", Organization.ts). The exemption
        // removes the OBLIGATION to hold a factor; it does not silently ignore one the account
        // actually holds, because that would let anyone who reaches a break-glass account skip a
        // second factor that is enrolled and working. A break-glass account whose authenticator is
        // genuinely broken is recovered with `flow-wiser mfa:disable` (MIGRATION §7), which is the
        // path designed for exactly that and which leaves a record.
        const outcome = hasConfirmedFactor
            ? MfaOutcome.CHALLENGE_REQUIRED
            : exempt
            ? MfaOutcome.EXEMPT
            : required
            ? MfaOutcome.ENROLMENT_REQUIRED
            : MfaOutcome.NOT_REQUIRED

        return { outcome, required, requiredByPolicy, exempt, hasConfirmedFactor, policy, requiringRoleIds, enrolmentAllowed: true }
    }

    /** Convenience over {@link evaluate} for callers that only need the boolean (requirements §8). */
    async isRequired(userId: string, organizationId: string | null | undefined): Promise<boolean> {
        return (await this.evaluate(userId, organizationId)).required
    }

    /**
     * Was the MFA policy in force satisfied when this session was issued (`Session.mfaSatisfied`)?
     *
     * `maxAgeMs` turns the same column pair into the step-up check §8 needs for "re-authentication
     * required to disable MFA or regenerate codes": `mfaSatisfiedDate` exists precisely so the AGE
     * of the proof can be measured (Session.ts). A session with `mfaSatisfied = true` but no
     * `mfaSatisfiedDate` cannot prove its age, so it fails an age-constrained check rather than
     * passing one it cannot substantiate.
     *
     * Deliberately synchronous and side-effect free: liveness, revocation and expiry are
     * SessionService's job, and duplicating them here would create a second, divergent answer to
     * "is this session valid?".
     */
    isSatisfied(
        session: Pick<Session, 'mfaSatisfied' | 'mfaSatisfiedDate'> | null | undefined,
        options: { maxAgeMs?: number } = {}
    ): boolean {
        if (!session || !session.mfaSatisfied) return false
        if (options.maxAgeMs === undefined) return true
        const satisfiedAt = session.mfaSatisfiedDate ? new Date(session.mfaSatisfiedDate).getTime() : null
        if (satisfiedAt === null || Number.isNaN(satisfiedAt)) return false
        return Date.now() - satisfiedAt <= options.maxAgeMs
    }
}

const getMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
