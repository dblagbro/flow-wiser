import { DataSource, Repository } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { AuditAction, AuditEvent, AuditOutcome, AuditSubjectType, AuthFailureReason } from '../../database/entities/identity/AuditEvent'
import { SessionRevokeReason } from '../../database/entities/identity/Session'
import logger, { auditLogger } from '../../utils/logger'
import { redact } from '../crypto/redaction'

/**
 * Identity — AuditService (requirements §10 "Audit — who did what, when").
 *
 * ONE append-only trail across §10's six domains. The service only ever INSERTs: there is no
 * update, no delete and no soft-delete path anywhere in this file, which is the service-level half
 * of §10's "no API mutates or deletes audit records" (AuditEvent.ts holds the schema-level half —
 * the row has no mutable columns to write).
 *
 * Three properties are load-bearing:
 *
 *  1. **Never contains secrets.** `detail` goes through `redact()` before it is serialised, so
 *     leaking requires defeating one central control rather than remembering at every call site
 *     (§9: "redaction is enforced centrally, not per call site").
 *  2. **Never fails the caller.** An audit write is not permitted to turn a successful request into
 *     a failed one, so `record()` swallows everything.
 *  3. **...but the failure is never silent.** §10: "If the audit sink is unavailable, that fact is
 *     itself recorded and surfaced — silently losing the trail is worse than losing the request."
 *     So a swallowed failure increments a process counter that a health endpoint reads
 *     (`getAuditHealth()`, §6 "health endpoint reporting auth subsystem state") and is written to
 *     the winston audit stream under `audit.sink.unavailable`.
 */

/**
 * Actions beyond the handful the schema itself depends on.
 *
 * AuditEvent.ts pins only `auth.login` / `auth.logout` (the login-activity projection filters on
 * them) and states that "the rest of the catalog lives with the audit service; the column is a
 * plain varchar precisely so a new action never needs a migration". This is that catalog.
 */
export const IdentityAuditAction = {
    ...AuditAction,
    /** Credential VALUE disclosed to a human — the `credentials:reveal` grant in tenancy §2, which only admin/super-admin hold. */
    CREDENTIAL_REVEAL: 'credential.reveal',
    /** An actor tried to act outside its own tenant. Tenancy §3 requires the refusal be audited, "not silently ignored". */
    TENANCY_CROSS_TENANT_ATTEMPT: 'tenancy.cross_tenant.attempt'
} as const

/** Deny reason for a refused cross-tenant action (tenancy §3, §4 "audited as a cross-tenant failure"). */
export const CROSS_TENANT_DENIED = 'cross_tenant_denied'

export interface AuditSubject {
    type: AuditSubjectType
    /** Null for an unresolved principal — a failed login against an unknown address is the archetype. */
    id?: string | null
    /** The identifier AS ATTEMPTED: the email typed at the login form, the API key name. */
    label?: string | null
    sessionId?: string | null
}

export interface AuditTarget {
    /** `user` | `role` | `workspace` | `credential` | `chatflow` | `login_method` | … */
    type?: string | null
    /** Not always a uuid: a permission decision targets a permission KEY such as `chatflows:update`. */
    id?: string | null
}

/**
 * WHICH SCOPE the event happened in (§10, and the tenancy access matrix in
 * REQUIREMENTS-TENANCY-ACCESS.md §2).
 *
 * This is not decoration. The matrix grants `org-admin` "Audit log: R (own org)", so the reader's
 * organization is a filter on this column — an event written without an `organizationId` is one
 * that an org-scoped reader can never see. Authentication legitimately has none (it happens before
 * a workspace, and often before an organization, is resolved); everything routed through a
 * tenant-scoped route should carry both.
 */
export interface AuditScope {
    organizationId?: string | null
    workspaceId?: string | null
}

