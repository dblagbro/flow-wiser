/**
 * Non-user data integrity — REQUIREMENTS-MIGRATION.md §2.
 *
 * "Flows, credentials, chat history, document stores, variables, API keys, evaluations and
 * executions are untouched by identity migration. They are not re-keyed, not re-encrypted as a side
 * effect, and not rewritten. … Verified before and after by row counts and content hashes; the
 * upgrade aborts on any mismatch."
 *
 * This module is that verification. It is the reason the tool can make a claim stronger than "we
 * did not write any code that touches credentials": it reads every byte of every protected row
 * before and after and proves they are the same bytes.
 *
 * ── Three decisions worth stating ────────────────────────────────────────────────────────────
 *
 * 1. **The column set is pinned by the BEFORE pass.** §3a adds a denormalised `organizationId`
 *    column to the tenant-scoped tables, so the AFTER pass sees a column the BEFORE pass did not.
 *    Hashing "whatever columns exist now" would therefore report a mismatch on every successful
 *    migration — the check would be worthless within a day and switched off within a week. The
 *    fingerprint records the columns it hashed, and the AFTER pass hashes exactly those, so an
 *    added column is invisible to the comparison while a change to any pre-existing value is not.
 *    A column that DISAPPEARS is a mismatch, and is reported as one.
 *
 * 2. **Row hashes are combined order-independently.** Per-row SHA-256, then sort the digests, then
 *    hash the sorted list. No `ORDER BY` on the data itself is required for the result to be
 *    stable, which matters because a table's natural order is not guaranteed to survive anything —
 *    not a VACUUM, not a dump/restore, not a backup round-trip. The check is about content, and
 *    physical row order is not content.
 *
 * 3. **Discovered, not listed.** The tables to protect are found by inspecting the schema and
 *    excluding the identity ones, rather than read from a hard-coded list. A list would silently
 *    stop protecting any table added after it was written, and the failure mode of that mistake is
 *    "we did not notice the data was gone".
 */
import { createHash } from 'crypto'
import { Database, listColumns, listTables, quote } from './db'
import { IDENTITY_TABLES, LEGACY_IDENTITY_TABLES } from './detect'

/** Rows read per statement. Bounded so a large `chat_message` table does not have to fit in memory at once. */
const DEFAULT_BATCH_SIZE = 5000

export interface TableFingerprint {
    table: string
    rows: number
    /** The columns that were hashed, in the order they were hashed. Pinned for the AFTER pass — see the header. */
    columns: string[]
    /** SHA-256 over the sorted per-row digests. */
    hash: string
}

export interface Fingerprint {
    takenAt: string
    tables: TableFingerprint[]
}

export interface FingerprintOptions {
    /** Restrict to these tables. Defaults to every protected table discovered in the schema. */
    tables?: readonly string[]
    /** Hash exactly these columns per table, overriding discovery. Supplied by the AFTER pass from the BEFORE result. */
    columnsByTable?: Readonly<Record<string, readonly string[]>>
    batchSize?: number
}

/**
 * Field separator, and the marker for SQL NULL.
 *
 * A byte that cannot occur inside a column name or a type tag, so `{a: '1', b: ''}` and
 * `{a: '', b: '1'}` cannot hash alike. NULL gets its own marker rather than an empty string, so a
 * column changed from `''` to NULL is a mismatch and not a coincidence.
 */
const SEPARATOR = '\u0000'
const NULL_MARKER = '\u0000null'

/**
 * Canonical byte form of one column value.
 *
 * Type-tagged, so the string `'1'` and the number `1` never collide — a hash that cannot tell those
 * apart would pass a migration that had silently changed a column's storage class, which is exactly
 * the kind of damage a SQLite `ALTER TABLE` rebuild can do.
 */

