import { Flags } from '@oclif/core'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { SessionRevokeReason, User } from '../../database/entities/identity'
import { SessionService } from '../../identity/services/SessionService'
import {
    RecoveryAuditAction,
    RecoveryCommand,
    RecoveryContext,
    RecoveryError,
    describeViolations,
    hashOrExplain,
    normaliseEmail,
    promptNewPassword,
    recordRecoveryEvent
} from '../recovery-base'

/**
 * `flow-wiser admin:reset-password --email <e>` (REQUIREMENTS-MIGRATION.md §7).
 *
 * The command `BootstrapService` points at: bootstrap deliberately never re-hashes the environment
 * password for an account that already exists ("Recovery for a genuinely lost password is
 * `flow-wiser admin:reset-password` (§7), which prompts rather than reading argv or the
 * environment"). This is the other end of that sentence.
 *
 * Three things happen, and all three are required:
 *
 *  1. **The hash is replaced.** Via `passwords.hash`, so the new credential is bcrypt at the CURRENT
 *     cost — a reset silently upgrades an old cost-10 hash on the way through.
 *  2. **`mustChangePassword` is set.** MIGRATION §6. The operator who ran this command now knows the
 *     password of an account that is not theirs; the flag makes that state temporary by construction
 *     rather than by good intentions. There is no flag to skip it.
 *  3. **Every session is revoked.** A password reset that leaves the old sessions alive does not
 *     recover an account from a compromise, it just adds a second way in. `credentialUpdatedDate`
 *     alone would invalidate them lazily (spec §D.12), but it is set here AND the rows are revoked
 *     explicitly, so `identity_session` also carries the reason — an operator listing active
 *     sessions afterwards sees `credential_changed`, not an empty table with no explanation.
 */
export interface ResetPasswordInput extends RecoveryContext {
    email: string
    password: string
}

export interface ResetPasswordResult {
    userId: string
    email: string
    /** The bcrypt digest BEFORE and AFTER, so a caller can prove the credential actually moved. */
    hashChanged: boolean
    sessionsRevoked: number
    mustChangePassword: true
}

export const resetAdminPassword = async (input: ResetPasswordInput): Promise<ResetPasswordResult> => {
    const email = normaliseEmail(input.email)
    const { dataSource, audit, actor } = input

    const user = await dataSource
        .getRepository(User)
        .findOne({ where: { email }, select: { id: true, email: true, credential: true, isSSO: true } })

    if (!user) {
        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.ADMIN_RESET_PASSWORD,
            outcome: AuditOutcome.FAILURE,
            targetType: 'user',
            targetId: email,
            reason: 'unknown_user',
            message: `Recovery CLI could not reset the password for ${email}: no such account`,
            detail: { email }
        })
        throw new RecoveryError(`No account with the address ${email}. Run 'flow-wiser admin:list' to see the accounts that exist.`)
    }

    const previousHash = user.credential ?? null
    const credential = await hashOrExplain(input.password)
    const changedAt = new Date()

    await dataSource.getRepository(User).update(
        { id: user.id },
        {
            credential,
            // Sessions issued before this instant stop validating (User.credentialUpdatedDate).
            credentialUpdatedDate: changedAt,
            mustChangePassword: true
        }
    )

    const sessionsRevoked = await new SessionService({ dataSource }).revokeAllForUser(user.id, SessionRevokeReason.CREDENTIAL_CHANGED)

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.ADMIN_RESET_PASSWORD,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'user',
        targetId: user.id,
        message: `Recovery CLI reset the password for ${email}; ${sessionsRevoked} session(s) revoked, password change forced`,
        // NEITHER hash is recorded — not the old one, not the new one (§9: "encrypted values never
        // appear in logs, audit records, API responses, or error messages"). Only the FACT that it moved.
        // `hadLocalLogin` / `forcedChangeOnNextLogin` rather than `hadPassword` / `mustChangePassword`:
        // the central redactor drops any key whose NAME contains `password`, so the obvious spelling
        // would store the string "[redacted]" in place of the fact. See admin/create.ts.
        detail: { email, hadLocalLogin: previousHash !== null, isSSO: user.isSSO, sessionsRevoked, forcedChangeOnNextLogin: true }
    })

    return { userId: user.id, email, hashChanged: credential !== previousHash, sessionsRevoked, mustChangePassword: true }
}

export default class AdminResetPassword extends RecoveryCommand {
    static description = 'Reset an account password. The password is prompted, never passed as an argument.'

    static examples = ['<%= config.bin %> admin:reset-password --email ops@example.com']

    static flags = {
        ...RecoveryCommand.flags,
        email: Flags.string({ description: 'Email address of the account to reset', required: true })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AdminResetPassword)
        const email = normaliseEmail(flags.email)

        const { password, violations } = await promptNewPassword(email)
        if (violations.length > 0) {
            await this.recordRecovery({
                action: RecoveryAuditAction.ADMIN_RESET_PASSWORD,
                outcome: AuditOutcome.FAILURE,
                targetType: 'user',
                targetId: email,
                reason: 'weak_password',
                message: `Recovery CLI refused to reset ${email}: password rejected by policy`,
                detail: { email, violations }
            })
            throw new RecoveryError(describeViolations(violations))
        }

        const result = await resetAdminPassword({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            email,
            password
        })

        this.log(`Password reset for ${result.email} (${result.userId}).`)
        this.log(`Revoked ${result.sessionsRevoked} active session(s).`)
        this.log('A password change is required at next login.')
    }
}
