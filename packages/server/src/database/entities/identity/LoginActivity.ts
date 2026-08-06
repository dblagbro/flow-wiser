/* eslint-disable */
import { ViewEntity, ViewColumn } from 'typeorm'

/**
 * Activity codes consumed by the login-activity screen (spec §D.9, §A.10). The negative codes map
 * 1:1 onto the canonical error strings in spec §0.5, which is how a FAILED login is recorded —
 * failures must be written, not only successes.
 *
 * Note `-99` ("Unknown Activity" in the filter UI) is never stored; the query layer treats it as
 * "no match" (spec §A.10). The projection below cannot emit it either: its WHERE clause admits only
 * the six shapes that map to a defined code.
 */
export enum LoginActivityCode {
    LOGIN_SUCCESS = 0,
    LOGOUT_SUCCESS = 1,
    UNKNOWN_USER = -1,
    INCORRECT_CREDENTIAL = -2,
    USER_DISABLED = -3,
    NO_ASSIGNED_WORKSPACE = -4
}

/**
 * Identity — LoginActivity (spec §D.9): the sign-in audit view.
 *
 * ── DECISION: superseded as a table, retained as a PROJECTION ────────────────────────────────
 * This was a base table. It is now a read-only SQL VIEW over `identity_audit_event`.
 *
 * Requirements §10 asks for "ONE unified, queryable audit trail" and names sign-ins as one domain
 * within it. Keeping a second physical table for that one domain would mean two write paths for the
 * same fact, which drift the first time a caller remembers one and forgets the other — and the
 * records most likely to be forgotten are the failures, which §10 calls "the highest-value records
 * in the file". A view has exactly one write path by construction.
 *
 * The alternative — deleting the entity outright and rewriting `POST /audit/login-activity` against
 * AuditEvent — was rejected because the shipped Apache-2.0 screen
 * (`packages/ui/src/views/auth/loginActivity.jsx`) consumes five specific field names and an integer
 * code vocabulary (spec §D.9). Expressing that mapping once, in DDL, keeps the §A.10 endpoint a
 * plain paginated read and honours §10's instruction to "extend it to the wider trail rather than
 * building a new one": the same screen widens to the full trail later by querying AuditEvent
 * directly, with this view keeping the narrow sign-in tab working meanwhile.
 *
 * Consequences, all intended:
 *   - The view is not writable. Sign-in events are written as AuditEvents; nothing inserts here.
 *   - Filters still push down to the base table's indexes — all four engines inline a view this
 *     simple — so `(action, occurredAt)` serves the date-range and code filters of §A.10.
 *   - Ordering is `occurredAt DESC, seqNo DESC`. Offset pagination over a timestamp alone is
 *     unstable when events share a millisecond; the sequence breaks the tie (§10 "monotonic
 *     ordering").
 *   - MFA challenge outcomes, session refreshes and revocations are auth events with no legacy
 *     activity code, so they are visible in the full trail and deliberately NOT in this view.
 *
 * The `expression` below is the ANSI-quoted reference form. The executable DDL lives in the
 * per-engine migrations (`1780000000002-AddIdentityMfaAuditTables`), which own quoting; TypeORM
 * never creates this view itself (`synchronize: false` on every driver).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
@ViewEntity({
    name: 'identity_login_activity',
    expression: `
        SELECT
            "id" AS "id",
            "seqNo" AS "seqNo",
            COALESCE("subjectLabel", '') AS "username",
            CASE
                WHEN "action" = 'auth.logout' THEN 1
                WHEN "outcome" = 'success' THEN 0
                WHEN "reason" = 'unknown_user' THEN -1
                WHEN "reason" = 'incorrect_credential' THEN -2
                WHEN "reason" = 'user_disabled' THEN -3
                ELSE -4
            END AS "activityCode",
            "occurredAt" AS "attemptedDateTime",
            CASE WHEN "targetId" = 'local' THEN NULL ELSE "targetId" END AS "loginMode",
            "message" AS "message",
            "ipAddress" AS "ipAddress",
            "userAgent" AS "userAgent",
            "subjectId" AS "userId",
            "sessionId" AS "sessionId"
        FROM "identity_audit_event"
        WHERE "action" IN ('auth.login', 'auth.logout')
          AND (
                "action" = 'auth.logout'
             OR "outcome" = 'success'
             OR "reason" IN ('unknown_user', 'incorrect_credential', 'user_disabled', 'no_assigned_workspace')
          )
    `
})
export class LoginActivity {
    /** The AuditEvent's stable public uuid — the same row, seen through the legacy shape */
    @ViewColumn()
    id: string

    /** Tie-breaker for offset pagination; not part of the §D.9 wire contract and not rendered */
    @ViewColumn()
    seqNo: string

    /**
     * A STRING, deliberately not an FK (spec §D.9): an unknown-user attempt (code -1) has no user
     * row to reference, and the attempted identifier is exactly what the operator needs to see.
     * Projected from `AuditEvent.subjectLabel`, which carries the identifier as it was attempted.
     */
    @ViewColumn()
    username: string

    /** Derived from `action` + `outcome` + `reason` — see AuthFailureReason for the code mapping */
    @ViewColumn()
    activityCode: LoginActivityCode

    @ViewColumn()
    attemptedDateTime: Date

    /**
     * Null/empty renders as 'Email/Password' in the client (spec §D.9). An `auth.login` event names
     * its login method in `targetId` — `local`, or the provider name for SSO — and the projection
     * turns the local case back into the null the UI expects.
     */
    @ViewColumn()
    loginMode?: string | null

    @ViewColumn()
    message?: string | null

    @ViewColumn()
    ipAddress?: string | null

    @ViewColumn()
    userAgent?: string | null

    /** Resolved user, when the attempt matched an account — null for code -1 */
    @ViewColumn()
    userId?: string | null

    /** Correlates the sign-in with the session it created, so a revoke can be traced back */
    @ViewColumn()
    sessionId?: string | null
}
