/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm'

/** Who acted. Not every actor is a user — requirements §10 needs the trail to cover API keys and the server itself */
export enum AuditSubjectType {
    USER = 'user',
    /** Spec §D.10 — an API key carries its own permission set and acts without a user */
    API_KEY = 'api_key',
    /** Bootstrap, migrations, scheduled jobs, key rotation passes */
    SYSTEM = 'system',
    /** A request that never resolved to a principal — a failed login is the archetype */
    ANONYMOUS = 'anonymous'
}

/** Requirements §10: "outcome (success/failure + reason)". Failures are the highest-value records in the file */
export enum AuditOutcome {
    SUCCESS = 'success',
    FAILURE = 'failure'
}

/**
 * Machine-readable failure reasons for authentication, in the vocabulary of the canonical error
 * strings (spec §0.5). These four are load-bearing: the `identity_login_activity` projection maps
 * them onto activity codes -1 … -4 (spec §D.9), so changing a literal here changes what the shipped
 * login-activity screen renders. See LoginActivity.ts.
 */
export enum AuthFailureReason {
    /** activityCode -1 — no account matched the attempted identifier */
    UNKNOWN_USER = 'unknown_user',
    /** activityCode -2 */
    INCORRECT_CREDENTIAL = 'incorrect_credential',
    /** activityCode -3 */
    USER_DISABLED = 'user_disabled',
    /** activityCode -4 */
    NO_ASSIGNED_WORKSPACE = 'no_assigned_workspace'
}

/**
 * Action vocabulary, `<domain>.<object>.<verb>`, lower-case and dot-separated.
 *
 * Only the actions the SCHEMA depends on are pinned as constants — the login-activity projection
 * filters on `AuditAction.AUTH_LOGIN` / `AUTH_LOGOUT`, so those two literals are part of the
 * contract rather than free-form strings. The rest of the catalog (requirements §10's six domains)
 * lives with the audit service; the column is a plain varchar precisely so a new action never needs
 * a migration.
 */
export const AuditAction = {
    /** Authentication — projected into the login-activity view */
    AUTH_LOGIN: 'auth.login',
    AUTH_LOGOUT: 'auth.logout',
    /** Authentication — full trail only, no legacy activity code exists for these */
    AUTH_MFA_CHALLENGE: 'auth.mfa.challenge',
    AUTH_SESSION_REFRESH: 'auth.session.refresh',
    AUTH_SESSION_REVOKE: 'auth.session.revoke',
    /** Authorization — every permission decision (requirements §4, §10) */
    AUTHZ_PERMISSION_CHECK: 'authz.permission.check',
    /** Credentials — `credential.decrypt` is written on EVERY use, by reference, never by value (§10) */
    CREDENTIAL_DECRYPT: 'credential.decrypt',
    /** Operability — §10: "audit failure is visible … that fact is itself recorded" */
    AUDIT_SINK_UNAVAILABLE: 'audit.sink.unavailable'
} as const

/**
 * Identity — AuditEvent (requirements §10).
 *
 * ONE unified, append-only trail across all six domains §10 enumerates: authentication,
 * authorization decisions, identity administration, credential use, flow/prompt changes, and data
 * access. `LoginActivity` covered only the first of those and only its sign-in half; it survives as
 * a read-only projection over this table (see LoginActivity.ts for that decision).
 *
 * ── Append-only, expressed in the model ──────────────────────────────────────────────────────
 * There is no `updatedDate`, no `@UpdateDateColumn`, no soft-delete column and no `deletedDate`.
 * That is deliberate and is the schema-level half of §10's "no API mutates or deletes audit
 * records": a row has nothing to update, so an UPDATE has nothing to write, and any future field
 * that would need mutating belongs somewhere else. Retention and archival are operator actions
 * performed against the table directly, distinct from ordinary deletion.
 *
 * ── Why the primary key is a sequence and not a uuid ─────────────────────────────────────────
 * Every other entity in this cluster uses a uuid primary key. This one does not, because §10
 * requires "when (UTC, monotonic ordering)" and a timestamp cannot supply it: two events in the
 * same millisecond are unordered, and a clock adjustment can order a later event before an earlier
 * one. An engine-assigned auto-increment is the only ordering that is total, gap-detectable (a
 * missing seqNo is evidence of tampering or of a failed insert) and correct under concurrency.
 *
 * `id` remains a uuid so external references — SIEM exports, cross-links from other tables — are
 * stable and do not leak event volume the way a bare sequence number would.
 *
 * ── Never contains secrets (§10, §9) ─────────────────────────────────────────────────────────
 * `detail` is a JSON blob and the one place where a careless caller could leak a credential value,
 * a token or an MFA seed. The rule §10 states — "recorded by reference, never by value" — is
 * enforced centrally by the audit service's redaction pass, not at each call site (§9: "redaction
 * is enforced centrally"). A `credential.decrypt` event records the credential id, the flow and the
 * node that used it, and nothing about what was decrypted.
 */
@Entity('identity_audit_event')
export class AuditEvent {
    /**
     * Monotonic ordering (§10). Engine-assigned: `INTEGER PRIMARY KEY AUTOINCREMENT` on SQLite,
     * `BIGSERIAL` on Postgres, `BIGINT AUTO_INCREMENT` on MySQL/MariaDB.
     *
     * Typed `string` because the Postgres and MySQL drivers return bigints as strings to avoid
     * silent precision loss above 2^53; the SQLite driver returns a number. Consumers must treat it
     * as an opaque ordering key and not do arithmetic on it.
     */
    // SQLite requires EXACTLY `INTEGER PRIMARY KEY` for AUTOINCREMENT -- `bigint PRIMARY KEY
    // AUTOINCREMENT` is rejected outright, and SQLite is Flowise's default engine. The
    // migrations already emit `integer PRIMARY KEY AUTOINCREMENT`; this decorator previously
    // said bigint, so entity metadata and DDL disagreed. Aligned to the DDL.
    @PrimaryGeneratedColumn()
    seqNo: number

