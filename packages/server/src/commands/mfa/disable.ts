import { Flags } from '@oclif/core'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { MfaFactor, MfaFactorStatus, MfaRecoveryCode, User } from '../../database/entities/identity'
import { RecoveryAuditAction, RecoveryCommand, RecoveryContext, RecoveryError, normaliseEmail, recordRecoveryEvent } from '../recovery-base'

/**
 * `flowise mfa:disable --email <e>` — "lost authenticator device"
 * (REQUIREMENTS-MIGRATION.md §7).
 *
 * The second factor is the one credential a helpdesk cannot re-issue over the phone. When the phone
 * is gone and the recovery codes are in the drawer of a locked office, the account is unreachable by
 * every path the application offers — which is exactly the class of failure §7 exists for.
 *
 * ── Factor rows are deleted, and their history is written to the trail first ─────────────────
 * `MfaFactorStatus` models only `pending` and `confirmed` — there is no `revoked` state to move a
 * factor into, and inventing one would mean changing `identity/**`, which this work does not own.
 * That leaves two options, and deleting is the safer one: demoting a confirmed factor back to
 * `pending` would leave its encrypted seed sitting in the table in a state the enrolment flow can
 * re-confirm, so a stolen-then-recovered authenticator would still verify. A deleted factor cannot.
 *
 * The evidence is not lost, because it is written somewhere better first. The audit record below
 * carries each factor's id, type, label, enrolment date, confirmation date and last use — everything
 * an investigator needs to answer "was MFA actually on for this account before the incident?" — into
 * an append-only table that this command cannot subsequently rewrite. Keeping the fact in the trail
 * rather than in a mutable status column is the stronger of the two records, not the weaker.
 *
 * The seed itself is never read, never logged and never recorded (§9).
 *
 * ── Unconsumed recovery codes are consumed, not deleted ──────────────────────────────────────
 * Same principle, and one additional reason: a set of recovery codes that outlived the factor it
 * belonged to is a standing bypass. They are marked consumed (`MfaRecoveryCode.consumedDate`, "set —
 * never deleted — so the audit trail can answer which recovery code was burned, and when") so the
 * batch stops being redeemable while the batch's existence stays on the record.
 *
 * ── This lowers the account's security, so it is loud ────────────────────────────────────────
 * The audit record names the number of factors revoked and the number of codes burned. An MFA
 * disable is a legitimate recovery action and a textbook account-takeover step; the two are
 * distinguishable only by the trail.
 */
export interface MfaDisableInput extends RecoveryContext {
    email: string
}

export interface MfaDisableResult {
    userId: string
    email: string
    factorsRemoved: number
    /** How many of those were confirmed (i.e. actually being challenged) versus half-finished enrolments. */
    confirmedFactorsRemoved: number
    recoveryCodesBurned: number
}

export const disableMfaForAccount = async (input: MfaDisableInput): Promise<MfaDisableResult> => {
    const email = normaliseEmail(input.email)
    const { dataSource, audit, actor } = input

    const user = await dataSource.getRepository(User).findOne({ where: { email } })
    if (!user) {
        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.MFA_DISABLE,
            outcome: AuditOutcome.FAILURE,
            targetType: 'user',
            targetId: email,
            reason: 'unknown_user',
            message: `Recovery CLI could not disable MFA for ${email}: no such account`,
            detail: { email }
        })
        throw new RecoveryError(`No account with the address ${email}. Run 'flowise admin:list' to see the accounts that exist.`)
    }

    // Loaded BEFORE the delete, so the trail can carry what is about to stop existing. `secret` is
    // `select: false` on the entity and is deliberately not asked for — nothing here reads a seed.
    const factors = await dataSource.getRepository(MfaFactor).find({ where: { userId: user.id } })

    const result = await dataSource.transaction(async (manager) => {
        // Only the codes that could still be redeemed. Already-consumed rows keep their original
        // `consumedDate` and `consumedBySessionId`, which is the history this must not overwrite.
        const outstanding = await manager
            .createQueryBuilder(MfaRecoveryCode, 'code')
            .where('code.userId = :userId', { userId: user.id })
            .andWhere('code.consumedDate IS NULL')
            .getMany()

        const burnedAt = new Date()
        for (const code of outstanding) {
            await manager.update(MfaRecoveryCode, { id: code.id }, { consumedDate: burnedAt })
        }

        for (const factor of factors) {
            await manager.delete(MfaFactor, { id: factor.id })
        }

        return { recoveryCodesBurned: outstanding.length }
    })

    const confirmed = factors.filter((factor) => factor.status === MfaFactorStatus.CONFIRMED)

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.MFA_DISABLE,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'user',
        targetId: user.id,
        message:
            `Recovery CLI disabled MFA for ${email}: ${factors.length} factor(s) removed ` +
            `(${confirmed.length} confirmed), ${result.recoveryCodesBurned} unused recovery code(s) burned`,
        // The enrolment history the deleted rows carried — ids, types, dates. Never a seed, never a
        // recovery code, never anything decryptable (§9, §10).
        detail: {
            email,
            factorsRemoved: factors.length,
            confirmedFactorsRemoved: confirmed.length,
            // `unusedCodesBurned`, not `recoveryCodesBurned`: `recoverycode` is on the redactor's
            // key-name denylist, so the obvious spelling would store "[redacted]" instead of a count.
            unusedCodesBurned: result.recoveryCodesBurned,
            factors: factors.map((factor) => ({
                id: factor.id,
                type: factor.type,
                label: factor.label ?? null,
                status: factor.status,
                enrolledAt: factor.createdDate?.toISOString() ?? null,
                confirmedAt: factor.confirmedDate?.toISOString() ?? null,
                lastUsedAt: factor.lastUsedDate?.toISOString() ?? null
            }))
        }
    })

    return {
        userId: user.id,
        email,
        factorsRemoved: factors.length,
        confirmedFactorsRemoved: confirmed.length,
        recoveryCodesBurned: result.recoveryCodesBurned
    }
}

export default class MfaDisable extends RecoveryCommand {
    /** `RecoveryCommand` is `hidden` so the abstract base does not appear in help; the concrete
     *  commands opt back in, because static members are inherited. */
    static hidden = false

    static description = 'Revoke every MFA factor and outstanding recovery code for an account (lost authenticator).'

    static examples = ['<%= config.bin %> mfa:disable --email ops@example.com']

    static flags = {
        ...RecoveryCommand.flags,
        email: Flags.string({ description: 'Email address of the account that lost its authenticator', required: true })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(MfaDisable)
        const result = await disableMfaForAccount({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            email: flags.email
        })

        if (result.factorsRemoved === 0 && result.recoveryCodesBurned === 0) {
            this.log(`${result.email} had no MFA factor and no unused recovery codes. Nothing to do.`)
            return
        }

        this.log(`Removed ${result.factorsRemoved} MFA factor(s) for ${result.email} (${result.confirmedFactorsRemoved} confirmed).`)
        this.log(`Burned ${result.recoveryCodesBurned} unused recovery code(s).`)
        this.log('The enrolment history is preserved in the audit trail. Re-enrol from the account screen once you are back in.')
    }
}
