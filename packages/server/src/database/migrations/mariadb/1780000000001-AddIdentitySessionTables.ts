import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Apache-2.0 identity session / token / SSO-config / audit tables
 * (docs/SPEC-AUTH-RBAC.md §D.8, §D.9, §D.12, §F-3).
 *
 * `identity_session` makes sessions server-side records so they can be revoked individually or in
 * bulk (requirements §5). `identity_token` replaces the multiplexed `tempToken` column with one row
 * per issued token, discriminated by `purpose`, so the four single-use flows are concurrent (§F-3).
 */
export class AddIdentitySessionTables1780000000001 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // The composite key (userId, revokedDate) serves bulk revoke and the active-session list:
        // WHERE `userId` = ? AND `revokedDate` IS NULL
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_session\` (
                \`id\` varchar(36) NOT NULL,
                \`userId\` varchar(36) NOT NULL,
                \`activeWorkspaceId\` varchar(36),
                \`refreshTokenHash\` varchar(128) NOT NULL,
                \`issuedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`expiresDate\` datetime(6) NOT NULL,
                \`revokedDate\` datetime(6),
                \`revokedReason\` varchar(32),
                \`userAgent\` text,
                \`ipAddress\` varchar(45),
                \`lastActiveDate\` datetime(6),
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`UQ_identity_session_refreshTokenHash\` (\`refreshTokenHash\`),
                KEY \`IDX_identity_session_user_revoked\` (\`userId\`, \`revokedDate\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // (userId, purpose) is deliberately non-unique: superseded tokens are retained (marked
        // consumed), so several rows may share it — spec §F-3.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_token\` (
                \`id\` varchar(36) NOT NULL,
                \`userId\` varchar(36) NOT NULL,
                \`purpose\` varchar(32) NOT NULL,
                \`tokenHash\` varchar(128) NOT NULL,
                \`expiresDate\` datetime(6) NOT NULL,
                \`consumedDate\` datetime(6),
                \`data\` text,
                \`createdBy\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`UQ_identity_token_tokenHash\` (\`tokenHash\`),
                KEY \`IDX_identity_token_user_purpose\` (\`userId\`, \`purpose\`),
                KEY \`IDX_identity_token_expiresDate\` (\`expiresDate\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_login_method\` (
                \`id\` varchar(36) NOT NULL,
                \`organizationId\` varchar(36),
                \`name\` varchar(20) NOT NULL,
                \`providerLabel\` varchar(50),
                \`status\` varchar(20) NOT NULL DEFAULT 'disable',
                \`config\` text,
                \`clientSecret\` text,
                \`userId\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_login_method_organizationId\` (\`organizationId\`),
                UNIQUE KEY \`UQ_identity_login_method_org_name\` (\`organizationId\`, \`name\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

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
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_login_activity\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_login_method\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_token\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_session\``)
    }
}
