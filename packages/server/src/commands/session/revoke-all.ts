import { Flags } from '@oclif/core'
import { IsNull } from 'typeorm'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { Session, SessionRevokeReason, User } from '../../database/entities/identity'
import { SessionService } from '../../identity/services/SessionService'
import { RecoveryAuditAction, RecoveryCommand, RecoveryContext, RecoveryError, normaliseEmail, recordRecoveryEvent } from '../recovery-base'

/**
 * `flow-wiser session:revoke-all [--email <e>]` (REQUIREMENTS-MIGRATION.md §7).
 *
 * The containment command. When something has gone wrong and it is not yet known what, the first
 * useful action is to make every outstanding session stop working — and it has to be possible from
 * the host, because "log everyone out" issued through a compromised admin UI is not containment.
 *
 * REQUIREMENTS-AUTH-RBAC §5 is what makes this cheap: sessions are server-side rows, not
 * self-contained tokens, so revocation is a single UPDATE that takes effect on the next request.
 * A stateless-JWT design could not offer this command at all — the tokens would stay valid until
 * they expired, whatever the operator did.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────────────────────
 * `--email` limits it to one account (the "one user is compromised" case). Without it, EVERY live
 * session on the instance is revoked, which is the "we do not know yet" case and the reason §7
 * writes the command without a required argument.
 *
 * ── The reason is `revoked`, not `credential_changed` ────────────────────────────────────────
 * `SessionRevokeReason` distinguishes them (`REVOKED` = "explicit revoke ... or bulk revoke of every
 * session for a user"), and the distinction is load-bearing for whoever reads `identity_session`
 * afterwards: `credential_changed` says a password moved, and it did not. `admin:reset-password`
 * writes that one; this writes this one.
 *
 * Nothing is deleted. The session rows keep their issue time, IP, user agent and now their
 * revocation time — which is precisely the material an investigation needs.
 */
export interface RevokeAllInput extends RecoveryContext {
    /** Omitted = every session on the instance. */
    email?: string | null
}

export interface RevokeAllResult {
    scope: 'instance' | 'user'
    userId: string | null
    email: string | null
    revoked: number
    /** Live sessions found before the revoke — equals `revoked` unless something raced us. */
    liveBefore: number
}

export const revokeAllSessions = async (input: RevokeAllInput): Promise<RevokeAllResult> => {
    const { dataSource, audit, actor } = input
    const sessions = new SessionService({ dataSource })

    if (input.email) {
        const email = normaliseEmail(input.email)
        const user = await dataSource.getRepository(User).findOne({ where: { email } })
        if (!user) {
            await recordRecoveryEvent(audit, actor, {
                action: RecoveryAuditAction.SESSION_REVOKE_ALL,
                outcome: AuditOutcome.FAILURE,
                targetType: 'user',
                targetId: email,
                reason: 'unknown_user',
                message: `Recovery CLI could not revoke sessions for ${email}: no such account`,
                detail: { email }
            })
            throw new RecoveryError(`No account with the address ${email}. Run 'flow-wiser admin:list' to see the accounts that exist.`)
        }

        const liveBefore = await dataSource.getRepository(Session).count({ where: { userId: user.id, revokedDate: IsNull() } })
        const revoked = await sessions.revokeAllForUser(user.id, SessionRevokeReason.REVOKED)

        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.SESSION_REVOKE_ALL,
            outcome: AuditOutcome.SUCCESS,
            targetType: 'user',
            targetId: user.id,
            message: `Recovery CLI revoked ${revoked} session(s) for ${email}`,
            detail: { scope: 'user', email, revoked, liveBefore }
        })

        return { scope: 'user', userId: user.id, email, revoked, liveBefore }
    }

    const liveBefore = await dataSource.getRepository(Session).count({ where: { revokedDate: IsNull() } })
    // One statement across every user — the instance-wide case has no per-user loop to get wrong.
    const result = await dataSource
        .getRepository(Session)
        .update({ revokedDate: IsNull() }, { revokedDate: new Date(), revokedReason: SessionRevokeReason.REVOKED })
    const revoked = result.affected ?? 0

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.SESSION_REVOKE_ALL,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'session',
        targetId: 'all',
        message: `Recovery CLI revoked ${revoked} session(s) across the whole instance`,
        detail: { scope: 'instance', revoked, liveBefore }
    })

    return { scope: 'instance', userId: null, email: null, revoked, liveBefore }
}

export default class SessionRevokeAll extends RecoveryCommand {
    /** `RecoveryCommand` is `hidden` so the abstract base does not appear in help; the concrete
     *  commands opt back in, because static members are inherited. */
    static hidden = false

    static description = 'Revoke every live session, instance-wide or for one account.'

    static examples = ['<%= config.bin %> session:revoke-all', '<%= config.bin %> session:revoke-all --email ops@example.com']

    static flags = {
        ...RecoveryCommand.flags,
        email: Flags.string({ description: 'Revoke only this account’s sessions (default: the whole instance)' })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(SessionRevokeAll)
        const result = await revokeAllSessions({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            email: flags.email ?? null
        })

        if (result.scope === 'user') this.log(`Revoked ${result.revoked} session(s) for ${result.email}.`)
        else this.log(`Revoked ${result.revoked} session(s) across the whole instance.`)
        this.log('Every revoked session stops working on its next request. The rows are kept, with their revocation reason.')
    }
}