export interface AuditRecordInput {
    /** `<domain>.<object>.<verb>` — see {@link IdentityAuditAction}. */
    action: string
    outcome: AuditOutcome
    subject: AuditSubject
    target?: AuditTarget
    scope?: AuditScope
    /** The matched route PATTERN (`PUT /role/:id`), never the raw URL — raw URLs carry query-string secrets. */
    route?: string | null
    /** Action-specific context. Redacted before it is written; see the class doc. */
    detail?: unknown
    /** Machine-readable, stable, safe to switch on. The login-activity projection maps it to an integer. */
    reason?: string | null
    /** Prose. Reworded freely — unlike `reason`, nothing parses it. */
    message?: string | null
    ipAddress?: string | null
    userAgent?: string | null
    /** Cross-reference to the version commit for flow/prompt changes (REQUIREMENTS-VERSIONING.md). */
    versionCommitId?: string | null
}

/** What a health endpoint needs to answer "is the trail intact?" (§6, §10). */
export interface AuditHealth {
    healthy: boolean
    /** Writes lost since process start. Non-zero means the trail has holes and should be investigated. */
    failures: number
    lastFailureAt: Date | null
    lastError: string | null
}

/**
 * Process-wide, deliberately module-level rather than per-instance: a health endpoint must be able
 * to read this without holding a reference to whichever service instance did the failing write.
 */
const sinkFailures = { count: 0, lastFailureAt: null as Date | null, lastError: null as string | null }

export const getAuditHealth = (): AuditHealth => ({
    healthy: sinkFailures.count === 0,
    failures: sinkFailures.count,
    lastFailureAt: sinkFailures.lastFailureAt,
    lastError: sinkFailures.lastError
})

/** Test/operator hook. Clears the counter only — it cannot and does not touch persisted events. */
export const resetAuditHealth = (): void => {
    sinkFailures.count = 0
    sinkFailures.lastFailureAt = null
    sinkFailures.lastError = null
}

export interface AuditQuery {
    /** Subject id — "who". */
    actor?: string
    subjectType?: AuditSubjectType
    action?: string | string[]
    targetType?: string
    targetId?: string
    outcome?: AuditOutcome
    /** The org-scoped reader's filter (tenancy §2: `org-admin` reads its own org only). */
    organizationId?: string
    workspaceId?: string
    sessionId?: string
    from?: Date
    to?: Date
    limit?: number
    /** `seqNo` of the last row of the previous page. Keyset pagination — see {@link AuditService.query}. */
    cursor?: string
}

export interface AuditQueryResult {
    events: AuditEvent[]
    /** Pass back as `cursor` for the next page; null when the last page has been reached. */
    nextCursor: string | null
}

const DEFAULT_QUERY_LIMIT = 50
const MAX_QUERY_LIMIT = 500

export interface AuditServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    /**
     * Override the redaction pass. Exists for tests only — there is intentionally NO fallback if
     * `crypto/redaction` is unavailable, because a silently weaker redactor is a worse outcome than
     * a loud import failure (§9).
     */
    redactor?: <T>(value: T) => T
}

export class AuditService {
    private readonly injectedDataSource?: DataSource
    private readonly redactor: <T>(value: T) => T

    constructor(options: AuditServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.redactor = options.redactor ?? redact
    }

    /** Lazy `require` for the same reason SessionService uses one: a static import would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    private repo(): Repository<AuditEvent> {
        return this.getDataSource().getRepository(AuditEvent)
    }

    /**
     * Redact, then serialise. Both halves can fail on hostile input, and neither is allowed to
     * propagate: a circular or unserialisable `detail` must cost the DETAIL, never the EVENT.
     */
    private serialiseDetail(detail: unknown): string | null {
        if (detail === undefined || detail === null) return null
        try {
            return JSON.stringify(this.redactor(detail))
        } catch (error) {
            logger.warn(`[AuditService] detail could not be serialised, recording a placeholder: ${getMessage(error)}`)
            return JSON.stringify({ _unserialisable: true })
        }
    }

