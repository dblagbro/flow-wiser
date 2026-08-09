import { Flags } from '@oclif/core'
import { DataSource } from 'typeorm'
import { Credential } from '../../database/entities/Credential'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import { decryptCredentialData, encryptCredentialData } from '../../utils'
import { envelopeKeyVersion, isEnvelope } from '../../utils/credentialEnvelope'
import { RecoveryAuditAction, RecoveryCommand, recordRecoveryEvent } from '../recovery-base'

/**
 * Re-encrypt stored credentials under the current key.
 *
 * ── Why this command exists ──────────────────────────────────────────────────────────────────
 *
 * SOC 2 CC6.1, HIPAA §164.312(a)(2)(iv) and PCI-DSS 3.6 all expect key rotation to be a defined,
 * repeatable procedure — not an incident. Before fw6 there was no procedure: credentials were
 * encrypted with a single static passphrase and no key version, so rotating meant hand-writing a
 * script that decrypted every row with the old key and rewrote it with the new one, in one pass,
 * with no way to resume and no way to tell afterwards which rows had actually moved.
 *
 * With the authenticated envelope each record carries its own key id and version, so this command
 * can answer "what is left?" without decrypting anything, and can be re-run safely after an
 * interruption.
 *
 * ── Two distinct jobs, deliberately one command ──────────────────────────────────────────────
 *
 *  1. **Upgrade** a legacy crypto-js record to the authenticated envelope.
 *  2. **Rotate** an envelope record from a retired key version to the current one.
 *
 * Both are "read with whatever it has, write with what we want now", and separating them would
 * give an operator two commands they must run in the right order.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────────────────────
 *
 * `--dry-run` is the default. Nothing is written unless `--apply` is passed, and every record is
 * proven to round-trip — decrypt, re-encrypt, decrypt again, compare — BEFORE any write happens.
 * A single failure aborts the whole run without writing, because a half-rotated credential table is
 * worse than an unrotated one: some flows work, others fail, and the pattern looks random.
 */

export interface RotateResult {
    total: number
    legacy: number
    alreadyCurrent: number
    rotated: number
    failed: { id: string; name: string; reason: string }[]
    applied: boolean
}

export const rotateCredentialEncryption = async (input: {
    dataSource: DataSource
    audit: any
    actor: any
    apply: boolean
}): Promise<RotateResult> => {
    const repo = input.dataSource.getRepository(Credential)
    const rows = await repo.find()

    const result: RotateResult = { total: rows.length, legacy: 0, alreadyCurrent: 0, rotated: 0, failed: [], applied: false }
    const planned: { id: string; name: string; next: string }[] = []

    // Establish the current key version by encrypting a throwaway value. Cheaper and more honest
    // than reading the keyring's own idea of "current" — this is the version a NEW write produces,
    // which is exactly what a record has to match to count as rotated.
    let currentVersion: number | null = null
    try {
        currentVersion = envelopeKeyVersion(await encryptCredentialData({ probe: 'x' } as any))
    } catch {
        currentVersion = null
    }

    for (const row of rows) {
        const wasLegacy = !isEnvelope(row.encryptedData)
        if (wasLegacy) result.legacy++

        if (!wasLegacy && currentVersion !== null && envelopeKeyVersion(row.encryptedData) === currentVersion) {
            result.alreadyCurrent++
            continue
        }

        try {
            const plain = await decryptCredentialData(row.encryptedData)
            const next = await encryptCredentialData(plain)
            // Prove the new ciphertext round-trips before it is a candidate for writing.
            const check = await decryptCredentialData(next)
            if (JSON.stringify(check) !== JSON.stringify(plain)) throw new Error('re-encrypted value does not round-trip')
            planned.push({ id: row.id, name: row.name, next })
        } catch (error) {
            result.failed.push({ id: row.id, name: row.name, reason: error instanceof Error ? error.message : String(error) })
        }
    }

    if (result.failed.length > 0) return result

    if (input.apply && planned.length > 0) {
        await input.dataSource.transaction(async (manager) => {
            for (const p of planned) {
                await manager.getRepository(Credential).update({ id: p.id }, { encryptedData: p.next })
            }
        })
        result.applied = true
    }
    result.rotated = planned.length

    await recordRecoveryEvent(input.audit, input.actor, {
        action: RecoveryAuditAction.CREDENTIAL_ROTATE_ENCRYPTION,
        outcome: result.failed.length === 0 ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
        targetType: 'credential',
        targetId: 'all',
        message: input.apply
            ? `Credential encryption rotation applied to ${result.rotated} record(s)`
            : `Credential encryption rotation dry run: ${planned.length} record(s) would be rewritten`,
        // No plaintext and no ciphertext — only counts. §9 keeps secrets out of the trail.
        detail: {
            total: result.total,
            legacyFormat: result.legacy,
            alreadyCurrent: result.alreadyCurrent,
            wouldRewrite: planned.length,
            applied: result.applied
        }
    }).catch(() => undefined)

    return result
}

export default class CredentialRotateEncryption extends RecoveryCommand {
    static hidden = false

    static description =
        'Re-encrypt stored credentials under the current key, upgrading legacy records to authenticated AES-256-GCM. Dry run unless --apply.'

    static examples = ['<%= config.bin %> credential:rotate-encryption', '<%= config.bin %> credential:rotate-encryption --apply']

    static flags = {
        ...RecoveryCommand.flags,
        apply: Flags.boolean({
            description: 'Actually write the re-encrypted records. Without this the command only reports what it would do.',
            default: false
        })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(CredentialRotateEncryption)
        const result = await rotateCredentialEncryption({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            apply: flags.apply
        })

        this.log(`${result.total} credential(s) examined.`)
        this.log(`  legacy (unauthenticated crypto-js) : ${result.legacy}`)
        this.log(`  already on the current key         : ${result.alreadyCurrent}`)

        if (result.failed.length > 0) {
            this.log(`\n${result.failed.length} record(s) could not be re-encrypted. NOTHING was written.`)
            for (const f of result.failed) this.log(`  FAILED  ${f.name}: ${f.reason}`)
            this.log('\nA partially rotated table is worse than an unrotated one, so the run aborted entirely.')
            this.log('The usual cause is a record encrypted under a key this instance no longer has.')
            this.error('Rotation aborted', { exit: 1 })
        }

        if (result.rotated === 0) {
            this.log('\nEvery credential is already encrypted under the current key. Nothing to do.')
            return
        }

        if (result.applied) {
            this.log(`\nRewrote ${result.rotated} credential(s) in a single transaction.`)
            this.log('Verify with: flowise doctor')
        } else {
            this.log(`\n${result.rotated} credential(s) would be rewritten. Re-run with --apply to do it.`)
            this.log('Take a database backup first; the previous ciphertext is not recoverable afterwards.')
        }
    }
}
