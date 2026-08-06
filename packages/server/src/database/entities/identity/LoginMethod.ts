/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'
import { EncryptionAlgorithm, ENCRYPTION_KEY_ID_MAX_LENGTH, ENCRYPTION_NONCE_MAX_LENGTH } from './EncryptionMetadata'

/** Provider identifiers, lower-case on the wire in both directions (spec §D.8, §A.9) */
export enum LoginMethodProvider {
    AZURE = 'azure',
    GOOGLE = 'google',
    AUTH0 = 'auth0',
    GITHUB = 'github'
}

/** Compared to the literal `'enable'` by the SSO config screen (spec §A.9) */
export enum LoginMethodStatus {
    ENABLE = 'enable',
    DISABLE = 'disable'
}

/**
 * Identity — LoginMethod (spec §D.8): per-organization, per-provider SSO configuration.
 *
 * SSO is a v1 REQUIREMENT (requirements §7, corrected 2026-08-05 — an earlier draft had it as a
 * non-goal). The SSO client is already Apache-2.0 and shipped, so this table is the server half of
 * a screen that already exists: OAuth2/OIDC authorization-code flow with PKCE, configured per
 * organization, Google first and the other three behind the same interface.
 */
@Entity('identity_login_method')
export class LoginMethod {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /**
     * Nullable: null is the global/default configuration, per the API module's own note (spec §D.8).
     *
     * The (organizationId, name) unique index cannot police the global row — every engine treats
     * NULLs as distinct in a unique index — so "at most one global config per provider" is asserted
     * in the login-method service.
     */
    @Index()
    @Column({ nullable: true, type: 'uuid' })
    organizationId?: string | null

    /**
     * Stored as `name` because the GET response identifies a provider by `name` while the PUT body
     * uses `providerName` (spec §A.9 "naming asymmetry that must be preserved"). The asymmetry is
     * a wire-mapping concern and is handled in the controller, not by carrying two columns.
     */
    @Column({ type: 'varchar', length: 20 })
    name: LoginMethodProvider

    /** Display label: Microsoft | Google | Auth0 | Github */
    @Column({ nullable: true, type: 'varchar', length: 50 })
    providerLabel?: string | null

    @Column({ type: 'varchar', length: 20, default: LoginMethodStatus.DISABLE })
    status: LoginMethodStatus

    /**
     * JSON-encoded NON-SECRET provider config only — `clientID`, and `tenantID` (azure) /
     * `domain` (auth0). Safe to return verbatim.
     */
    @Column({ nullable: true, type: 'text' })
    config?: string | null

    /**
     * The client secret, held in its own column rather than inside `config`, and `select: false`.
     *
     * Two reasons, both spec-driven: (1) `clientSecret` is write-only and must never be returned
     * (spec §D.8) — a separate non-selected column makes leaking it require deliberate effort
     * rather than forgetting to strip a JSON key; (2) it lets the `'********'` "unchanged" sentinel
     * (spec §A.9, §F-14) be handled by simply not writing this column, instead of round-tripping
     * the real secret through the config blob.
     *
     * Stored encrypted at rest by the credential-encryption layer (requirements §1, §9), never
     * plaintext. The five `clientSecret*` columns below carry the per-record key metadata that makes
     * rotation resumable — see EncryptionMetadata.ts for the convention.
     */
    @Column({ nullable: true, type: 'text', select: false })
    clientSecret?: string | null

    /** Which key material produced `clientSecret` (requirements §9) */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_KEY_ID_MAX_LENGTH })
    clientSecretKeyId?: string | null

    /**
     * Rotation watermark (§9: "a key version recorded per record so rotation is resumable and
     * auditable"). Indexed, so the re-encryption pass is
     * `WHERE "clientSecret" IS NOT NULL AND "clientSecretKeyVersion" < :current` — a crash mid-pass
     * costs nothing, because re-running it simply finds the rows that were not yet converted.
     *
     * This is also what makes §7's `'********'` sentinel safe under rotation: an unchanged secret is
     * re-encrypted by the rotation pass without the operator ever re-entering it (§9: "key rotation
     * without re-entering every credential").
     */
    @Index()
    @Column({ nullable: true, type: 'int' })
    clientSecretKeyVersion?: number | null

    @Column({ nullable: true, type: 'varchar', length: 32 })
    clientSecretAlgorithm?: EncryptionAlgorithm | null

    /** Base64 AEAD nonce, unique per record, rewritten on every rotation (§9) */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_NONCE_MAX_LENGTH })
    clientSecretNonce?: string | null

    /** Base64 per-record KDF salt (§9: "per-credential salt") */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_NONCE_MAX_LENGTH })
    clientSecretSalt?: string | null

    /** Who last configured this provider (spec §D.8) */
    @Column({ nullable: true, type: 'uuid' })
    userId?: string | null

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date
}