    /**
     * Stable public identifier. Assigned by the audit service (uuid v4) rather than by a column
     * default, so the value is identical on every engine; Postgres additionally carries a
     * server-side default as a backstop for direct inserts.
     */
    @Index({ unique: true })
    @Column({ type: 'uuid' })
    id: string

    // ── WHO ───────────────────────────────────────────────────────────────────────────────────

    @Column({ type: 'varchar', length: 20 })
    subjectType: AuditSubjectType

    /** Null when the subject never resolved — an unknown-user login attempt, or a SYSTEM action */
    @Index()
    @Column({ nullable: true, type: 'uuid' })
    subjectId?: string | null

    /**
     * Human-readable identifier for the subject AS IT WAS AT THE TIME — the attempted email, the
     * API key name. A string and not an FK, for the same reason `LoginActivity.username` was one
     * (spec §D.9): a failed login has no user row to point at, and the attempted identifier is
     * exactly what the operator needs to see. It also keeps the record legible after the referenced
     * user is deleted, which an append-only trail requires.
     */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    subjectLabel?: string | null

    /** Ties the event to the session it happened under, so a revoke can be traced to everything it did */
    @Index()
    @Column({ nullable: true, type: 'uuid' })
    sessionId?: string | null

    // ── WHAT ──────────────────────────────────────────────────────────────────────────────────

    /** `<domain>.<object>.<verb>` — see {@link AuditAction} */
    @Column({ type: 'varchar', length: 100 })
    action: string

    /** `user` | `role` | `workspace` | `credential` | `chatflow` | `login_method` | … */
    @Column({ nullable: true, type: 'varchar', length: 50 })
    targetType?: string | null

    /**
     * Varchar rather than uuid: not every target has one. A permission decision targets a
     * permission KEY (`chatflows:update`), and an `auth.login` event targets the login method used
     * — `local`, or the provider name for SSO, which is what the login-activity projection reads
     * back as `loginMode` (spec §D.9).
     */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    targetId?: string | null

    // ── WHEN ──────────────────────────────────────────────────────────────────────────────────

    /**
     * UTC instant of the event (§10). Ordering ties are broken by `seqNo`, never by this column.
     * Indexed on its own for range scans, and jointly with `action` for the login-activity view.
     */
    @Index()
    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    occurredAt: Date

    // ── WHERE ─────────────────────────────────────────────────────────────────────────────────

    /** Sized for a full IPv6 literal including an IPv4-mapped suffix */
    @Column({ nullable: true, type: 'varchar', length: 45 })
    ipAddress?: string | null

    @Column({ nullable: true, type: 'text' })
    userAgent?: string | null

    /** The matched route pattern (`PUT /role/:id`), not the raw URL — raw URLs carry query-string secrets */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    route?: string | null

    // ── SCOPE ─────────────────────────────────────────────────────────────────────────────────

    @Index()
    @Column({ nullable: true, type: 'uuid' })
    organizationId?: string | null

    /**
     * Nullable: authentication happens before a workspace is resolved, and organization-level
     * administration is not workspace-scoped. Present for everything that passed through a
     * workspace-scoped route, which is what makes "what happened in this workspace" answerable
     * (spec §C.5).
     */
    @Index()
    @Column({ nullable: true, type: 'uuid' })
    workspaceId?: string | null

    // ── OUTCOME ───────────────────────────────────────────────────────────────────────────────

    @Column({ type: 'varchar', length: 16 })
    outcome: AuditOutcome

    /**
     * Machine-readable reason code — snake_case, stable, safe to switch on. For authentication
     * failures it is one of {@link AuthFailureReason}; for a denied permission it is the deny
     * reason (`missing_permission`, `unknown_permission`, `wrong_workspace`).
     *
     * Separate from `message` on purpose: the code is a contract (the login-activity projection
     * maps it to an integer), the message is prose and may be reworded freely.
     */
    @Column({ nullable: true, type: 'varchar', length: 64 })
    reason?: string | null

    /** Human-readable one-line summary. Rendered directly by the login-activity screen (spec §D.9) */
    @Column({ nullable: true, type: 'text' })
    message?: string | null

    // ── DETAIL ────────────────────────────────────────────────────────────────────────────────

    /**
     * JSON-encoded, action-specific context. NEVER secrets (§10) — the redaction pass in the audit
     * service drops any key matching the secret-name denylist before this is written, so leaking
     * requires defeating one central control rather than remembering at 200 call sites.
     *
     * Examples: a role change carries the PERMISSION DELTA (§10 names it explicitly:
     * `{ added: [...], removed: [...] }`); a `credential.decrypt` carries `{ flowId, nodeId }`; a
     * data export carries `{ format, rowCount }`.
     *
     * Text rather than a native JSON column: the four supported engines disagree on JSON types and
     * on how they compare, and nothing queries inside this blob — the indexed columns above exist
     * so that no query ever has to.
     */
    @Column({ nullable: true, type: 'text' })
    detail?: string | null

    /**
     * Git commit that captured the corresponding flow/prompt change (REQUIREMENTS-VERSIONING.md),
     * so §10's "flows and prompts … cross-referenced to the version commit" is a join and not a
     * timestamp correlation. 64 chars covers a 40-hex SHA-1 and a future SHA-256 object id.
     */
    @Column({ nullable: true, type: 'varchar', length: 64 })
    versionCommitId?: string | null

    /**
     * NOTE — deliberately absent: `updatedDate`, `updatedBy`, `deletedDate`, and any status column.
     * See the append-only note in the class doc.
     */
}
