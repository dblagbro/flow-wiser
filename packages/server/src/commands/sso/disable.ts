import { Flags } from '@oclif/core'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { LoginMethod, LoginMethodProvider, LoginMethodStatus } from '../../database/entities/identity'
import { User } from '../../database/entities/identity'
import { RecoveryAuditAction, RecoveryCommand, RecoveryContext, RecoveryError, recordRecoveryEvent } from '../recovery-base'

/**
 * `flow-wiser sso:disable` — "provider outage lockout" (REQUIREMENTS-MIGRATION.md §7).
 *
 * The failure this exists for is not a bug in this codebase. It is Azure AD being down, or a client
 * secret expiring at midnight, or a tenant admin revoking the app registration — and the symptom is
 * that the login page offers a button that cannot work and no other way in. REQUIREMENTS-AUTH-RBAC
 * puts it as a rule: "SSO must never be the only way in, or a provider outage locks everyone out."
 * This command is what enforces that rule when it has already been broken.
 *
 * ── What it changes, and what it deliberately does not ───────────────────────────────────────
 * `LoginMethod.status` moves to `disable`. That is the SAME field the SSO configuration screen
 * writes (spec §A.9 compares it to the literal `'enable'`), so this is not a back channel — it is
 * the supported off switch, reachable when the screen that owns it is not.
 *
 * The provider CONFIGURATION is untouched: client id, the encrypted client secret, the callback
 * URLs, the whole `config` blob stay exactly as they were. Re-enabling is one click once the outage
 * is over. A recovery command that made the operator re-enter an OAuth client secret at 03:00 would
 * turn a ten-minute outage into an hour-long one, and would tempt them to paste the secret into a
 * shell — which is the thing §7 is trying to prevent everywhere else.
 *
 * ── The warning it prints is the point of the command ────────────────────────────────────────
 * Disabling SSO does nothing at all for a user who has no local password: their `User.credential`
 * is null, and turning off the provider only removes the button. The command therefore counts the
 * accounts that would still be able to log in afterwards and says so out loud. When that count is
 * zero it names the next command to run (`admin:create` or `admin:reset-password`), because
 * discovering it by trying to log in is how a ten-minute outage becomes an incident.
 */
export interface SsoDisableInput extends RecoveryContext {
    /** Restrict to one provider. Omitted = every configured provider, which is the outage case. */
    provider?: string | null
    /** Restrict to one organization's configuration. Omitted = instance-wide. */
    organizationId?: string | null
}

export interface SsoDisableResult {
    disabled: { id: string; provider: string; organizationId: string | null }[]
    alreadyDisabled: number
    /** Accounts that hold a local password and can therefore still log in with SSO off. */
    accountsWithLocalPassword: number
    totalAccounts: number
}

export const disableSso = async (input: SsoDisableInput): Promise<SsoDisableResult> => {
    const { dataSource, audit, actor } = input

    if (input.provider && !(Object.values(LoginMethodProvider) as string[]).includes(input.provider)) {
        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.SSO_DISABLE,
            outcome: AuditOutcome.FAILURE,
            targetType: 'login_method',
            targetId: input.provider,
            reason: 'unknown_provider',
            message: `Recovery CLI refused to disable SSO: unknown provider '${input.provider}'`,
            detail: { provider: input.provider }
        })
        throw new RecoveryError(
            `Unknown SSO provider '${input.provider}'. Known providers: ${Object.values(LoginMethodProvider).join(', ')}.`
        )
    }

    const methods = await dataSource.getRepository(LoginMethod).find()
    const targeted = methods.filter((method) => {
        if (input.provider && method.name !== input.provider) return false
        if (input.organizationId && method.organizationId !== input.organizationId) return false
        return true
    })

    const enabled = targeted.filter((method) => method.status === LoginMethodStatus.ENABLE)
    for (const method of enabled) {
        await dataSource.getRepository(LoginMethod).update({ id: method.id }, { status: LoginMethodStatus.DISABLE })
    }

    // "Who can still get in?" — the number that decides whether this command fixed the outage or
    // merely acknowledged it. `credential` is `select: false`, so it has to be asked for by name;
    // only its presence is read, never its value.
    const users = await dataSource.getRepository(User).find({ select: { id: true, credential: true } })
    const accountsWithLocalPassword = users.filter((user) => Boolean(user.credential)).length

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.SSO_DISABLE,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'login_method',
        targetId: input.provider ?? 'all',
        organizationId: input.organizationId ?? null,
        message:
            `Recovery CLI disabled ${enabled.length} SSO login method(s)` +
            `; ${accountsWithLocalPassword} of ${users.length} account(s) hold a local password`,
        // Provider names and ids. Never a client secret and never any part of the config blob (§9).
        detail: {
            provider: input.provider ?? 'all',
            organizationId: input.organizationId ?? null,
            disabled: enabled.map((method) => ({ id: method.id, provider: method.name, organizationId: method.organizationId ?? null })),
            alreadyDisabled: targeted.length - enabled.length,
            // `accountsWithLocalLogin`, not `…LocalPassword`: the redactor drops any key whose name
            // contains `password`, and this number is the whole point of the command's output.
            accountsWithLocalLogin: accountsWithLocalPassword,
            totalAccounts: users.length
        }
    })

    return {
        disabled: enabled.map((method) => ({ id: method.id, provider: method.name, organizationId: method.organizationId ?? null })),
        alreadyDisabled: targeted.length - enabled.length,
        accountsWithLocalPassword,
        totalAccounts: users.length
    }
}

export default class SsoDisable extends RecoveryCommand {
    static description = 'Disable SSO login methods so local password login is reachable during a provider outage.'

    static examples = ['<%= config.bin %> sso:disable', '<%= config.bin %> sso:disable --provider azure']

    static flags = {
        ...RecoveryCommand.flags,
        provider: Flags.string({
            description: 'Disable only this provider (default: all)',
            options: Object.values(LoginMethodProvider)
        }),
        organization: Flags.string({ description: 'Disable only this organization’s configuration (default: instance-wide)' })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(SsoDisable)
        const result = await disableSso({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            provider: flags.provider ?? null,
            organizationId: flags.organization ?? null
        })

        if (result.disabled.length === 0) {
            this.log('No enabled SSO login method matched. Nothing was changed.')
        } else {
            for (const method of result.disabled) {
                this.log(`Disabled ${method.provider}${method.organizationId ? ` (organization ${method.organizationId})` : ''}.`)
            }
            this.log('Provider configuration and the stored client secret are untouched — re-enable from the SSO screen.')
        }

        this.log('')
        this.log(`${result.accountsWithLocalPassword} of ${result.totalAccounts} account(s) hold a local password.`)
        if (result.accountsWithLocalPassword === 0) {
            this.log('NOBODY can log in with SSO off. Create or repair a local account before you rely on this:')
            this.log('  flow-wiser admin:create --email <you> --role super-admin')
            this.log('  flow-wiser admin:reset-password --email <existing-account>')
            this.exitWithFailure = true
        }
    }
}
