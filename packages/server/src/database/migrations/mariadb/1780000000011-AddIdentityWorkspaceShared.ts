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
 * Indexes are declared INLINE as `KEY`, not as separate `CREATE INDEX` statements: MySQL has no
 * `CREATE INDEX IF NOT EXISTS`, so a standalone statement would throw on any re-run, whereas
 * inline keys inherit the idempotence of `CREATE TABLE IF NOT EXISTS`.
 *
 * No FOREIGN KEY constraints, per the house style established in 1780000000000 — relations are
 * declared on the entities.
 */
export class AddIdentityWorkspaceShared1780000000011 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS \`identity_workspace_shared\` (
                \`id\` varchar(36) NOT NULL,
                \`workspaceId\` varchar(36) NOT NULL,
                \`sharedItemId\` varchar(36) NOT NULL,
                \`itemType\` varchar(64) NOT NULL,
                \`organizationId\` varchar(36),
                \`createdDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                \`updatedDate\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                PRIMARY KEY (\`id\`),
                KEY \`IDX_identity_workspace_shared_lookup\` (\`workspaceId\`, \`sharedItemId\`, \`itemType\`),
                KEY \`IDX_identity_workspace_shared_item\` (\`sharedItemId\`, \`itemType\`),
                KEY \`IDX_identity_workspace_shared_org\` (\`organizationId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS \`identity_workspace_shared\`;`)
    }
}
