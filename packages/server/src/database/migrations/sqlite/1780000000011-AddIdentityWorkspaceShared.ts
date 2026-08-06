import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Apache-2.0 identity — `identity_workspace_shared`: a resource in one workspace made visible
 * to another (see the WorkspaceShared entity for the clean-room provenance of its shape).
 *
 * WHY THIS ARRIVES SEPARATELY, AFTER THE CORE TABLES. The entity was added during cut-over but
 * never registered in `identityEntities` and never given a migration, so the table would never
 * have been created — while three shipped Apache-2.0 services read it at runtime
 * (`services/credentials/index.ts`, `routes/oauth2/index.ts`,
 * `services/openai-assistants-vector-store/`). The failure would not have surfaced at boot: it
 * waits until someone first exercises credential sharing, OAuth2 token resolution or
 * vector-store access. Recorded rather than folded silently into 1780000000000, so the gap and
 * its correction stay legible.
 *
 * No FOREIGN KEY constraints, per the house style established in 1780000000000 — relations are
 * declared on the entities.
 */
export class AddIdentityWorkspaceShared1780000000011 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "identity_workspace_shared" (
                "id" varchar PRIMARY KEY NOT NULL,
                "workspaceId" varchar NOT NULL,
                "sharedItemId" varchar NOT NULL,
                "itemType" varchar(64) NOT NULL,
                "organizationId" varchar,
                "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedDate" datetime NOT NULL DEFAULT (datetime('now'))
            );
        `)
        // The lookup every call site performs: "is this item shared into this workspace?"
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_workspace_shared_lookup" ON "identity_workspace_shared" ("workspaceId", "sharedItemId", "itemType");`
        )
        // Reverse direction: "which workspaces is this item shared into?" — needed to revoke
        // every share when the underlying credential or vector store is deleted.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_workspace_shared_item" ON "identity_workspace_shared" ("sharedItemId", "itemType");`
        )
        // Tenant sweep — see REQUIREMENTS-MIGRATION.md §3a.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_identity_workspace_shared_org" ON "identity_workspace_shared" ("organizationId");`
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "identity_workspace_shared";`)
    }
}