    /**
     * Append one event. Returns the assigned ids, or null when the sink failed.
     *
     * NEVER THROWS. The audit write is downstream of the thing being audited, and failing the
     * caller would mean a broken log could deny service.
     */
    async record(input: AuditRecordInput): Promise<{ id: string; seqNo: string } | null> {
        // uuid assigned here rather than by a column default so the value is identical on every
        // engine (AuditEvent.ts). Computed before the try so it can be reported in a failure log.
        const id = uuidv4()
        let serialisedDetail: string | null = null
        try {
            serialisedDetail = this.serialiseDetail(input.detail)

            const event = this.repo().create({
                id,
                subjectType: input.subject.type,
                subjectId: input.subject.id ?? null,
                subjectLabel: input.subject.label ?? null,
                sessionId: input.subject.sessionId ?? null,
                action: input.action,
                targetType: input.target?.type ?? null,
                targetId: input.target?.id ?? null,
                occurredAt: new Date(),
                ipAddress: input.ipAddress ?? null,
                userAgent: input.userAgent ?? null,
                route: input.route ?? null,
                organizationId: input.scope?.organizationId ?? null,
                workspaceId: input.scope?.workspaceId ?? null,
                outcome: input.outcome,
                reason: input.reason ?? null,
                message: input.message ?? null,
                detail: serialisedDetail,
                versionCommitId: input.versionCommitId ?? null
            })

            const saved = await this.repo().save(event)

            // Mirror to the winston audit stream AFTER the durable write. §10 requires the trail be
            // "structured and exportable (JSON lines) so it can ship to an external SIEM, since an
            // audit log that only lives on the compromised host has limited forensic value" — the
            // existing auditLogger already emits JSON, so shipping is a transport change, not a
            // code change. Only the already-redacted detail is mirrored.
            auditLogger.info({ ...auditLogPayload(saved), seqNo: saved.seqNo })

            return { id: saved.id, seqNo: saved.seqNo }
        } catch (error) {
            this.reportSinkFailure(input, id, serialisedDetail, error)
            return null
        }
    }

    /**
     * §10: "Audit failure is visible. If the audit sink is unavailable, that fact is itself recorded
     * and surfaced."
     *
     * "Recorded" cannot mean another row — the table is the thing that just failed, and a retry
     * would most likely fail identically while adding latency to the caller's request. So the
     * failure is recorded in the two places that do not depend on the database: the error log
     * (operator-visible) and the JSON audit stream under `audit.sink.unavailable` (SIEM-visible,
     * carrying the event that was lost so it can be reconstructed). "Surfaced" is the counter,
     * which `getAuditHealth()` exposes to the health endpoint.
     */
    private reportSinkFailure(input: AuditRecordInput, id: string, serialisedDetail: string | null, error: unknown): void {
        sinkFailures.count += 1
        sinkFailures.lastFailureAt = new Date()
        sinkFailures.lastError = getMessage(error)

        try {
            logger.error(
                `[AuditService] AUDIT SINK UNAVAILABLE — event ${id} (${input.action}/${input.outcome}) was NOT persisted: ${getMessage(
                    error
                )}`
            )
            auditLogger.error({
                action: IdentityAuditAction.AUDIT_SINK_UNAVAILABLE,
                outcome: AuditOutcome.FAILURE,
                reason: 'sink_unavailable',
                occurredAt: new Date().toISOString(),
                failures: sinkFailures.count,
                error: getMessage(error),
                // The lost event, so the trail can be reconstructed from the log stream. Detail is
                // the already-redacted string, never the caller's raw object.
                lostEvent: {
                    id,
                    action: input.action,
                    outcome: input.outcome,
                    subjectType: input.subject.type,
                    subjectId: input.subject.id ?? null,
                    subjectLabel: input.subject.label ?? null,
                    sessionId: input.subject.sessionId ?? null,
                    targetType: input.target?.type ?? null,
                    targetId: input.target?.id ?? null,
                    organizationId: input.scope?.organizationId ?? null,
                    workspaceId: input.scope?.workspaceId ?? null,
                    route: input.route ?? null,
                    reason: input.reason ?? null,
                    detail: serialisedDetail
                }
            })
        } catch {
            // The logger itself is down. The counter above is already incremented, so the health
            // endpoint still reports the hole; there is nowhere left to write to.
        }
    }

    // ── Typed helpers ─────────────────────────────────────────────────────────────────────────
    // §10's highest-value events. They exist so the common call sites cannot get the subject type,
    // the outcome or the action string wrong, and so "failures are audited as loudly as successes"
    // is the path of least resistance rather than a thing to remember.