const canonical = (value: unknown): string => {
    if (value === null || value === undefined) return NULL_MARKER
    if (Buffer.isBuffer(value)) return `b:${value.toString('base64')}`
    if (value instanceof Date) return `d:${value.toISOString()}`
    if (typeof value === 'number') return `n:${Number.isInteger(value) ? value.toFixed(0) : String(value)}`
    if (typeof value === 'bigint') return `n:${value.toString()}`
    if (typeof value === 'boolean') return `B:${value ? '1' : '0'}`
    if (typeof value === 'object') return `j:${JSON.stringify(value)}`
    return `s:${String(value)}`
}

const rowDigest = (row: Record<string, unknown>, columns: readonly string[]): string => {
    const hash = createHash('sha256')
    for (const column of columns) {
        hash.update(column)
        hash.update('')
        hash.update(canonical(row[column]))
        hash.update('')
    }
    return hash.digest('hex')
}

/**
 * Every table whose contents §2 protects: everything in the schema that is not part of either
 * identity layer and not TypeORM's own ledger.
 *
 * `migrations` is excluded because the upgrade is expected to add rows to it — that is what an
 * upgrade IS — so including it would make the check fail by design.
 */
export const protectedTables = async (db: Database): Promise<string[]> => {
    const identity = new Set<string>([
        ...IDENTITY_TABLES.map((table) => table.toLowerCase()),
        ...LEGACY_IDENTITY_TABLES.map((table) => table.toLowerCase()),
        'identity_login_activity',
        'migrations',
        'typeorm_metadata'
    ])
    const tables = await listTables(db)
    return tables.filter((table) => !identity.has(table.toLowerCase())).sort((left, right) => left.localeCompare(right))
}

const fingerprintTable = async (db: Database, table: string, columns: readonly string[], batchSize: number): Promise<TableFingerprint> => {
    const quoted = columns.map((column) => quote(db.engine, column)).join(', ')
    // ORDER BY ordinals gives a total order over the selected columns on all four engines, which is
    // what makes LIMIT/OFFSET paging return each row exactly once. The final hash does not depend
    // on it — see decision 2 in the header — but the paging does.
    const ordering = columns.map((_, index) => index + 1).join(', ')
    const digests: string[] = []
    let offset = 0
    for (;;) {
        const rows = await db.query(
            `SELECT ${quoted} FROM ${quote(db.engine, table)} ORDER BY ${ordering} LIMIT ${batchSize} OFFSET ${offset}`
        )
        for (const row of rows) digests.push(rowDigest(row as Record<string, unknown>, columns))
        if (rows.length < batchSize) break
        offset += batchSize
    }
    digests.sort()
    const hash = createHash('sha256')
    for (const digest of digests) hash.update(digest)
    return { table, rows: digests.length, columns: [...columns], hash: hash.digest('hex') }
}

/** Capture row counts and content hashes for every protected table (or the subset named in `options`). */
export const captureFingerprint = async (db: Database, options: FingerprintOptions = {}): Promise<Fingerprint> => {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    const tables = options.tables ? [...options.tables] : await protectedTables(db)
    const present = new Set((await listTables(db)).map((table) => table.toLowerCase()))
    const result: TableFingerprint[] = []
    for (const table of tables) {
        if (!present.has(table.toLowerCase())) {
            // A protected table that has vanished is recorded rather than skipped, so the
            // comparison can report it as the loss it is.
            result.push({ table, rows: -1, columns: [], hash: 'MISSING' })
            continue
        }
        const pinned = options.columnsByTable?.[table]
        const columns = pinned ? [...pinned] : await listColumns(db, table)
        const actual = new Set((await listColumns(db, table)).map((column) => column.toLowerCase()))
        const dropped = columns.filter((column) => !actual.has(column.toLowerCase()))
        if (dropped.length > 0) {
            result.push({ table, rows: -1, columns: [...columns], hash: `MISSING_COLUMNS:${dropped.join(',')}` })
            continue
        }
        if (columns.length === 0) {
            result.push({ table, rows: 0, columns: [], hash: 'NO_COLUMNS' })
            continue
        }
        result.push(await fingerprintTable(db, table, columns, batchSize))
    }
    return { takenAt: new Date().toISOString(), tables: result }
}

