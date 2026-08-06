import { MigrationInterface, QueryRunner } from 'typeorm'
import { hasColumn } from '../../../utils/database.util'

/**
 * Makes a FRESH database match what the core Apache-2.0 entities actually declare, and repairs the
 * one foreign key that pointed at a table the cut-over removed.
 *
 * WHY THIS IS NEEDED. The tenancy columns on the core tables were added by the commercially-
 * licensed migrations. Those were unregistered when that stack was deleted, but the columns they
 * created were never re-declared anywhere in the Apache-2.0 chain — while the entities still
 * declare them. On an existing deployment the columns are present and nothing looked wrong; on a
 * brand-new database eleven of them simply did not exist.
 *
 * WHAT IT ADDS.
 *
 *   `workspaceId` — on every table whose entity declares it and which the registered chain does
 *   not already provide. Derived from the entity metadata, not from a hand-written list: fifteen
 *   entities declare the column, four of them (`chat_flow` here on SQLite, plus
 *   `custom_mcp_server`, `schedule_record`, `schedule_trigger_log`) already get it from
 *   1755066758601 / 1766000000000 / 1772000000000. All fifteen are named below and every one is
 *   guarded, so the set is complete and self-describing rather than depending on which engine
 *   happens to have supplied what.
 *
 *   `organizationId` — the denormalised tenant tag required by docs/REQUIREMENTS-MIGRATION.md §3a
 *   and docs/REQUIREMENTS-TENANCY-ACCESS.md §3, on the ten resource tables §3a names and no
 *   others. §3a enumerates them explicitly ("chat_flow first, then the other nine"), so this
 *   follows that scope rather than blanket-applying the tag to all fifteen. `execution`,
 *   `evaluator`, `custom_mcp_server`, `schedule_record` and `schedule_trigger_log` carry
 *   `workspaceId` but are outside the enumerated set and are left untagged here.
 *
 *   A composite index on `("organizationId", "workspaceId")` per §3a, so the common tenant-scoped
 *   query needs no join.
 *
 * NULLABILITY. Both columns are added nullable. The entities declare `workspaceId` non-null, but
 * the only core table that has ever had the column in the Apache-2.0 chain — `chat_flow`, from
 * 1755066758601 — declares it `TEXT` with no NOT NULL, and that is also its shape in every
 * existing deployment. Adding it NOT NULL here would diverge from the column an upgraded database
 * already has, and would turn any not-yet-tenant-aware write path into a hard insert failure —
 * the exact class of defect the second half of this migration exists to remove. Tenancy is
 * enforced in the query layer (§3a, "Enforcement"), not by a column constraint.
 *
 * THE FOREIGN KEY. 1755066758601 rebuilt `chat_flow` with
 * `FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")`. `workspace` was created by the
 * commercial migrations and does not exist on a fresh database. TypeORM's SQLite driver turns
 * `PRAGMA foreign_keys` ON and SQLite checks foreign keys at DML time, not at DDL time — so every
 * SELECT on `chat_flow` succeeds and every INSERT fails with `no such table: main.workspace`. The
 * instance looks healthy right up until someone saves a flow.
 *
 * 1755066758601 is historical upstream Apache-2.0 work and is not rewritten. The table is rebuilt
 * forward here instead, and only when `workspace` is genuinely absent — an upgraded deployment
 * still has that table, its foreign key still resolves, and this step is skipped entirely.
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
        // ── 1. Drop the dangling foreign key by rebuilding chat_flow forward ──────────────────
        // Done before the columns are added so the rebuild copies the table as the shipped chain
        // left it, and the ALTERs below then extend the repaired table.
        await this.rebuildChatFlowWithoutDanglingForeignKey(queryRunner)

        // ── 2. workspaceId on every table whose entity declares it ───────────────────────────
        for (const table of AddTenancyColumnsToCoreTables1780000000012.WORKSPACE_SCOPED_TABLES) {
            if (!(await queryRunner.hasTable(table))) continue
            if (await hasColumn(queryRunner, table, 'workspaceId')) continue
            await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "workspaceId" varchar;`)
        }

        // ── 3. organizationId — the denormalised tenant tag, plus its composite index (§3a) ───
        for (const table of AddTenancyColumnsToCoreTables1780000000012.TENANT_TAGGED_TABLES) {
            if (!(await queryRunner.hasTable(table))) continue
            if (!(await hasColumn(queryRunner, table, 'organizationId'))) {
                await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "organizationId" varchar;`)
            }
            await queryRunner.query(
                `CREATE INDEX IF NOT EXISTS "IDX_${table}_org_workspace" ON "${table}" ("organizationId", "workspaceId");`
            )
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of AddTenancyColumnsToCoreTables1780000000012.TENANT_TAGGED_TABLES) {
            if (!(await queryRunner.hasTable(table))) continue
            await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_org_workspace";`)
            if (await hasColumn(queryRunner, table, 'organizationId')) {
                await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "organizationId";`)
            }
        }

        // `chat_flow`, `custom_mcp_server`, `schedule_record` and `schedule_trigger_log` get their
        // `workspaceId` from earlier migrations on SQLite, so it is not this migration's to remove.
        const addedHere = AddTenancyColumnsToCoreTables1780000000012.WORKSPACE_SCOPED_TABLES.filter(
            (table) => !['chat_flow', 'custom_mcp_server', 'schedule_record', 'schedule_trigger_log'].includes(table)
        )
        for (const table of addedHere) {
            if (!(await queryRunner.hasTable(table))) continue
            if (await hasColumn(queryRunner, table, 'workspaceId')) {
                await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "workspaceId";`)
            }
        }

        // The chat_flow rebuild is deliberately NOT reversed. All it removed was a reference to a
        // table that does not exist; putting it back would restore a constraint that makes every
        // INSERT fail. A `down()` that reinstates a known defect is not a reversal, it is a
        // regression.
    }

    /**
     * Rebuilds `chat_flow` without its foreign key, preserving every row, every column definition
     * and every explicitly-created index. SQLite cannot drop a constraint in place, so the table
     * is recreated from its own `PRAGMA table_info` — which keeps this faithful to whatever the
     * table actually looks like, instead of restating a column list that would silently drop
     * anything a later migration had added.
     */
    private async rebuildChatFlowWithoutDanglingForeignKey(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('chat_flow'))) return
        // An upgraded deployment still has `workspace`; the foreign key resolves and must be left
        // exactly as it is.
        if (await queryRunner.hasTable('workspace')) return

        const [definition] = await queryRunner.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_flow';`)
        if (!definition?.sql || !/FOREIGN\s+KEY/i.test(definition.sql)) return

        const columns: { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[] = await queryRunner.query(
            `PRAGMA table_info("chat_flow");`
        )

        const columnDefinitions = columns.map((column) => {
            let sql = `"${column.name}" ${column.type}`
            if (column.notnull) sql += ' NOT NULL'
            if (column.dflt_value !== null) sql += ` DEFAULT ${column.dflt_value}`
            return sql
        })
        const primaryKey = columns
            .filter((column) => column.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((column) => `"${column.name}"`)
        if (primaryKey.length) columnDefinitions.push(`PRIMARY KEY (${primaryKey.join(', ')})`)

        // Indexes are dropped with the table. Those with a NULL `sql` are the implicit ones SQLite
        // creates for PRIMARY KEY / UNIQUE and recreates by itself.
        const indexes: { sql: string }[] = await queryRunner.query(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_flow' AND sql IS NOT NULL;`
        )

        const columnList = columns.map((column) => `"${column.name}"`).join(', ')
        await queryRunner.query(`CREATE TABLE "chat_flow_tenancy_rebuild" (\n    ${columnDefinitions.join(',\n    ')}\n);`)
        await queryRunner.query(`INSERT INTO "chat_flow_tenancy_rebuild" (${columnList}) SELECT ${columnList} FROM "chat_flow";`)
        await queryRunner.query(`DROP TABLE "chat_flow";`)
        await queryRunner.query(`ALTER TABLE "chat_flow_tenancy_rebuild" RENAME TO "chat_flow";`)
        for (const index of indexes) {
            await queryRunner.query(`${index.sql};`)
        }
    }
}