    /** `auth.login` success. Projected into the login-activity view (spec §D.9), so the action literal is contractual. */
    async loginSuccess(input: {
        userId: string
        email: string
        sessionId: string
        /** `local`, or the SSO provider name — this is what the projection reads back as `loginMode`. */
        loginMethod: string
        scope?: AuditScope
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
        detail?: unknown
    }) {
        return this.record({
            action: IdentityAuditAction.AUTH_LOGIN,
            outcome: AuditOutcome.SUCCESS,
            subject: { type: AuditSubjectType.USER, id: input.userId, label: input.email, sessionId: input.sessionId },
            target: { type: 'login_method', id: input.loginMethod },
            scope: input.scope,
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            detail: input.detail,
            message: `Login succeeded for ${input.email}`
        })
    }

    /**
     * `auth.login` failure.
     *
     * The subject is ANONYMOUS with a null id whenever the attempt never resolved to a user, which
     * is exactly why `subjectLabel` is a string and not an FK (AuditEvent.ts): the attempted
     * address is what the operator needs to see, and there is no row to point at.
     */
    async loginFailure(input: {
        email: string
        reason: AuthFailureReason
        /** Present only when the account exists but the attempt still failed — wrong password, disabled account. */
        userId?: string | null
        loginMethod?: string
        scope?: AuditScope
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
        detail?: unknown
    }) {
        return this.record({
            action: IdentityAuditAction.AUTH_LOGIN,
            outcome: AuditOutcome.FAILURE,
            subject: {
                type: input.userId ? AuditSubjectType.USER : AuditSubjectType.ANONYMOUS,
                id: input.userId ?? null,
                label: input.email
            },
            target: { type: 'login_method', id: input.loginMethod ?? 'local' },
            scope: input.scope,
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            reason: input.reason,
            detail: input.detail,
            message: `Login failed for ${input.email} (${input.reason})`
        })
    }

    async logout(input: {
        userId: string
        email?: string | null
        sessionId: string
        scope?: AuditScope
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
    }) {
        return this.record({
            action: IdentityAuditAction.AUTH_LOGOUT,
            outcome: AuditOutcome.SUCCESS,
            subject: { type: AuditSubjectType.USER, id: input.userId, label: input.email ?? null, sessionId: input.sessionId },
            target: { type: 'session', id: input.sessionId },
            scope: input.scope,
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent
        })
    }

    /**
     * `auth.session.revoke`.
     *
     * `actorId` is separate from `userId` on purpose: an administrator revoking someone else's
     * session and a user logging out of their own device are the same action with different
     * subjects, and only recording the session owner would lose the administrator. A revoke caused
     * by the system (credential change, privilege change) has no actor at all — hence the SYSTEM
     * subject type.
     */
    async sessionRevoked(input: {
        userId: string
        sessionId?: string | null
        reason: SessionRevokeReason
        /** Who performed it. Omit for a system-driven revoke. */
        actorId?: string | null
        actorLabel?: string | null
        /** Set when this was a bulk revoke, so the count is in the trail. */
        revokedCount?: number
        scope?: AuditScope
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
    }) {
        const systemDriven = !input.actorId
        return this.record({
            action: IdentityAuditAction.AUTH_SESSION_REVOKE,
            outcome: AuditOutcome.SUCCESS,
            subject: {
                type: systemDriven ? AuditSubjectType.SYSTEM : AuditSubjectType.USER,
                id: input.actorId ?? null,
                label: input.actorLabel ?? null,
                sessionId: input.sessionId ?? null
            },
            target: { type: 'session', id: input.sessionId ?? input.userId },
            scope: input.scope,
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            reason: input.reason,
            detail: { userId: input.userId, revokedCount: input.revokedCount ?? 1 },
            message: `Revoked ${input.revokedCount ?? 1} session(s) for user ${input.userId} (${input.reason})`
        })
    }

