import { Flags } from '@oclif/core'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { User } from '../../database/entities/identity'
import {
    RecoveryAuditAction,
    RecoveryCommand,
    RecoveryContext,
    RecoveryError,
    normaliseEmail,
    recordRecoveryEvent
} from '../recovery-base'

/**
 * `flow-wiser admin:clear-password-change --email <e>` — "let this account back in without changing
 * its password" (REQUIREMENTS-MIGRATION.md §6, §7).
 *
 * ── The failure this exists for ──────────────────────────────────────────────────────────────
 * `admin:create` sets `mustChangePassword = true`, and `middleware/session.ts` then answers 403
 * `must_change_password` on every route except the change-password endpoint. That is correct
 * behaviour, and it is survivable ONLY while something can clear the flag. Over HTTP that something
 * is `POST /account/reset-password` (`identity/routes/account.ts`). This is the same exit without
 * HTTP — §7: "Every identity operation must be performable without a working UI and without a
 * working login, because the failure modes that need recovery are exactly the ones that break both."
 * An upgrade that leaves the server unreachable is precisely such a failure mode, and it is the case
 * the operator asked for.
 *
 * ── Why this is a separate command and NOT a flag on `admin:reset-password` ──────────────────
 * `admin/reset-password.ts` documents its own invariant: it sets the flag, and "there is no flag to
 * skip it". The rationale holds and is not being weakened — the operator who ran THAT command now
 * knows the password of an account that may not be theirs, so the account must change it. This
 * command has different semantics entirely: it changes no credential, so nobody learns a password by
 * running it, and the premise that made the flag mandatory there simply does not arise here.
 *
 * Naming it explicitly is part of that. `--no-force-change` on a reset would read as a convenience
 * toggle on an existing action; `admin:clear-password-change` is an action an operator has to choose
 * on purpose, and it shows up in the audit trail under its own verb
 * (`RecoveryAuditAction.ADMIN_CLEAR_PASSWORD_CHANGE`).
 *
 * ── What it deliberately does NOT touch ──────────────────────────────────────────────────────
 * Not `credential`, not `credentialUpdatedDate`, and no session rows. `AuthService.authenticate`
 * re-reads `mustChangePassword` from the user row on every request (spec §E.6), so a session that is
 * currently being 403'd starts working the instant this commits — no re-login, no cookie churn.
 * Bumping `credentialUpdatedDate` would invalidate every outstanding session (spec §D.12) and log
 * out the very user this command is unblocking.
 *
 * ── An account with no local password is NOT refused ─────────────────────────────────────────
 * It is tempting to refuse when `credential IS NULL` (an SSO-only account) by analogy with the HTTP
 * endpoint, which cannot serve that case — there is no current password for the caller to prove.
 * That is exactly backwards. An SSO account carrying this flag has NO route out over HTTP at all,
 * so this command is its only exit; refusing would brick permanently the one account that most needs
 * clearing. Clearing the flag grants no password-based access either, because there is no password
 * to use. The condition is reported loudly and recorded in the trail instead of being refused.
 */
export interface ClearPasswordChangeInput extends RecoveryContext {
    email: string
}

export interface ClearPasswordChangeResult {
    userId: string
    email: string
    /** True when the flag was actually set before this ran — false means there was nothing to do. */
    wasSet: boolean
    /** Whether the account has a local credential at all. See the header for why this is not a refusal. */
    hasLocalLogin: boolean
    isSSO: boolean
}

export const clearForcedPasswordChange = async (input: ClearPasswordChangeInput): Promise<ClearPasswordChangeResult> => {
    const email = normaliseEmail(input.email)
    const { dataSource, audit, actor } = input

    const user = await dataSource
        .getRepository(User)
        .findOne({ where: { email }, select: { id: true, email: true, credential: true, isSSO: true, mustChangePassword: true } })

    if (!user) {
        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.ADMIN_CLEAR_PASSWORD_CHANGE,
            outcome: AuditOutcome.FAILURE,
            targetType: 'user',
            targetId: email,
            reason: 'unknown_user',
            message: `Recovery CLI could not clear the forced change for ${email}: no such account`,
            detail: { email }
        })
        throw new RecoveryError(`No account with the address ${email}. Run 'flow-wiser admin:list' to see the accounts that exist.`)
    }

    const wasSet = user.mustChangePassword === true
    const hasLocalLogin = Boolean(user.credential)

    // Written even when the flag was already clear. A no-op is still somebody with filesystem access
    // asking to lift a security control off a named account, and §7 has no exception for reads.
    if (wasSet) await dataSource.getRepository(User).update({ id: user.id }, { mustChangePassword: false })

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.ADMIN_CLEAR_PASSWORD_CHANGE,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'user',
        targetId: user.id,
        message: wasSet
            ? `Recovery CLI cleared the forced password change for ${email}; the credential was NOT changed`
            : `Recovery CLI found no forced password change to clear for ${email}`,
        // NOT `mustChangePassword` / `clearedPasswordChange`: `crypto/redaction.ts` drops any key
        // whose NAME contains `password`, so the obvious spelling would land in the trail as the
        // literal string "[redacted]" and tell an investigator nothing. Same trap `admin/create.ts`
        // documents; the key bends, not the rule.
        detail: { email, forcedChangeWasSet: wasSet, forcedChangeCleared: wasSet, hasLocalLogin, isSSO: user.isSSO === true }
    })

    return { userId: user.id, email, wasSet, hasLocalLogin, isSSO: user.isSSO === true }
}

export default class AdminClearPasswordChange extends RecoveryCommand {
    /** `RecoveryCommand` is `hidden` so the abstract base does not appear in help; the concrete
     *  commands opt back in, because static members are inherited. */
    static hidden = false

    static description =
        'Clear a forced password change so an account can use the instance again. The credential is not touched and no password is prompted.'

    static examples = ['<%= config.bin %> admin:clear-password-change --email ops@example.com']

    static flags = {
        ...RecoveryCommand.flags,
        email: Flags.string({ description: 'Email address of the account being unblocked', required: true })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AdminClearPasswordChange)
        const result = await clearForcedPasswordChange({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            email: flags.email
        })

        if (result.wasSet) {
            this.log(`${result.email} (${result.userId}) is no longer required to change its password.`)
            this.log('The credential itself was NOT changed, and no session was revoked.')
        } else {
            this.log(`${result.email} (${result.userId}) was not being asked to change its password. Nothing to clear.`)
        }

        if (!result.hasLocalLogin) {
            this.log('')
            this.log(
                `NOTE: ${result.email} has no local password${result.isSSO ? ' and is marked as an SSO account' : ''}, so it cannot sign in ` +
                    'with one. Clearing the flag was still the right move — this account had no way out over HTTP — but if it needs a ' +
                    `password, run: flow-wiser admin:reset-password --email ${result.email}`
            )
        }
    }
}
