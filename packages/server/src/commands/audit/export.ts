import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { Flags } from '@oclif/core'
import { DataSource } from 'typeorm'
import { AuditEvent, AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { RecoveryAuditAction, RecoveryCommand, recordRecoveryEvent } from '../recovery-base'

/**
 * Export the audit trail to a file an auditor can actually work with.
 *
 * ── Why a command and not just a database query ──────────────────────────────────────────────
 *
 * Every framework that matters here asks for the same three things, and a raw table satisfies none
 * of them on its own:
 *
 *   SOC 2 CC7.2 / CC7.3   evidence that security events are logged AND reviewed. Review requires
 *                         something a human can be handed.
 *   HIPAA §164.312(b)     "record and examine activity" — examination implies extraction.
 *   PCI-DSS 10.5          audit trails must be protected from alteration, and it must be possible
 *                         to DEMONSTRATE they have not been altered.
 *
 * The third is the one that shapes this command. An append-only table is a good design property,
 * but "trust us, nothing deletes from it" is not evidence. So every export carries a manifest with
 * a SHA-256 over the exported rows and the seqNo range it covers. Two exports of the same range
 * must produce the same digest; if they do not, something changed rows that should never change.
 *
 * That is deliberately a weaker claim than a cryptographically chained log — this does not prevent
 * an attacker with database access from rewriting history and re-exporting. It detects drift
 * between two points in time, which is what an auditor asks for. Saying so plainly here is better
 * than implying tamper-PROOFING we do not have.
 *
 * ── JSONL, not CSV or JSON ───────────────────────────────────────────────────────────────────
 *
 * One event per line. A trail can be large, so the exporter must stream rather than build an array
 * in memory; a single JSON document would have to be read whole to be parsed. JSONL also survives
 * truncation — a partial file is still a valid prefix of events — and `detail` is a nested object
 * that CSV would flatten or drop.
 */

export interface ExportResult {
    file: string
    manifestFile: string
    events: number
    firstSeqNo: number | null
    lastSeqNo: number | null
    digest: string
    from: string | null
    to: string | null
}

const PAGE = 500

export const exportAuditTrail = async (input: {
    dataSource: DataSource
    audit: any
    actor: any
    file: string
    from?: Date
    to?: Date
}): Promise<ExportResult> => {
    const repo = input.dataSource.getRepository(AuditEvent)
    const hash = createHash('sha256')
    const stream = createWriteStream(input.file, { encoding: 'utf8' })

    let count = 0
    let first: number | null = null
    let last: number | null = null
    let afterSeq = -1

    // Keyset pagination on seqNo rather than OFFSET: the trail is append-only, so a monotonic key
    // gives a stable window even while new events are being written during a long export.
    for (;;) {
        const qb = repo
            .createQueryBuilder('e')
            .where('e.seqNo > :afterSeq', { afterSeq })
            .orderBy('e.seqNo', 'ASC')
            .limit(PAGE)
        if (input.from) qb.andWhere('e.createdDate >= :from', { from: input.from })
        if (input.to) qb.andWhere('e.createdDate <= :to', { to: input.to })

        const page = await qb.getMany()
        if (page.length === 0) break

        for (const event of page) {
            const seq = Number(event.seqNo)
            if (first === null) first = seq
            last = seq
            afterSeq = seq

            // The digest covers the serialised line, so it changes if ANY field of ANY event
            // changes — not merely if the count changes.
            const line = JSON.stringify(event)
            hash.update(line)
            hash.update('\n')
            stream.write(line + '\n')
            count++
        }
        if (page.length < PAGE) break
    }

    await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error) => (err ? reject(err) : resolve()))
    })

    const digest = hash.digest('hex')
    const manifest = {
        exportedAt: new Date().toISOString(),
        events: count,
        firstSeqNo: first,
        lastSeqNo: last,
        from: input.from ? input.from.toISOString() : null,
        to: input.to ? input.to.toISOString() : null,
        algorithm: 'sha256',
        digest,
        // Stated in the artifact itself so nobody over-reads it later.
        digestCovers: 'the concatenation of each exported JSONL line, in seqNo order, each followed by a newline',
        integrityClaim:
            'Re-exporting the same seqNo range must reproduce this digest. A mismatch means rows in that range were ' +
            'modified or removed. This detects drift; it does not prevent an actor with database write access from ' +
            'rewriting history and re-exporting.'
    }
    const manifestFile = `${input.file}.manifest.json`
    await new Promise<void>((resolve, reject) => {
        const ms = createWriteStream(manifestFile, { encoding: 'utf8' })
        ms.write(JSON.stringify(manifest, null, 2) + '\n')
        ms.end((err?: Error) => (err ? reject(err) : resolve()))
    })

    // The export is itself an auditable event: someone took a copy of the security log.
    await recordRecoveryEvent(input.audit, input.actor, {
        action: RecoveryAuditAction.AUDIT_EXPORT,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'audit',
        targetId: 'trail',
        message: `Exported ${count} audit event(s) to ${input.file}`,
        detail: { events: count, firstSeqNo: first, lastSeqNo: last, digest }
    }).catch(() => undefined)

    return { file: input.file, manifestFile, events: count, firstSeqNo: first, lastSeqNo: last, digest, from: manifest.from, to: manifest.to }
}

export default class AuditExport extends RecoveryCommand {
    static hidden = false

    static description = 'Export the audit trail to JSONL with a SHA-256 manifest, for review or evidence retention.'

    static examples = [
        '<%= config.bin %> audit:export --file /tmp/audit.jsonl',
        '<%= config.bin %> audit:export --file /tmp/q3.jsonl --from 2026-07-01 --to 2026-09-30'
    ]

    static flags = {
        ...RecoveryCommand.flags,
        file: Flags.string({ description: 'Destination path for the JSONL export', required: true }),
        from: Flags.string({ description: 'Only events at or after this date (ISO-8601)' }),
        to: Flags.string({ description: 'Only events at or before this date (ISO-8601)' })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AuditExport)

        const parseDate = (value: string | undefined, label: string): Date | undefined => {
            if (!value) return undefined
            const d = new Date(value)
            if (Number.isNaN(d.getTime())) this.error(`--${label} is not a valid ISO-8601 date: ${value}`, { exit: 1 })
            return d
        }

        const result = await exportAuditTrail({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            file: flags.file,
            from: parseDate(flags.from, 'from'),
            to: parseDate(flags.to, 'to')
        })

        if (result.events === 0) {
            this.log('No audit events matched. An empty export was still written, with a manifest recording that.')
            return
        }

        this.log(`Exported ${result.events} event(s), seqNo ${result.firstSeqNo}–${result.lastSeqNo}.`)
        this.log(`  events   ${result.file}`)
        this.log(`  manifest ${result.manifestFile}`)
        this.log(`  sha256   ${result.digest}`)
        this.log('\nRe-exporting the same range must reproduce that digest. A mismatch means rows were altered.')
    }
}
