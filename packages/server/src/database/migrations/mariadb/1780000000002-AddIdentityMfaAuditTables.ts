import { MigrationInterface, QueryRunner } from 'typeorm'
import { hasColumn, hasIndex } from '../../../utils/database.util'

/**
 * Apache-2.0 identity — SSO session provenance, MFA, encryption-at-rest rotation metadata, and the
 * unified audit trail (docs/REQUIREMENTS-AUTH-RBAC.md §7, §8, §9, §10).
 *
 * Four changes, in dependency order:
 *   1. `identity_session` learns how it was authenticated (§7) and whether MFA was satisfied before
 *      it was issued (§8), plus the key metadata for its refresh digest (§9).
 *   2. `identity_mfa_factor` / `identity_mfa_recovery_code` — the MFA data layer (§8). Policy lives
 *      on `identity_organization.mfaPolicy` (org-wide axis) and `identity_role.requiresMfa`
 *      (per-role axis); see the Organization entity for why it is split.
 *   3. Per-record key version / algorithm / nonce / salt on every encrypted value, so rotation is
 *      resumable and auditable (§9).
 *   4. `identity_audit_event` — one append-only trail across all six domains of §10.
 *      `identity_login_activity` stops being a table and becomes a VIEW over it, so sign-ins have a
 *      single write path while the shipped §D.9 screen keeps its shape.
 */
