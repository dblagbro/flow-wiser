/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm'

/**
 * The organization-wide half of the MFA enforcement policy (requirements §8:
 * "off / optional / required-per-role / required-org-wide").
 *
 * ── WHERE THE POLICY LIVES, AND WHY ──────────────────────────────────────────────────────────
 * §8's four modes are not four values of one setting — they are two independent axes, so they are
 * modelled as two columns in two places:
 *
 *   this enum, on Organization  →  off | optional | required-org-wide
 *   `Role.requiresMfa` (boolean) →  the required-per-role axis
 *
 *   §8 mode              | Organization.mfaPolicy | Role.requiresMfa
 *   ---------------------|------------------------|------------------------------
 *   off                  | off                    | ignored
 *   optional             | optional               | false on every role
 *   required-per-role    | optional               | true on the roles that need it
 *   required-org-wide    | required               | ignored
 *
 * Effective requirement for a user = `mfaPolicy === required` OR any role they hold in any
 * workspace of the organization has `requiresMfa`. Evaluated after primary auth and before a
 * session is issued (§8), and recorded on the session as `Session.mfaSatisfied`.
 *
 * Splitting it this way rather than putting everything on one entity is forced by what each axis
 * refers to. "Required for administrators" is a statement ABOUT A ROLE; expressing it on the
 * Organization would need a list of role ids in a column, which no engine can keep referentially
 * honest and which would silently rot as roles are renamed or deleted. Conversely "required for
 * everyone" is a statement about the TENANT; expressing it as a boolean on every role would have to
 * be re-applied to each newly created role, so a role added after the policy was set would quietly
 * be exempt — a policy that fails open, which is the one outcome §8 cannot tolerate.
 *
 * Roles are organization-scoped (spec §D.5), so the per-role flag cannot leak authority across
 * organizations, and the two axes compose without a third table.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export enum MfaPolicy {
    /** Enrolment is disabled outright; existing factors are not challenged */
    OFF = 'off',
    /** Users may enrol; only those who did are challenged (the default) */
    OPTIONAL = 'optional',
    /** Every member must hold a confirmed factor — enrolment is forced before a session is issued */
    REQUIRED = 'required'
}

/**
 * Identity — Organization (spec §D.2).
 *
 * Multi-org tenancy is a v1 non-goal (requirements "Non-goals"); the entity exists because
 * `organizationId` is a mandatory query parameter on /role, /organizationuser, /workspace and
 * /loginmethod, and because roles are organization-scoped (spec §D.5).
 */
@Entity('identity_organization')
export class Organization {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /**
     * Supplied at first-run setup. Spec §F-8 records that the shipped breadcrumb ignores this and
     * derives `"<owner>'s Organization"` instead. Decision: keep the stored name authoritative and
     * return it; the derived label is the fallback when this is null.
     */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    name?: string | null

    /** Billing identifiers are carried for payload compatibility only — Flow-Wiser gates nothing on them */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    subscriptionId?: string | null

    @Column({ nullable: true, type: 'varchar', length: 255 })
    customerId?: string | null

    /**
     * Organization-wide MFA enforcement (requirements §8) — see {@link MfaPolicy} for the full
     * policy model and why the per-role axis lives on Role instead.
     *
     * Defaults to `optional` rather than `off`: `off` disables enrolment entirely, so a fresh
     * organization would start out unable to turn MFA on for a single user without an
     * administrator first changing a setting they have no reason to know exists.
     */
    @Column({ type: 'varchar', length: 20, default: MfaPolicy.OPTIONAL })
    mfaPolicy: MfaPolicy

    @Column({ nullable: true, type: 'uuid' })
    createdBy?: string | null

    @Column({ nullable: true, type: 'uuid' })
    updatedBy?: string | null

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date
}
