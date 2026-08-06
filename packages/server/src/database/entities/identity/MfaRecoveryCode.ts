/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'

/**
 * Identity — MfaRecoveryCode (requirements §8, §9).
 *
 * The escape hatch for a lost authenticator: "recovery codes are shown once, stored hashed, and
 * individually consumable" (§8).
 *
 * ── Why hashed and NOT encrypted ─────────────────────────────────────────────────────────────
 * §9 is explicit — "hashes are not encryption. Passwords and recovery codes are hashed (argon2id or
 * bcrypt), never encrypted; they are never decryptable, by us or anyone." A recovery code only ever
 * needs to be COMPARED against a presented value, never recovered, so encrypting it would add a
 * decryption path that has no legitimate caller and one obvious illegitimate one. Consequently this
 * entity carries none of the key-version/nonce metadata that MfaFactor.secret does.
 *
 * ── Why a batch id ───────────────────────────────────────────────────────────────────────────
 * §8 requires regeneration to invalidate the previous set. Modelling that as "delete the old rows"
 * loses the evidence that a set existed and was superseded; modelling it as a batch marker means
 * verification is scoped to the CURRENT batch while the spent and superseded rows remain for the
 * audit trail. The same reasoning as Token supersession (spec §F-3).
 *
 * ── Why there is no index on the hash ────────────────────────────────────────────────────────
 * argon2id/bcrypt digests are individually salted, so the same code hashes differently every time
 * and cannot be looked up. Verification loads the user's unconsumed codes for the current batch —
 * served by the (userId, batchId, consumedDate) index — and compares each in constant time. A batch
 * is ~10 rows, so this is bounded and cheap.
 */
@Entity('identity_mfa_recovery_code')
export class MfaRecoveryCode {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Index()
    @Column({ type: 'uuid' })
    userId: string

    /**
     * Identifies the generation this code belongs to. Regenerating issues a new batchId and every
     * prior batch stops being accepted — the invalidation §8 requires, without deleting history.
     *
     * Not an FK to anything: a batch is not an entity in its own right, it is a correlation id.
     */
    @Index()
    @Column({ type: 'uuid' })
    batchId: string

    /**
     * argon2id or bcrypt digest of the code. NEVER the code itself, and never encrypted (§9).
     *
     * `select: false` so it cannot be loaded incidentally. Sized like `User.credential`: bcryptjs
     * emits 60 chars, argon2id PHC strings run to ~100, 255 covers both plus future parameters.
     */
    @Column({ type: 'varchar', length: 255, select: false })
    codeHash: string

    /**
     * Single-use marker (§8: "individually consumable"). Null = still redeemable. Set — never
     * deleted — so the audit trail can answer "which recovery code was burned, and when".
     */
    // `type` is explicit because `?: Date | null` serialises to design:type Object, not Date —
    // TypeORM then rejects the column outright ("Data type Object ... is not supported") and the
    // whole identity DataSource fails to initialise. Every other date column here already says so.
    @Column({ type: 'timestamp', nullable: true })
    consumedDate?: Date | null

    /** The session that redeemed it, so a suspicious redemption can be traced to its login */
    @Column({ nullable: true, type: 'uuid' })
    consumedBySessionId?: string | null

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User
}
