import { MigrationInterface, QueryRunner } from 'typeorm'
import { Role } from '../../../database/entities/identity'
import { hasColumn } from '../../../utils/database.util'
import logger from '../../../utils/logger'

export class AddApiKeyPermission1765360298674 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const tableName = 'apikey'
        const columnName = 'permissions'

        const columnExists = await hasColumn(queryRunner, tableName, columnName)
        if (!columnExists) {
            await queryRunner.query(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" TEXT NOT NULL DEFAULT '[]';`)

            const permission =
                '["chatflows:view","chatflows:create","chatflows:update","chatflows:duplicate","chatflows:delete","chatflows:export","chatflows:import","chatflows:config","chatflows:domains","agentflows:view","agentflows:create","agentflows:update","agentflows:duplicate","agentflows:delete","agentflows:export","agentflows:import","agentflows:config","agentflows:domains","tools:view","tools:create","tools:update","tools:delete","tools:export","assistants:view","assistants:create","assistants:update","assistants:delete","credentials:view","credentials:create","credentials:update","credentials:delete","variables:view","variables:create","variables:update","variables:delete","apikeys:view","apikeys:create","apikeys:update","apikeys:delete","documentStores:view","documentStores:create","documentStores:update","documentStores:delete","documentStores:add-loader","documentStores:delete-loader","documentStores:preview-process","documentStores:upsert-config","executions:view","executions:delete","templates:marketplace","templates:custom","templates:custom-delete","templates:toolexport","templates:flowexport"]'

            await queryRunner.query(`UPDATE "${tableName}" SET "${columnName}" = '${permission}';`)
        }

        // The legacy `role` table was created by the commercially-licensed migrations, which the
        // Apache-2.0 cut-over unregistered. On a FRESH database it therefore never exists, and this
        // unguarded SELECT aborted the whole migration chain — no Flow-Wiser database could be
        // created at all. The pruning below is a data fix-up for an EXISTING deployment; when the
        // table is absent there is nothing to fix up, so it is skipped rather than failed.
        if (!(await queryRunner.hasTable('role'))) return

        const sso = 'sso:manage'
        const apikey = 'apikeys:import'
        const itemsToRemove = [sso, apikey]
        const roles: Role[] = await queryRunner.query(
            `SELECT * FROM "role" WHERE "${columnName}" LIKE '%${sso}%' OR "${columnName}" LIKE '%${apikey}%';`
        )
        if (roles.length > 0) {
            for (const role of roles) {
                let permissions: string[] = []
                try {
                    permissions = JSON.parse(role.permissions)
                } catch (error) {
                    logger.error(`AddApiKeyPermission1765360298674 error parsing permissions for role ${role.id}:`, error)
                    continue
                }
                permissions = permissions.filter((permission: string) => !itemsToRemove.includes(permission))
                await queryRunner.query(`UPDATE "role" SET "${columnName}" = '${JSON.stringify(permissions)}' WHERE "id" = '${role.id}';`)
            }
        }
    }

    public async down(): Promise<void> {}
}
