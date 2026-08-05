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
            CREATE TABLE IF NOT EXISTS identity_user (
                id uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" text,
                "email" varchar(255) NOT NULL,
                "credential" varchar(255),
                "isSSO" boolean NOT NULL DEFAULT false,
                "pendingEmail" varchar(255),
                "emailVerifiedDate" timestamp,
                "credentialUpdatedDate" timestamp,
                "referral" text,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_identity_user" PRIMARY KEY (id)
            );
        `)
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_identity_user_email" ON identity_user ("email");`)

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS identity_organization (
                id uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" varchar(255),
                "subscriptionId" varchar(255),
                "customerId" varchar(255),
                "createdBy" uuid,
                "updatedBy" uuid,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_identity_organization" PRIMARY KEY (id)
            );
        `)

        // Composite PK: exactly one membership row per (organization, user).
        // `status` / `lastLogin` live here, not on identity_user — spec §F-1 decision.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS identity_organization_user (
                "organizationId" uuid NOT NULL,
                "userId" uuid NOT NULL,
                "status" varchar(20) NOT NULL DEFAULT 'active',
                "lastLogin" timestamp,
                "isOrgOwner" boolean NOT NULL DEFAULT false,
                "createdBy" uuid,
                "updatedBy" uuid,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_identity_organization_user" PRIMARY KEY ("organizationId", "userId")
            );
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_organization_user_userId" ON identity_organization_user ("userId");`
        )

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS identity_workspace (
                id uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" varchar(255) NOT NULL,
                "description" text,
                "organizationId" uuid NOT NULL,
                "isOrgDefault" boolean NOT NULL DEFAULT false,
                "createdBy" uuid,
                "updatedBy" uuid,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_identity_workspace" PRIMARY KEY (id)
            );
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_workspace_organizationId" ON identity_workspace ("organizationId");`
        )
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_identity_workspace_org_name" ON identity_workspace ("organizationId", "name");`
        )

        // `permissions` is a JSON-encoded string[] because the client JSON.parses it — spec §D.5.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS identity_role (
                id uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" varchar(100) NOT NULL,
                "description" text,
                "permissions" text NOT NULL DEFAULT '[]',
                "organizationId" uuid NOT NULL,
                "isSystem" boolean NOT NULL DEFAULT false,
                "createdBy" uuid,
                "updatedBy" uuid,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_identity_role" PRIMARY KEY (id)
            );
        `)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_identity_role_organizationId" ON identity_role ("organizationId");`)
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_identity_role_org_name" ON identity_role ("organizationId", "name");`
        )

        // The authority-carrying join. Composite PK enforces "one role per user per workspace"
        // structurally, so a second grant is a duplicate-key error — spec §D.6.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS identity_workspace_user (
                "workspaceId" uuid NOT NULL,
                "userId" uuid NOT NULL,
                "roleId" uuid NOT NULL,
                "createdBy" uuid,
                "updatedBy" uuid,
                "createdDate" timestamp NOT NULL DEFAULT now(),
                "updatedDate" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_identity_workspace_user" PRIMARY KEY ("workspaceId", "userId")
            );
        `)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_identity_workspace_user_userId" ON identity_workspace_user ("userId");`)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_identity_workspace_user_roleId" ON identity_workspace_user ("roleId");`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS identity_workspace_user`)
        await queryRunner.query(`DROP TABLE IF EXISTS identity_role`)
        await queryRunner.query(`DROP TABLE IF EXISTS identity_workspace`)
        await queryRunner.query(`DROP TABLE IF EXISTS identity_organization_user`)
        await queryRunner.query(`DROP TABLE IF EXISTS identity_organization`)
        await queryRunner.query(`DROP TABLE IF EXISTS identity_user`)
    }
}
