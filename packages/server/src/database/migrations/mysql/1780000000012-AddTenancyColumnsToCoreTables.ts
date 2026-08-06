import { MigrationInterface, QueryRunner } from 'typeorm'
import { hasColumn, hasIndex } from '../../../utils/database.util'

/**
 * Makes a FRESH database match what the core Apache-2.0 entities actually declare.
 *
 * WHY THIS IS NEEDED. The tenancy columns on the core tables were added by the commercially-
 * licensed migrations. Those were unregistered when that stack was deleted, but the columns they
 * created were never re-declared anywhere in the Apache-2.0 chain — while the entities still
 * declare them. On an existing deployment the columns are present and nothing looked wrong; on a
 * brand-new database twelve of them simply did not exist.
 *
 * WHAT IT ADDS.
 *
 *   `workspaceId` — on every table whose entity declares it and which the registered chain does
 *   not already provide. Derived from the entity metadata, not from a hand-written list: fifteen
 *   entities declare the column, three of them (`custom_mcp_server`, `schedule_record`,
 *   `schedule_trigger_log`) already get it from 1766000000000 / 1772000000000. All fifteen are
 *   named below and every one is guarded, so the set is complete and self-describing rather than
 *   depending on which engine happens to have supplied what. Note that `chat_flow` DOES need it
 *   here: only the SQLite 1755066758601 rebuilds that table with the column, the MySQL one only
 *   widens `type`.
 *
 *   `organizationId` — the denormalised tenant tag required by docs/REQUIREMENTS-MIGRATION.md §3a
 *   and docs/REQUIREMENTS-TENANCY-ACCESS.md §3, on the ten resource tables §3a names and no
 *   others. §3a enumerates them explicitly ("chat_flow first, then the other nine"), so this
 *   follows that scope rather than blanket-applying the tag to all fifteen. `execution`,
 *   `evaluator`, `custom_mcp_server`, `schedule_record` and `schedule_trigger_log` carry
 *   `workspaceId` but are outside the enumerated set and are left untagged here.
 *
 *   A composite index on (`organizationId`, `workspaceId`) per §3a, so the common tenant-scoped
 *   query needs no join.
 *
 * TYPE. `varchar(36)`, the identifier width used throughout 1780000000000 / 1780000000011 and by
 * `custom_mcp_server`.
 *
 * NULLABILITY. Both columns are added nullable. The entities declare `workspaceId` non-null, but
 * every existing deployment has it nullable, and adding it NOT NULL would turn any not-yet-
 * tenant-aware write path into a hard insert failure. Tenancy is enforced in the query layer
 * (§3a, "Enforcement"), not by a column constraint.
 *
 * IDEMPOTENCE. MySQL has no `CREATE INDEX IF NOT EXISTS` and no `DROP INDEX IF EXISTS`, and these
 * indexes go onto tables that already exist, so they cannot be declared inline as a `KEY` in a
 * CREATE TABLE the way 1780000000000 does. Both directions are therefore guarded with `hasIndex`
 * (utils/database.util.ts), the companion to the `hasColumn` guard used on the columns.
 *
 * Following house style, no FOREIGN KEY constraints are emitted — relations are declared on the
 * entities. (The dangling `chat_flow` -> `workspace` foreign key repaired by the SQLite
 * counterpart of this migration has no MySQL equivalent: 1755066758601 only emits it on SQLite.)
 */
export class AddTenancyColumnsToCoreTables1780000000012 implements MigrationInterface {
    /** Every table whose entity declares `workspaceId`. */
    private static readonly WORKSPACE_SCOPED_TABLES = [
        'apikey',
        'assistant',
        'chat_flow',
        'credential',
        'custom_mcp_server',
        'custom_template',
        'dataset',
        'document_store',
        'evaluation',
        'evaluator',
        'execution',
        'schedule_record',
        'schedule_trigger_log',
        'tool',
        'variable'
    ]

    /** The ten resource tables REQUIREMENTS-MIGRATION.md §3a tags with the tenant key. */
    private static readonly TENANT_TAGGED_TABLES = [
        'apikey',
        'assistant',
        'chat_flow',
        'credential',
        'custom_template',
        'dataset',
        'document_store',
        'evaluation',
        'tool',
        'variable'
    ]

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── 1. workspaceId on every table whose entity declares it ───────────────────────────
        for (const table of AddTenancyColumnsToCoreTables1780000000012.WORKSPACE_SCOPED_TABLES) {
            if (!(await queryRunner.hasTable(table))) continue
            if (await hasColumn(queryRunner, table, 'workspaceId')) continue
            await queryRunner.query(`ALTER TABLE \`${table}\` ADD COLUMN \`workspaceId\` varchar(36);`)
        }

        // ── 2. organizationId — the denormalised tenant tag, plus its composite index (§3a) ───
        for (const table of AddTenancyColumnsToCoreTables1780000000012.TENANT_TAGGED_TABLES) {
            if (!(await queryRunner.hasTable(table))) continue
            if (!(await hasColumn(queryRunner, table, 'organizationId'))) {
                await queryRunner.query(`ALTER TABLE \`${table}\` ADD COLUMN \`organizationId\` varchar(36);`)
            }
            const indexName = `IDX_${table}_org_workspace`
            if (!(await hasIndex(queryRunner, table, indexName))) {
                await queryRunner.query(`CREATE INDEX \`${indexName}\` ON \`${table}\` (\`organizationId\`, \`workspaceId\`);`)
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of AddTenancyColumnsToCoreTables1780000000012.TENANT_TAGGED_TABLES) {
            if (!(await queryRunner.hasTable(table))) continue
            const indexName = `IDX_${table}_org_workspace`
            if (await hasIndex(queryRunner, table, indexName)) {
                await queryRunner.query(`DROP INDEX \`${indexName}\` ON \`${table}\`;`)
            }
            if (await hasColumn(queryRunner, table, 'organizationId')) {
                await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`organizationId\`;`)
            }
        }

        // `custom_mcp_server`, `schedule_record` and `schedule_trigger_log` get their
        // `workspaceId` from earlier migrations, so it is not this migration's to remove.
        const addedHere = AddTenancyColumnsToCoreTables1780000000012.WORKSPACE_SCOPED_TABLES.filter(
            (table) => !['custom_mcp_server', 'schedule_record', 'schedule_trigger_log'].includes(table)
        )
        for (const table of addedHere) {
            if (!(await queryRunner.hasTable(table))) continue
            if (await hasColumn(queryRunner, table, 'workspaceId')) {
                await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`workspaceId\`;`)
            }
        }
    }
}
