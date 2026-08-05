import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Apache-2.0 identity / RBAC core tables (docs/SPEC-AUTH-RBAC.md §D.1–D.6).
 *
 * Tables are `identity_`-prefixed so this schema is disjoint from the one the outgoing stack
 * created; an existing deployment migrates forward instead of colliding on CREATE TABLE.
 * Following house style, no FOREIGN KEY constraints are emitted — relations are declared on the
 * entities (see Execution.ts for the same pattern).
 */
export class AddIdentityTables1780000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_user\` (
                \`id\` varchar(36) NOT NULL,
                \`name\` text,
                \`email\` varchar(255) NOT NULL,
                \`credential\` varchar(255),
                \`isSSO\` tinyint(1) NOT NULL DEFAULT 0,
                \`pendingEmail\` varchar(255),
                \`emailVerifiedDate\` datetime(6),
                \`credentialUpdatedDate\` datetime(6),
                \`referral\` text,
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`UQ_identity_user_email\` (\`email\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_organization\` (
                \`id\` varchar(36) NOT NULL,
                \`name\` varchar(255),
                \`subscriptionId\` varchar(255),
                \`customerId\` varchar(255),
                \`createdBy\` varchar(36),
                \`updatedBy\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // Composite PK: exactly one membership row per (organization, user).
        // `status` / `lastLogin` live here, not on identity_user — spec §F-1 decision.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_organization_user\` (
                \`organizationId\` varchar(36) NOT NULL,
                \`userId\` varchar(36) NOT NULL,
                \`status\` varchar(20) NOT NULL DEFAULT 'active',
                \`lastLogin\` datetime(6),
                \`isOrgOwner\` tinyint(1) NOT NULL DEFAULT 0,
                \`createdBy\` varchar(36),
                \`updatedBy\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`organizationId\`, \`userId\`),
                KEY \`IDX_identity_organization_user_userId\` (\`userId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_workspace\` (
                \`id\` varchar(36) NOT NULL,
                \`name\` varchar(255) NOT NULL,
                \`description\` text,
                \`organizationId\` varchar(36) NOT NULL,
                \`isOrgDefault\` tinyint(1) NOT NULL DEFAULT 0,
                \`createdBy\` varchar(36),
                \`updatedBy\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_workspace_organizationId\` (\`organizationId\`),
                UNIQUE KEY \`UQ_identity_workspace_org_name\` (\`organizationId\`, \`name\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // `permissions` is a JSON-encoded string[] because the client JSON.parses it — spec §D.5.
        // MariaDB accepts a literal TEXT default (10.2.1+).
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_role\` (
                \`id\` varchar(36) NOT NULL,
                \`name\` varchar(100) NOT NULL,
                \`description\` text,
                \`permissions\` text NOT NULL DEFAULT '[]',
                \`organizationId\` varchar(36) NOT NULL,
                \`isSystem\` tinyint(1) NOT NULL DEFAULT 0,
                \`createdBy\` varchar(36),
                \`updatedBy\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_role_organizationId\` (\`organizationId\`),
                UNIQUE KEY \`UQ_identity_role_org_name\` (\`organizationId\`, \`name\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)

        // The authority-carrying join. Composite PK enforces "one role per user per workspace"
        // structurally, so a second grant is a duplicate-key error — spec §D.6.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_workspace_user\` (
                \`workspaceId\` varchar(36) NOT NULL,
                \`userId\` varchar(36) NOT NULL,
                \`roleId\` varchar(36) NOT NULL,
                \`createdBy\` varchar(36),
                \`updatedBy\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`workspaceId\`, \`userId\`),
                KEY \`IDX_identity_workspace_user_userId\` (\`userId\`),
                KEY \`IDX_identity_workspace_user_roleId\` (\`roleId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_workspace_user\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_role\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_workspace\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_organization_user\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_organization\``)
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_user\``)
    }
}
