import { QueryRunner } from 'typeorm'

export async function hasColumn(queryRunner: QueryRunner, tableName: string, columnName: string): Promise<boolean> {
    const table = await queryRunner.getTable(tableName)

    if (!table) {
        throw new Error(`Table ${tableName} not found`)
    }

    const hasColumn = table.columns.some((column) => column.name === columnName)

    return hasColumn
}

/**
 * Companion to `hasColumn`, for the engines that have no `CREATE INDEX IF NOT EXISTS`.
 *
 * SQLite and Postgres can guard an index inline; MySQL and MariaDB cannot, so a migration that
 * adds an index to an existing table there is not re-runnable without a check of its own. This
 * reads the index list from the driver's own schema reflection, so it behaves the same on all
 * four engines and a migration can be written once and guarded uniformly.
 *
 * A missing table returns `false` rather than throwing: the caller is asking whether an index
 * needs creating, and "there is no table" is a legitimate no.
 */
export async function hasIndex(queryRunner: QueryRunner, tableName: string, indexName: string): Promise<boolean> {
    const table = await queryRunner.getTable(tableName)

    if (!table) {
        return false
    }

    return table.indices.some((index) => index.name === indexName)
}
