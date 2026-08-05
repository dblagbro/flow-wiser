/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'

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
 * SSO itself is a v1 non-goal (requirements "Non-goals" — designed for, shipped later); the entity
 * ships now so `GET /loginmethod/default` can answer honestly (an empty provider list) without a
 * later schema migration.
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
     * Stored encrypted at rest by the credential-encryption layer (requirements §1), never plaintext.
     */
    @Column({ nullable: true, type: 'text', select: false })
    clientSecret?: string | null

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