    /**
     * `authz.permission.check` — deny only.
     *
     * §10 requires "every permission decision" be recorded, but only the denials go through this
     * helper: allows are the overwhelming majority of checks and writing a row per allowed request
     * would make the table's growth a function of traffic rather than of activity. Denials are what
     * §10 calls "the highest-value records in the file". A deployment that wants allows too can
     * call `record()` directly with the same action.
     */
    async permissionDenied(input: {
        /** Null for an unauthenticated request — the deny reason distinguishes the two cases. */
        subjectId?: string | null
        subjectLabel?: string | null
        subjectType?: AuditSubjectType
        sessionId?: string | null
        /** The permission expression as written at the call site, e.g. `chatflows:update`. */
        permission: string
        /** Deny reason from the RBAC layer: `permission-not-granted`, `no-active-workspace`, `internal-error`, … */
        reason: string
        scope?: AuditScope
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
        detail?: unknown
    }) {
        return this.record({
            action: IdentityAuditAction.AUTHZ_PERMISSION_CHECK,
            outcome: AuditOutcome.FAILURE,
            subject: {
                type: input.subjectType ?? (input.subjectId ? AuditSubjectType.USER : AuditSubjectType.ANONYMOUS),
                id: input.subjectId ?? null,
                label: input.subjectLabel ?? null,
                sessionId: input.sessionId ?? null
            },
            // The target of a permission decision is the permission KEY, not a row id — which is why
            // AuditEvent.targetId is a varchar (AuditEvent.ts).
            target: { type: 'permission', id: input.permission },
            scope: input.scope,
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            reason: input.reason,
            detail: input.detail,
            message: `Denied ${input.permission} (${input.reason})`
        })
    }

    /**
     * `credential.reveal` — a credential VALUE was disclosed to a human.
     *
     * Distinct from `credential.decrypt`, which is written on every USE by a running flow. Tenancy
     * §2 makes reveal a grant that only `admin` and `super-admin` hold, so it is a materially
     * different event from a flow decrypting a credential to call an API, and conflating the two
     * would bury the rare high-consequence event under the routine one.
     *
     * Records the credential BY REFERENCE. §10: "never by value" — there is no parameter here that
     * could carry the plaintext, which is stronger than relying on redaction to remove it.
     */
    async credentialRevealed(input: {
        actorId: string
        actorLabel?: string | null
        sessionId?: string | null
        credentialId: string
        credentialName?: string
        scope?: AuditScope
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
    }) {
        return this.record({
            action: IdentityAuditAction.CREDENTIAL_REVEAL,
            outcome: AuditOutcome.SUCCESS,
            subject: {
                type: AuditSubjectType.USER,
                id: input.actorId,
                label: input.actorLabel ?? null,
                sessionId: input.sessionId ?? null
            },
            target: { type: 'credential', id: input.credentialId },
            scope: input.scope,
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            detail: { credentialName: input.credentialName },
            message: `Credential value revealed: ${input.credentialName ?? input.credentialId}`
        })
    }

    /**
     * `tenancy.cross_tenant.attempt` — an actor tried to act outside its own tenant.
     *
     * Tenancy §3/§4 require the refusal be "audited as a cross-tenant failure, not silently
     * ignored". Both organization ids are recorded: `scope.organizationId` is where the actor
     * legitimately belongs, `detail.attemptedOrganizationId` is where it reached. Recording only
     * the target would make the event unattributable; recording only the actor's own would make it
     * look like an ordinary denial.
     */
    async crossTenantAttempt(input: {
        actorId?: string | null
        actorLabel?: string | null
        sessionId?: string | null
        /** The tenant the actor administers / belongs to. */
        actorOrganizationId?: string | null
        /** The tenant it tried to reach. */
        attemptedOrganizationId: string
        /** What it tried to do — `registration.approve`, `tenancy.move`, `chatflow.update`, … */
        operation: string
        targetType?: string
        targetId?: string
        route?: string | null
        ipAddress?: string | null
        userAgent?: string | null
        detail?: Record<string, unknown>
    }) {
        return this.record({
            action: IdentityAuditAction.TENANCY_CROSS_TENANT_ATTEMPT,
            outcome: AuditOutcome.FAILURE,
            subject: {
                type: input.actorId ? AuditSubjectType.USER : AuditSubjectType.ANONYMOUS,
                id: input.actorId ?? null,
                label: input.actorLabel ?? null,
                sessionId: input.sessionId ?? null
            },
            target: { type: input.targetType ?? 'organization', id: input.targetId ?? input.attemptedOrganizationId },
            scope: { organizationId: input.actorOrganizationId ?? null },
            route: input.route,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            reason: CROSS_TENANT_DENIED,
            detail: { ...input.detail, operation: input.operation, attemptedOrganizationId: input.attemptedOrganizationId },
            message: `Cross-tenant ${input.operation} refused: actor org ${input.actorOrganizationId ?? 'none'} → ${
                input.attemptedOrganizationId
            }`
        })
    }

