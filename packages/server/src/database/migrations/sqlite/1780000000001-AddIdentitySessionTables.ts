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
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "identity_session" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "activeWorkspaceId" varchar,
                "refreshTokenHash" varchar(128) NOT NULL,
                "issuedDate" datetime NOT NULL DEFAULT (datetime('now')),
                "expiresDate" datetime NOT NULL,
                "revokedDate" datetime,
                "revokedReason" varchar(32),
                "userAgent" text,
                "ipAddress" varchar(45),
                "lastActiveDate" datetime
            );
        `)
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_identity_session_refreshTokenHash" ON "identity_session" ("refreshTokenHash");`
        )
        // Serves bulk revoke and the active-session list: WHERE userId = ? AND revokedDate IS NULL
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_session_user_revoked" ON "identity_session" ("userId", "revokedDate");`
        )

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "identity_token" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "purpose" varchar(32) NOT NULL,
                "tokenHash" varchar(128) NOT NULL,
                "expiresDate" datetime NOT NULL,
                "consumedDate" datetime,
                "data" text,
                "createdBy" varchar,
                "createdDate" datetime NOT NULL DEFAULT (datetime('now'))
            );
        `)
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_identity_token_tokenHash" ON "identity_token" ("tokenHash");`)
        // Non-unique on purpose: superseded tokens are retained (marked consumed), so several rows
        // may share (userId, purpose) — spec §F-3.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_identity_token_user_purpose" ON "identity_token" ("userId", "purpose");`)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_identity_token_expiresDate" ON "identity_token" ("expiresDate");`)

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "identity_login_method" (
                "id" varchar PRIMARY KEY NOT NULL,
                "organizationId" varchar,
                "name" varchar(20) NOT NULL,
                "providerLabel" varchar(50),
                "status" varchar(20) NOT NULL DEFAULT 'disable',
                "config" text,
                "clientSecret" text,
                "userId" varchar,
                "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedDate" datetime NOT NULL DEFAULT (datetime('now'))
            );
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_login_method_organizationId" ON "identity_login_method" ("organizationId");`
        )
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_identity_login_method_org_name" ON "identity_login_method" ("organizationId", "name");`
        )

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "identity_login_activity" (
                "id" varchar PRIMARY KEY NOT NULL,
                "username" varchar(255) NOT NULL,
                "activityCode" integer NOT NULL,
                "attemptedDateTime" datetime NOT NULL,
                "loginMode" varchar(50),
                "message" text,
                "ipAddress" varchar(45),
                "userAgent" text,
                "userId" varchar,
                "sessionId" varchar
            );
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_login_activity_attemptedDateTime" ON "identity_login_activity" ("attemptedDateTime");`
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_login_activity_activityCode" ON "identity_login_activity" ("activityCode");`
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_login_activity_username" ON "identity_login_activity" ("username");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "identity_login_activity"`)
        await queryRunner.query(`DROP TABLE IF EXISTS "identity_login_method"`)
        await queryRunner.query(`DROP TABLE IF EXISTS "identity_token"`)
        await queryRunner.query(`DROP TABLE IF EXISTS "identity_session"`)
    }
}
