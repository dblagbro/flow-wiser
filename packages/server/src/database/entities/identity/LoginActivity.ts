/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm'

/**
 * Activity codes consumed by the login-activity screen (spec §D.9, §A.10). The negative codes map
 * 1:1 onto the canonical error strings in spec §0.5, which is how a FAILED login is recorded —
 * failures must be written, not only successes.
 *
 * Note `-99` ("Unknown Activity" in the filter UI) is never stored; the query layer treats it as
 * "no match" (spec §A.10).
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
 * Identity — LoginActivity (spec §D.9): the auth audit record.
 *
 * On by default (requirements §6 "structured audit log for auth events, on by default").
 * Indexed for the three filters the screen actually issues: `attemptedDateTime` range,
 * `activityCode` set, and offset pagination ordered by time.
 */
@Entity('identity_login_activity')
export class LoginActivity {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /**
     * A STRING, deliberately not an FK (spec §D.9): an unknown-user attempt (code -1) has no user
     * row to reference, and the attempted identifier is exactly what the operator needs to see.
     */
    @Index()
    @Column({ type: 'varchar', length: 255 })
    username: string

    @Index()
    @Column({ type: 'int' })
    activityCode: LoginActivityCode

    @Index()
    @Column()
    attemptedDateTime: Date

    /** Null/empty renders as 'Email/Password' in the client (spec §D.9) */
    @Column({ nullable: true, type: 'varchar', length: 50 })
    loginMode?: string | null

    @Column({ nullable: true, type: 'text' })
    message?: string | null

    /**
     * Not required by the UI contract, added per requirements §6 (structured audit: who, what,
     * allowed/denied, when). Sized for a full IPv6 literal.
     */
    @Column({ nullable: true, type: 'varchar', length: 45 })
    ipAddress?: string | null

    @Column({ nullable: true, type: 'text' })
    userAgent?: string | null

    /** Resolved user, when the attempt matched an account — null for code -1 */
    @Column({ nullable: true, type: 'uuid' })
    userId?: string | null

    /** Correlates an audit row with the session it created, so a revoke can be traced back */
    @Column({ nullable: true, type: 'uuid' })
    sessionId?: string | null
}