    // ── Read side ─────────────────────────────────────────────────────────────────────────────

    /**
     * Query the trail for the audit-log UI (§10 "Queryable in the UI"; the Apache-2.0
     * `views/auth/loginActivity.jsx` is the surface being extended).
     *
     * Ordered by `seqNo` DESC — newest first. `seqNo` and not `occurredAt`, because AuditEvent.ts
     * establishes it as the only TOTAL ordering: two events in the same millisecond are unordered
     * by timestamp, and a clock adjustment can invert them. Time is a filter here, never the sort.
     *
     * Pagination is keyset, not OFFSET: `seqNo < cursor` gives a stable page even while rows are
     * being appended, whereas OFFSET would re-show or skip rows as the head grows. `seqNo` is
     * compared as a NUMBER — the drivers return bigints as strings to avoid precision loss, so a
     * string comparison would order '9' after '10'.
     */
    async query(filter: AuditQuery = {}): Promise<AuditQueryResult> {
        const limit = Math.min(Math.max(filter.limit ?? DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT)
        const qb = this.repo().createQueryBuilder('event')

        if (filter.actor) qb.andWhere('event.subjectId = :actor', { actor: filter.actor })
        if (filter.subjectType) qb.andWhere('event.subjectType = :subjectType', { subjectType: filter.subjectType })
        if (filter.action) {
            const actions = Array.isArray(filter.action) ? filter.action : [filter.action]
            qb.andWhere('event.action IN (:...actions)', { actions })
        }
        if (filter.targetType) qb.andWhere('event.targetType = :targetType', { targetType: filter.targetType })
        if (filter.targetId) qb.andWhere('event.targetId = :targetId', { targetId: filter.targetId })
        if (filter.outcome) qb.andWhere('event.outcome = :outcome', { outcome: filter.outcome })
        // Tenancy §2: an org-scoped reader passes its own organizationId and sees nothing else.
        if (filter.organizationId) qb.andWhere('event.organizationId = :organizationId', { organizationId: filter.organizationId })
        if (filter.workspaceId) qb.andWhere('event.workspaceId = :workspaceId', { workspaceId: filter.workspaceId })
        if (filter.sessionId) qb.andWhere('event.sessionId = :sessionId', { sessionId: filter.sessionId })
        if (filter.from) qb.andWhere('event.occurredAt >= :from', { from: filter.from })
        if (filter.to) qb.andWhere('event.occurredAt <= :to', { to: filter.to })
        if (filter.cursor) qb.andWhere('event.seqNo < :cursor', { cursor: filter.cursor })

        // limit + 1 so "is there another page?" is answered without a second COUNT query.
        const rows = await qb
            .orderBy('event.seqNo', 'DESC')
            .take(limit + 1)
            .getMany()
        const events = rows.slice(0, limit)
        const nextCursor = rows.length > limit ? String(events[events.length - 1].seqNo) : null

        return { events, nextCursor }
    }

    /** Single event by its stable public uuid — for SIEM cross-links, which must not depend on `seqNo`. */
    async findById(id: string): Promise<AuditEvent | null> {
        return this.repo().findOne({ where: { id } })
    }
}

/** Flat JSON-lines shape for the SIEM stream. Detail is passed through already redacted and already serialised. */
const auditLogPayload = (event: AuditEvent) => ({
    id: event.id,
    action: event.action,
    outcome: event.outcome,
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
    subjectType: event.subjectType,
    subjectId: event.subjectId ?? null,
    subjectLabel: event.subjectLabel ?? null,
    sessionId: event.sessionId ?? null,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    organizationId: event.organizationId ?? null,
    workspaceId: event.workspaceId ?? null,
    route: event.route ?? null,
    ipAddress: event.ipAddress ?? null,
    reason: event.reason ?? null,
    message: event.message ?? null,
    detail: event.detail ?? null,
    versionCommitId: event.versionCommitId ?? null
})

const getMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