/** Re-capture using exactly the columns the BEFORE pass hashed — see decision 1 in the header. */
export const recaptureFingerprint = (db: Database, before: Fingerprint, batchSize?: number): Promise<Fingerprint> => {
    const columnsByTable: Record<string, string[]> = {}
    for (const table of before.tables) columnsByTable[table.table] = table.columns
    return captureFingerprint(db, { tables: before.tables.map((table) => table.table), columnsByTable, batchSize })
}

export interface FingerprintMismatch {
    table: string
    reason: 'row-count' | 'content' | 'missing-table' | 'missing-columns' | 'unexpected-table'
    before?: TableFingerprint
    after?: TableFingerprint
    message: string
}

export interface FingerprintComparison {
    identical: boolean
    mismatches: FingerprintMismatch[]
    /** Tables compared and found identical, for the report. */
    verified: { table: string; rows: number; hash: string }[]
}

/** Compare two fingerprints. Any difference at all is a failure — §2 leaves no room for tolerance. */
export const compareFingerprints = (before: Fingerprint, after: Fingerprint): FingerprintComparison => {
    const mismatches: FingerprintMismatch[] = []
    const verified: { table: string; rows: number; hash: string }[] = []
    const afterByTable = new Map(after.tables.map((table) => [table.table, table]))

    for (const beforeTable of before.tables) {
        const afterTable = afterByTable.get(beforeTable.table)
        afterByTable.delete(beforeTable.table)
        if (!afterTable || afterTable.hash === 'MISSING') {
            mismatches.push({
                table: beforeTable.table,
                reason: 'missing-table',
                before: beforeTable,
                after: afterTable,
                message: `${beforeTable.table}: table is gone after migration (had ${beforeTable.rows} rows)`
            })
            continue
        }
        if (afterTable.hash.startsWith('MISSING_COLUMNS:')) {
            mismatches.push({
                table: beforeTable.table,
                reason: 'missing-columns',
                before: beforeTable,
                after: afterTable,
                message: `${beforeTable.table}: columns removed by migration — ${afterTable.hash.slice('MISSING_COLUMNS:'.length)}`
            })
            continue
        }
        if (beforeTable.rows !== afterTable.rows) {
            mismatches.push({
                table: beforeTable.table,
                reason: 'row-count',
                before: beforeTable,
                after: afterTable,
                message: `${beforeTable.table}: row count changed ${beforeTable.rows} -> ${afterTable.rows}`
            })
            continue
        }
        if (beforeTable.hash !== afterTable.hash) {
            mismatches.push({
                table: beforeTable.table,
                reason: 'content',
                before: beforeTable,
                after: afterTable,
                message:
                    `${beforeTable.table}: content hash changed ${beforeTable.hash.slice(0, 16)}… -> ${afterTable.hash.slice(0, 16)}… ` +
                    `over ${beforeTable.rows} rows and ${beforeTable.columns.length} pre-existing columns`
            })
            continue
        }
        verified.push({ table: beforeTable.table, rows: beforeTable.rows, hash: beforeTable.hash })
    }

    // A protected table that did not exist before and does now is not §2 damage, but it is not
    // nothing either — an identity migration has no business creating a non-identity table.
    for (const [name, afterTable] of afterByTable) {
        mismatches.push({
            table: name,
            reason: 'unexpected-table',
            after: afterTable,
            message: `${name}: table appeared during migration with ${afterTable.rows} rows`
        })
    }

    return { identical: mismatches.length === 0, mismatches, verified }
}

/** Rendered into both the dry-run report and the post-migration report. */
export const formatComparison = (comparison: FingerprintComparison): string => {
    const lines: string[] = []
    for (const entry of comparison.verified) lines.push(`  OK   ${entry.table.padEnd(28)} ${entry.rows} rows  ${entry.hash.slice(0, 16)}…`)
    for (const mismatch of comparison.mismatches) lines.push(`  FAIL ${mismatch.message}`)
    lines.push(comparison.identical ? '  All protected tables identical.' : `  ${comparison.mismatches.length} MISMATCH(ES) — migration aborted.`)
    return lines.join('\n')
}
