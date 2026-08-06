import { Flags } from '@oclif/core'
import { AuditOutcome, AuditSubjectType } from '../../database/entities/identity/AuditEvent'
import { MemberStatus, OrganizationUser, User } from '../../database/entities/identity'
import {
    AUTH_LOGIN_ACTION,
    LockoutState,
    RECOVERY_ROUTE,
    RECOVERY_SUBJECT_LABEL,
    RecoveryAuditAction,
    RecoveryCommand,
    RecoveryContext,
    RecoveryError,
    lockoutStateFor,
    normaliseEmail,
    recordRecoveryEvent
} from '../recovery-base'

/**
 * `flow-wiser admin:unlock --email <e>` — "clear lockout / failed attempts"
 * (REQUIREMENTS-MIGRATION.md §7).
 *
 * ── How you unlock a counter that lives in an append-only table ──────────────────────────────
 * `AuthService` derives the lockout from the audit trail rather than from a column, on purpose: "the
 * trail already records every failure with a reason, and it is append-only, so the count cannot be
 * edited away". That is the right design, and it has a direct consequence for this command — there
 * is no counter to zero and no row to delete. The walk stops at the first `auth.login` event for the
 * user whose outcome is `success`, so clearing the lockout means APPENDING an event that stops the
 * walk. Un-locking is a write forward, never a write backward, which is what an append-only trail is
 * supposed to force.
 *
 * The appended marker is deliberately legible and deliberately not a lie:
 *   - `subjectType` is SYSTEM, not USER — nobody authenticated;
 *   - `targetId` is `recovery-cli`, so the login-activity view renders its `loginMode` column as
 *     `recovery-cli` rather than the `Email/Password` that a real local sign-in produces;
 *   - `reason` is `admin_unlock` and the message says so in words;
 *   - the failures it cleared are recorded in `detail`, so the evidence survives the clearing.
 * An operator reading the login-activity screen sees "the recovery CLI cleared a lockout", which is
 * true, and cannot mistake it for a sign-in.
 *
 * If `AuthService` ever grows a first-class unlock hook, this marker should be replaced by it; the
 * behaviour required of the command would not change.
 *
 * ── It also reactivates an `inactive` membership ─────────────────────────────────────────────
 * Because "clear lockout" is what the operator MEANS, and `status = 'inactive'` produces the same
 * symptom from the user's chair: correct password, no way in. MIGRATION §5 creates exactly that
 * state deliberately — an account whose upstream password hash could not be identified "is migrated
 * *disabled* and must be recovered via CLI". This is that recovery. Reactivation is reported and
 * audited separately from the lockout clear, so the two are never confused.
 */
export interface UnlockInput extends RecoveryContext {
    email: string
    env?: NodeJS.ProcessEnv
}

export interface UnlockResult {
    userId: string
    email: string
    /** The lockout as it stood BEFORE the marker was appended. */
    before: LockoutState
    /** True when a marker was appended — false when the account was not locked and nothing was needed. */
    clearedLockout: boolean
    /** Memberships moved from `inactive` back to `active`. */
    reactivatedMemberships: string[]
}

export const unlockAdminAccount = async (input: UnlockInput): Promise<UnlockResult> => {
    const email = normaliseEmail(input.email)
    const { dataSource, audit, actor } = input
    const env = input.env ?? process.env

    const user = await dataSource.getRepository(User).findOne({ where: { email } })
    if (!user) {
        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.ADMIN_UNLOCK,
            outcome: AuditOutcome.FAILURE,
            targetType: 'user',
            targetId: email,
            reason: 'unknown_user',
            message: `Recovery CLI could not unlock ${email}: no such account`,
            detail: { email }
        })
        throw new RecoveryError(`No account with the address ${email}. Run 'flow-wiser admin:list' to see the accounts that exist.`)
    }

    const before = await lockoutStateFor(dataSource, user.id, env)

    // The chain-breaking marker. See the header for why this shape and not another.
    if (before.failures > 0) {
        await audit.record({
            action: AUTH_LOGIN_ACTION,
            outcome: AuditOutcome.SUCCESS,
            subject: { type: AuditSubjectType.SYSTEM, id: user.id, label: email },
            target: { type: 'login_method', id: RECOVERY_SUBJECT_LABEL },
            route: RECOVERY_ROUTE,
            reason: 'admin_unlock',
            message: `Lockout cleared by the recovery CLI — ${before.failures} consecutive failure(s) discounted. This is NOT a sign-in.`,
            detail: {
                clearedFailures: before.failures,
                wasLocked: before.locked,
                unlocksAtBefore: before.unlocksAt?.toISOString() ?? null,
                actor
            }
        })
    }

    const memberships = await dataSource.getRepository(OrganizationUser).find({ where: { userId: user.id } })
    const reactivated: string[] = []
    for (const membership of memberships) {
        if (membership.status === MemberStatus.ACTIVE) continue
        // Addressed by the composite primary key — OrganizationUser has no surrogate id.
        await dataSource
            .getRepository(OrganizationUser)
            .update({ organizationId: membership.organizationId, userId: membership.userId }, { status: MemberStatus.ACTIVE })
        reactivated.push(membership.organizationId)
    }

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.ADMIN_UNLOCK,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'user',
        targetId: user.id,
        message:
            `Recovery CLI unlocked ${email}: ${before.failures} failed attempt(s) cleared` +
            (reactivated.length > 0 ? `, ${reactivated.length} membership(s) reactivated` : ''),
        detail: {
            email,
            wasLocked: before.locked,
            clearedFailures: before.failures,
            reactivatedOrganizations: reactivated,
            lockoutPolicy: { maxAttempts: before.maxAttempts, windowMs: before.windowMs }
        }
    })

    return { userId: user.id, email, before, clearedLockout: before.failures > 0, reactivatedMemberships: reactivated }
}

export default class AdminUnlock extends RecoveryCommand {
    /** `RecoveryCommand` is `hidden` so the abstract base does not appear in help; the concrete
     *  commands opt back in, because static members are inherited. */
    static hidden = false

    static description = 'Clear an account lockout and its failed-attempt count, and reactivate an inactive membership.'

    static examples = ['<%= config.bin %> admin:unlock --email ops@example.com']

    static flags = {
        ...RecoveryCommand.flags,
        email: Flags.string({ description: 'Email address of the locked-out account', required: true })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AdminUnlock)
        const result = await unlockAdminAccount({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            email: flags.email
        })

        if (result.before.locked) {
            this.log(`${result.email} was LOCKED (${result.before.failures} consecutive failures). The lockout is cleared.`)
        } else if (result.clearedLockout) {
            this.log(`${result.email} was not locked, but had ${result.before.failures} recent failure(s). The count is cleared.`)
        } else {
            this.log(`${result.email} was not locked and had no recent failed attempts. Nothing to clear.`)
        }

        if (result.reactivatedMemberships.length > 0) {
            this.log(`Reactivated ${result.reactivatedMemberships.length} inactive organization membership(s).`)
        }
        this.log('If the password itself is unknown, run: flow-wiser admin:reset-password --email ' + result.email)
    }
}