export class AddIdentityMfaAuditTables1780000000002 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── 1. Session: SSO provenance + MFA state + refresh-digest key metadata ──────────────
        const sessionColumns: [string, string][] = [
            ['authMethod', `varchar(16) NOT NULL DEFAULT 'local'`],
            ['loginMethodId', 'varchar(36)'],
            ['authProvider', 'varchar(20)'],
            ['mfaSatisfied', 'tinyint(1) NOT NULL DEFAULT 0'],
            ['mfaFactorId', 'varchar(36)'],
            ['mfaSatisfiedDate', 'datetime(6)'],
            ['refreshTokenKeyId', 'varchar(64)'],
            ['refreshTokenKeyVersion', 'int'],
            ['refreshTokenAlgorithm', 'varchar(32)']
        ]
        for (const [name, definition] of sessionColumns) {
            if (!(await hasColumn(queryRunner, 'identity_session', name))) {
                await queryRunner.query(`ALTER TABLE \`identity_session\` ADD COLUMN \`${name}\` ${definition};`)
            }
        }
        // Lets an operator count (or revoke) the sessions still verifying under a retired pepper —
        // a keyed digest cannot be re-keyed in place, so rotation here is generational (§9).
        if (!(await hasIndex(queryRunner, 'identity_session', 'IDX_identity_session_refreshTokenKeyVersion'))) {
            await queryRunner.query(
                `CREATE INDEX \`IDX_identity_session_refreshTokenKeyVersion\` ON \`identity_session\` (\`refreshTokenKeyVersion\`);`
            )
        }

        // ── 2. LoginMethod: encryption metadata for clientSecret (§9) ─────────────────────────
        const loginMethodColumns: [string, string][] = [
            ['clientSecretKeyId', 'varchar(64)'],
            ['clientSecretKeyVersion', 'int'],
            ['clientSecretAlgorithm', 'varchar(32)'],
            ['clientSecretNonce', 'varchar(64)'],
            ['clientSecretSalt', 'varchar(64)']
        ]
        for (const [name, definition] of loginMethodColumns) {
            if (!(await hasColumn(queryRunner, 'identity_login_method', name))) {
                await queryRunner.query(`ALTER TABLE \`identity_login_method\` ADD COLUMN \`${name}\` ${definition};`)
            }
        }
        // Resumable rotation pass: WHERE `clientSecret` IS NOT NULL AND `clientSecretKeyVersion` < :current
        if (!(await hasIndex(queryRunner, 'identity_login_method', 'IDX_identity_login_method_clientSecretKeyVersion'))) {
            await queryRunner.query(
                `CREATE INDEX \`IDX_identity_login_method_clientSecretKeyVersion\` ON \`identity_login_method\` (\`clientSecretKeyVersion\`);`
            )
        }

        // ── 3. MFA policy: org-wide axis on Organization, per-role axis on Role (§8) ──────────
        if (!(await hasColumn(queryRunner, 'identity_organization', 'mfaPolicy'))) {
            await queryRunner.query(
                `ALTER TABLE \`identity_organization\` ADD COLUMN \`mfaPolicy\` varchar(20) NOT NULL DEFAULT 'optional';`
            )
        }
        if (!(await hasColumn(queryRunner, 'identity_role', 'requiresMfa'))) {
            await queryRunner.query(`ALTER TABLE \`identity_role\` ADD COLUMN \`requiresMfa\` tinyint(1) NOT NULL DEFAULT 0;`)
        }

        // ── 4. MFA factors (§8). The TOTP seed is encrypted, so it carries the §9 metadata ────
        // The (userId, status) key answers the login-path question, asked before every session is
        // issued: does this user hold a CONFIRMED factor? (§8 — a pending enrolment must not
        // satisfy a required policy.)
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_mfa_factor\` (
                \`id\` varchar(36) NOT NULL,
                \`userId\` varchar(36) NOT NULL,
                \`type\` varchar(20) NOT NULL,
                \`label\` varchar(100),
                \`secret\` text,
                \`secretKeyId\` varchar(64),
                \`secretKeyVersion\` int,
                \`secretAlgorithm\` varchar(32),
                \`secretNonce\` varchar(64),
                \`secretSalt\` varchar(64),
                \`status\` varchar(20) NOT NULL DEFAULT 'pending',
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`confirmedDate\` datetime(6),
                \`lastUsedDate\` datetime(6),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_mfa_factor_user_status\` (\`userId\`, \`status\`),
                KEY \`IDX_identity_mfa_factor_secretKeyVersion\` (\`secretKeyVersion\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // ── 5. Recovery codes (§8, §9) ────────────────────────────────────────────────────────
        // `codeHash` is an argon2id/bcrypt digest — hashed, never encrypted (§9), hence no key
        // metadata here. Individually salted digests cannot be looked up, so there is no index on
        // the hash: verification loads the current batch's unconsumed rows and compares each.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_mfa_recovery_code\` (
                \`id\` varchar(36) NOT NULL,
                \`userId\` varchar(36) NOT NULL,
                \`batchId\` varchar(36) NOT NULL,
                \`codeHash\` varchar(255) NOT NULL,
                \`consumedDate\` datetime(6),
                \`consumedBySessionId\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_mfa_recovery_code_user_batch\` (\`userId\`, \`batchId\`, \`consumedDate\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // ── 6. The unified audit trail (§10) ──────────────────────────────────────────────────
        // APPEND-ONLY by construction: no updatedDate, no deletedDate, no status column — a row has
        // nothing an UPDATE could legitimately write.
        //
        // `seqNo` is the primary key rather than `id` because §10 requires monotonic ordering and a
        // timestamp cannot provide it (same-millisecond events are unordered; clock adjustments can
        // invert them). MySQL additionally requires an AUTO_INCREMENT column to be a key, so making
        // it the primary key is the only portable placement. `id` stays a uuid, uniquely indexed, so
        // external references (SIEM export, cross-links) do not leak event volume.
        //
        // §10 names the queries that matter. One key each, leading with the selective column and
        // trailing on time so every one of them also serves an ordered range scan.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_audit_event\` (
                \`seqNo\` bigint NOT NULL AUTO_INCREMENT,
                \`id\` varchar(36) NOT NULL,
                \`subjectType\` varchar(20) NOT NULL,
                \`subjectId\` varchar(36),
                \`subjectLabel\` varchar(255),
                \`sessionId\` varchar(36),
                \`action\` varchar(100) NOT NULL,
                \`targetType\` varchar(50),
                \`targetId\` varchar(255),
                \`occurredAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`ipAddress\` varchar(45),
                \`userAgent\` text,
                \`route\` varchar(255),
                \`organizationId\` varchar(36),
                \`workspaceId\` varchar(36),
                \`outcome\` varchar(16) NOT NULL,
                \`reason\` varchar(64),
                \`message\` text,
                \`detail\` text,
                \`versionCommitId\` varchar(64),
                PRIMARY KEY (\`seqNo\`),
                UNIQUE KEY \`UQ_identity_audit_event_id\` (\`id\`),
                KEY \`IDX_identity_audit_event_subject\` (\`subjectId\`, \`occurredAt\`),
                KEY \`IDX_identity_audit_event_target\` (\`targetType\`, \`targetId\`, \`occurredAt\`),
                KEY \`IDX_identity_audit_event_occurredAt\` (\`occurredAt\`),
                KEY \`IDX_identity_audit_event_outcome\` (\`outcome\`, \`occurredAt\`),
                KEY \`IDX_identity_audit_event_action\` (\`action\`, \`occurredAt\`),
                KEY \`IDX_identity_audit_event_scope\` (\`organizationId\`, \`workspaceId\`, \`occurredAt\`),
                KEY \`IDX_identity_audit_event_session\` (\`sessionId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // ── 7. LoginActivity: table → projection over the audit trail (§10) ───────────────────
        // Superseded as a base table. Two write paths for the same fact drift, and the records that
        // get forgotten are the failures — the ones §10 calls the highest-value in the file. The
        // view keeps the shipped screen's §D.9 field names and integer code vocabulary intact.
        //
        // The WHERE clause admits only the six shapes that map to a defined code, so the projection
        // can never emit the -99 "Unknown Activity" pseudo-code the server must not store (§A.10).
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_login_activity\``)
        await queryRunner.query(`
            CREATE OR REPLACE VIEW \`identity_login_activity\` AS
            SELECT
                \`id\` AS \`id\`,
                \`seqNo\` AS \`seqNo\`,
                COALESCE(\`subjectLabel\`, '') AS \`username\`,
                CASE
                    WHEN \`action\` = 'auth.logout' THEN 1
                    WHEN \`outcome\` = 'success' THEN 0
                    WHEN \`reason\` = 'unknown_user' THEN -1
                    WHEN \`reason\` = 'incorrect_credential' THEN -2
                    WHEN \`reason\` = 'user_disabled' THEN -3
                    ELSE -4
                END AS \`activityCode\`,
                \`occurredAt\` AS \`attemptedDateTime\`,
                CASE WHEN \`targetId\` = 'local' THEN NULL ELSE \`targetId\` END AS \`loginMode\`,
                \`message\` AS \`message\`,
                \`ipAddress\` AS \`ipAddress\`,
                \`userAgent\` AS \`userAgent\`,
                \`subjectId\` AS \`userId\`,
                \`sessionId\` AS \`sessionId\`
            FROM \`identity_audit_event\`
            WHERE \`action\` IN ('auth.login', 'auth.logout')
              AND (
                    \`action\` = 'auth.logout'
                 OR \`outcome\` = 'success'
                 OR \`reason\` IN ('unknown_user', 'incorrect_credential', 'user_disabled', 'no_assigned_workspace')
              );
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restore identity_login_activity as the base table it was in 1780000000001. Rows written as
        // AuditEvents are NOT copied back: the projection is a view, so there is nothing to unwind.
        await queryRunner.query(`DROP VIEW IF EXISTS \`identity_login_activity\``)
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_login_activity\` (
                \`id\` varchar(36) NOT NULL,
                \`username\` varchar(255) NOT NULL,
                \`activityCode\` int NOT NULL,
                \`attemptedDateTime\` datetime(6) NOT NULL,
                \`loginMode\` varchar(50),
                \`message\` text,
                \`ipAddress\` varchar(45),
                \`userAgent\` text,
                \`userId\` varchar(36),
                \`sessionId\` varchar(36),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_login_activity_attemptedDateTime\` (\`attemptedDateTime\`),
                KEY \`IDX_identity_login_activity_activityCode\` (\`activityCode\`),
                KEY \`IDX_identity_login_activity_username\` (\`username\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_audit_event\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_mfa_recovery_code\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_mfa_factor\``)

        await queryRunner.query(`ALTER TABLE \`identity_role\` DROP COLUMN \`requiresMfa\`;`)
        await queryRunner.query(`ALTER TABLE \`identity_organization\` DROP COLUMN \`mfaPolicy\`;`)

        if (await hasIndex(queryRunner, 'identity_login_method', 'IDX_identity_login_method_clientSecretKeyVersion')) {
            await queryRunner.query(`DROP INDEX \`IDX_identity_login_method_clientSecretKeyVersion\` ON \`identity_login_method\`;`)
        }
        for (const name of [
            'clientSecretSalt',
            'clientSecretNonce',
            'clientSecretAlgorithm',
            'clientSecretKeyVersion',
            'clientSecretKeyId'
        ]) {
            await queryRunner.query(`ALTER TABLE \`identity_login_method\` DROP COLUMN \`${name}\`;`)
        }

        if (await hasIndex(queryRunner, 'identity_session', 'IDX_identity_session_refreshTokenKeyVersion')) {
            await queryRunner.query(`DROP INDEX \`IDX_identity_session_refreshTokenKeyVersion\` ON \`identity_session\`;`)
        }
        for (const name of [
            'refreshTokenAlgorithm',
            'refreshTokenKeyVersion',
            'refreshTokenKeyId',
            'mfaSatisfiedDate',
            'mfaFactorId',
            'mfaSatisfied',
            'authProvider',
            'loginMethodId',
            'authMethod'
        ]) {
            await queryRunner.query(`ALTER TABLE \`identity_session\` DROP COLUMN \`${name}\`;`)
        }
    }
}
