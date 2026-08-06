/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'
import { EncryptionAlgorithm, ENCRYPTION_KEY_ID_MAX_LENGTH, ENCRYPTION_NONCE_MAX_LENGTH } from './EncryptionMetadata'

/**
 * Second-factor kinds. TOTP is the only one implemented (requirements §8: "TOTP (RFC 6238) as the
 * baseline second factor"); `webauthn` is present so adding passkeys is a new row value rather than
 * a schema change — §8 requires them to be "designed for behind the same factor interface".
 */
export enum MfaFactorType {
    TOTP = 'totp',
    /** Reserved — not accepted by the enrolment service until the WebAuthn factor ships (§8 non-goal for v1) */
    WEBAUTHN = 'webauthn'
}

/**
 * Enrolment is two-phase: a secret is generated and shown as a QR provisioning URI (`pending`), and
 * only a correct verification code promotes it to `confirmed` (requirements §8: "enrolment with QR
 * provisioning URI, verification").
 *
 * Only `confirmed` factors count toward policy satisfaction. This matters: if a `pending` factor
 * satisfied a required-MFA policy, starting an enrolment and abandoning it would be a bypass.
 */
export enum MfaFactorStatus {
    PENDING = 'pending',
    CONFIRMED = 'confirmed'
}

/**
 * Identity — MfaFactor (requirements §8).
 *
 * Net-new: Flowise has no MFA at all, so there is no wire contract to satisfy here and no §D entry
 * to cite — the shape is derived entirely from requirements §8 and §9.
 *
 * One row per enrolled factor per user, so a user may hold several (a phone authenticator and a
 * laptop one), and so revoking one does not disturb the others. Recovery codes are NOT factors —
 * they are a separate entity because they are hashed rather than encrypted and are consumed
 * individually (§9: "hashes are not encryption").
 */
@Entity('identity_mfa_factor')
export class MfaFactor {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /**
     * Indexed together with `status` in the migration: the hot query is "does this user hold any
     * confirmed factor?", asked on every login before a session is issued (§8).
     */
    @Index()
    @Column({ type: 'uuid' })
    userId: string

    @Column({ type: 'varchar', length: 20 })
    type: MfaFactorType

    /**
     * User-supplied name for the device ("iPhone", "1Password"). Purely for recognition in the
     * account screen — a user with three authenticators needs to know which one to delete.
     */
    @Column({ nullable: true, type: 'varchar', length: 100 })
    label?: string | null

    /**
     * The TOTP shared secret, ENCRYPTED at rest (requirements §9 lists "MFA/TOTP seeds" explicitly).
     *
     * It cannot be hashed: TOTP verification has to recompute HMAC(secret, timestep), which needs
     * the secret back. That is precisely why §9 separates "encrypted" from "hashed" — this value is
     * reversible by design, so it gets a key version and a per-record nonce, while the recovery
     * codes next door get neither.
     *
     * `select: false` for the same reason as `User.credential`: it must take deliberate effort to
     * load, so no incidental `find()` can leak it into a response or a log line (§9: "encrypted
     * values never appear in logs, audit records, API responses, or error messages").
     */
    @Column({ nullable: true, type: 'text', select: false })
    secret?: string | null

    /** Which key material produced `secret` — see EncryptionMetadata.ts for the convention */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_KEY_ID_MAX_LENGTH })
    secretKeyId?: string | null

    /**
     * Rotation watermark (§9). Indexed, so re-encrypting every seed after a key change is a
     * resumable `WHERE "secret" IS NOT NULL AND "secretKeyVersion" < :current` pass.
     */
    @Index()
    @Column({ nullable: true, type: 'int' })
    secretKeyVersion?: number | null

    @Column({ nullable: true, type: 'varchar', length: 32 })
    secretAlgorithm?: EncryptionAlgorithm | null

    /** Base64 AEAD nonce, unique per record and rewritten on every rotation (§9) */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_NONCE_MAX_LENGTH })
    secretNonce?: string | null

    /** Base64 per-record KDF salt (§9: "per-credential salt") */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_NONCE_MAX_LENGTH })
    secretSalt?: string | null

    @Column({ type: 'varchar', length: 20, default: MfaFactorStatus.PENDING })
    status: MfaFactorStatus

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    /** Set when the first correct code is presented; null while the enrolment is unfinished */
    // `type` is explicit because `?: Date | null` serialises to design:type Object, not Date —
    // TypeORM then rejects the column outright ("Data type Object ... is not supported") and the
    // whole identity DataSource fails to initialise. Every other date column here already says so.
    @Column({ type: 'datetime', nullable: true })
    confirmedDate?: Date | null

    /**
     * Refreshed on each successful challenge. Two uses: showing the operator which authenticator is
     * actually in service, and rejecting a replayed code — the service also records the last
     * accepted time-step, but the coarse timestamp is what the account screen renders.
     */
    // `type` is explicit because `?: Date | null` serialises to design:type Object, not Date —
    // TypeORM then rejects the column outright ("Data type Object ... is not supported") and the
    // whole identity DataSource fails to initialise. Every other date column here already says so.
    @Column({ type: 'datetime', nullable: true })
    lastUsedDate?: Date | null

    /**
     * NOTE — no `updatedDate` and no soft-delete flag. A factor is either enrolled or gone;
     * disabling MFA deletes the row (after the re-authentication §8 requires) and the AuditEvent
     * trail is what preserves the fact that it existed.
     */

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User
}
