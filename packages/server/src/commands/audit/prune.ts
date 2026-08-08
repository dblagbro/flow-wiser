import { Flags } from '@oclif/core'
import { DataSource } from 'typeorm'
import { AuditEvent, AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { RecoveryAuditAction, RecoveryCommand, recordRecoveryEvent } from '../recovery-base'

/**
 * Enforce an audit-retention period.
 *
 * ── Why retention is a control and not just housekeeping ─────────────────────────────────────
 *
 * PCI-DSS 10.7 is the specific one: at least one year of audit history, with three months
 * immediately available. SOC 2 CC7.2 and HIPAA §164.312(b) do not name a number but expect a
 * *defined and enforced* period — "we keep everything for ever" is a policy nobody wrote down, and
 * an unbounded table eventually becomes an availability problem that gets solved by someone
 * deleting rows by hand, unlogged.
 *
 * ── Deliberately conservative ────────────────────────────────────────────────────────────────
 *
 * The default retention is 400 days — comfortably over PCI's one year, with room for an audit that
 * slips. Below 365 days the command refuses without `--force`, because silently pruning inside the
 * period a framework requires is exactly the mistake this feature could otherwise cause.
 *
 * Dry run unless `--apply`, like every other destructive command here.
 *
 * ── Pruning is itself audited, and cannot prune its own record ───────────────────────────────
 *
 * The event recording a prune is written AFTER the delete, so it always falls outside the window it
 * describes. A prune that erased the evidence of pruning would defeat the point.
 *
 * ── Export first ─────────────────────────────────────────────────────────────────────────────
 *
 * The command refuses to delete anything unless `--i-have-exported` is passed. Deleted audit rows
 * are unrecoverable, and the whole reason this trail exists is that someone may need it later. That
 * flag is a speed bump on purpose: `audit:export --from-seq … --to-seq … ` first, keep the file and
 * its manifest, then prune.
 */

const DEFAULT_RETENTION_DAYS = 400
const FRAMEWORK_MINIMUM_DAYS = 365

export interface PruneResult {
    retentionDays: number
    cutoff: string
    matched: number
    oldestRemaining: string | null
    applied: boolean
}

export const pruneAuditTrail = async (input: {
    dataSource: DataSource
    audit: any
    actor: any
    retentionDays: number
    apply: boolean
}): Promise<PruneResult> => {
    const repo = input.dataSource.getRepository(AuditEvent)
    const cutoff = new Date(Date.now() - input.retentionDays * 24 * 60 * 60 * 1000)

    const matched = await repo.createQueryBuilder('e').where('e.occurredAt < :cutoff', { cutoff }).getCount()

    if (input.apply && matched > 0) {
        await repo.createQueryBuilder().delete().where('occurredAt < :cutoff', { cutoff }).execute()
    }

    const oldest = await repo.createQueryBuilder('e').orderBy('e.occurredAt', 'ASC').limit(1).getOne()

    // Written AFTER the delete so it can never be inside the window it describes.
    if (input.apply && matched > 0) {
        await recordRecoveryEvent(input.audit, input.actor, {
            action: RecoveryAuditAction.AUDIT_PRUNE,
            outcome: AuditOutcome.SUCCESS,
            targetType: 'audit',
            targetId: 'trail',
            message: `Pruned ${matched} audit event(s) older than ${input.retentionDays} days`,
            detail: { retentionDays: input.retentionDays, cutoff: cutoff.toISOString(), removed: matched }
        }).catch(() => undefined)
    }

    return {
        retentionDays: input.retentionDays,
        cutoff: cutoff.toISOString(),
        matched,
        oldestRemaining: oldest ? new Date(oldest.occurredAt).toISOString() : null,
        applied: input.apply && matched > 0
    }
}

export default class AuditPrune extends RecoveryCommand {
    static hidden = false

    static description = 'Delete audit events older than the retention period. Dry run unless --apply.'

    static examples = [
        '<%= config.bin %> audit:prune',
        '<%= config.bin %> audit:prune --retention-days 400 --i-have-exported --apply'
    ]

    static flags = {
        ...RecoveryCommand.flags,
        'retention-days': Flags.integer({
            description: `Keep events newer than this many days (default ${DEFAULT_RETENTION_DAYS}; PCI-DSS 10.7 requires at least 365)`,
            default: DEFAULT_RETENTION_DAYS
        }),
        'i-have-exported': Flags.boolean({
            description: 'Confirm the events being deleted have been exported. Deleted audit rows are unrecoverable.',
            default: false
        }),
        force: Flags.boolean({ description: 'Permit a retention period below the 365-day framework minimum.', default: false }),
        apply: Flags.boolean({ description: 'Actually delete. Without this the command only reports what it would do.', default: false })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AuditPrune)
        const days = flags['retention-days']

        if (days < FRAMEWORK_MINIMUM_DAYS && !flags.force) {
            this.error(
                `--retention-days ${days} is below the ${FRAMEWORK_MINIMUM_DAYS}-day minimum that PCI-DSS 10.7 requires. ` +
                    'Pass --force if this instance is genuinely not subject to that, and record why.',
                { exit: 1 }
            )
        }

        if (flags.apply && !flags['i-have-exported']) {
            this.error(
                'Refusing to delete audit history without --i-have-exported. Run ' +
                    '`flowise audit:export --file <path>` first and keep the file and its manifest; deleted rows cannot be recovered.',
                { exit: 1 }
            )
        }

        const result = await pruneAuditTrail({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            retentionDays: days,
            apply: flags.apply
        })

        this.log(`Retention: ${result.retentionDays} days (cutoff ${result.cutoff}).`)
        if (result.matched === 0) {
            this.log('No events are older than the retention period. Nothing to do.')
            return
        }
        if (result.applied) {
            this.log(`Deleted ${result.matched} event(s). Oldest remaining: ${result.oldestRemaining ?? 'none'}.`)
        } else {
            this.log(`${result.matched} event(s) would be deleted. Re-run with --i-have-exported --apply to do it.`)
        }
    }
}
