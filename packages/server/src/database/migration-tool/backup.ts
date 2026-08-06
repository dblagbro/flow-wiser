/**
 * Pre-migration backup — REQUIREMENTS-MIGRATION.md §8.1.
 *
 * "Automatic pre-upgrade backup. The database is copied and integrity-checked *before* any
 * migration runs. The upgrade aborts if the backup or its verification fails — no backup, no
 * upgrade."
 *
 * Both halves of that sentence are load-bearing, and the second is the one that usually gets
 * dropped. A backup that was written but never opened is not a backup; it is a file. Everything
 * here therefore ends in a verification that actually READS what was produced, and every failure
 * path throws {@link BackupError} rather than returning a result with a warning attached.
 *
 * ── SQLite ───────────────────────────────────────────────────────────────────────────────────
 * `VACUUM INTO` is used in preference to copying the file. It runs through the connection, so it
 * observes a consistent snapshot even with WAL content that has not been checkpointed; a plain
 * `cp` of `database.sqlite` while the server holds a write-ahead log can produce a file that is
 * missing the most recent commits, which is the worst possible property for a restore target.
 * Verification then ATTACHes the result and runs `PRAGMA integrity_check` against it plus a
 * per-table row-count comparison — the backup is opened by SQLite itself and read end to end.
 *
 * ── Postgres / MySQL / MariaDB ───────────────────────────────────────────────────────────────
 * There is no in-engine equivalent reachable over a SQL connection, and shipping a hard-coded
 * `pg_dump` invocation would be a guess about the operator's authentication, network and version.
 * So the dump command is supplied by the operator and this module runs and verifies it. If no
 * command is supplied the migration does not run: that is §8.1 applied literally rather than
 * downgraded to a warning on the engines where it is least convenient.
 */
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Database, listTables, quote } from './db'

/** Thrown for every backup or verification failure. Aborts the migration — §8.1. */
export class BackupError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BackupError'
    }
}

export interface BackupOptions {
    /** Explicit destination. Defaults to a timestamped sibling of the database file (SQLite) or of `directory`. */
    path?: string
    /** Destination directory when `path` is not given. */
    directory?: string
    /**
     * Non-SQLite only: shell command that writes a dump to `{{output}}`.
     * e.g. `pg_dump --format=custom --file={{output}} "$DATABASE_URL"`
     */
    command?: string
    /**
     * Optional verification command, also templated on `{{output}}`; a non-zero exit fails the
     * backup. e.g. `pg_restore --list {{output}} > /dev/null`. When absent, verification falls back
     * to a structural check of the dump, and a dump this module cannot recognise is a FAILURE.
     */
    verifyCommand?: string
    /** Seconds allowed for `command` / `verifyCommand`. Default 3600. */
    timeoutSeconds?: number
}

export interface BackupResult {
    engine: string
    path: string
    bytes: number
    /** `vacuum-into` | `file-copy` | `external-command` */
    method: string
    /** How the backup was proved readable. Never empty — an unverified backup throws instead. */
    verification: string[]
    /** SHA-256 of the backup file, so a later restore can prove it is the same file. */
    sha256: string
    /** Table row counts as they were in the backup, for the report. */
    tableCounts?: Record<string, number>
}

const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

const sha256File = (file: string): string => {
    const hash = createHash('sha256')
    const handle = fs.openSync(file, 'r')
    try {
        const buffer = Buffer.alloc(1024 * 1024)
        for (;;) {
            const read = fs.readSync(handle, buffer, 0, buffer.length, null)
            if (read === 0) break
            hash.update(buffer.subarray(0, read))
        }
    } finally {
        fs.closeSync(handle)
    }
    return hash.digest('hex')
}

/** SQLite's file header. A backup that does not begin with this is not a database, whatever its size. */
export const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'utf8')

const resolveTarget = (options: BackupOptions, sourcePath: string | null, engine: string): string => {
    if (options.path) return options.path
    const directory = options.directory ?? (sourcePath ? path.dirname(sourcePath) : null)
    if (!directory) {
        throw new BackupError(
            `Cannot decide where to write the backup for engine "${engine}": supply BackupOptions.path or BackupOptions.directory.`
        )
    }
    const base = sourcePath ? path.basename(sourcePath) : `${engine}-database`
    return path.join(directory, `${base}.pre-identity-migration-${timestamp()}.bak`)
}

/**
 * SQLite: snapshot through the connection, then ATTACH the result and read it.
 *
 * The row-count comparison is per table and covers every table in the schema, so a backup that is
 * structurally valid but truncated fails here rather than at restore time.
 */
const backupSqlite = async (db: Database, options: BackupOptions): Promise<BackupResult> => {
    const source = db.filePath
    if (!source) {
        throw new BackupError('SQLite backup requires the database file path, and the DataSource did not report one.')
    }
    if (!fs.existsSync(source)) throw new BackupError(`SQLite database file does not exist: ${source}`)

    const target = resolveTarget(options, source, db.engine)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) throw new BackupError(`Refusing to overwrite an existing backup: ${target}`)

    const verification: string[] = []
    let method = 'vacuum-into'
    try {
        // Parameterised where the driver allows it; SQLite accepts an expression here.
        await db.query(`VACUUM INTO ${db.engine === 'postgres' ? '$1' : '?'}`, [target])
        verification.push('written by VACUUM INTO (transaction-consistent snapshot)')
    } catch (vacuumError) {
        // Older SQLite (< 3.27) has no VACUUM INTO. Fall back to a file copy and say so — the
        // report should never imply a stronger guarantee than the one that was actually obtained.
        method = 'file-copy'
        try {
            await db.query('PRAGMA wal_checkpoint(TRUNCATE)')
            verification.push('WAL checkpointed before copy')
        } catch {
            verification.push('WARNING: WAL checkpoint failed before copy')
        }
        fs.copyFileSync(source, target)
        verification.push(`copied from ${source} (VACUUM INTO unavailable: ${(vacuumError as Error).message})`)
    }

    if (!fs.existsSync(target)) throw new BackupError(`Backup command reported success but produced no file: ${target}`)
    const bytes = fs.statSync(target).size
    if (bytes === 0) throw new BackupError(`Backup file is empty: ${target}`)

    const header = Buffer.alloc(SQLITE_MAGIC.length)
    const handle = fs.openSync(target, 'r')
    try {
        fs.readSync(handle, header, 0, header.length, 0)
    } finally {
        fs.closeSync(handle)
    }
    if (!header.equals(SQLITE_MAGIC)) throw new BackupError(`Backup file is not a SQLite database (bad header): ${target}`)
    verification.push('SQLite file header present')

    // ── Open the backup and read it. ─────────────────────────────────────────────────────────
    const schema = 'flow_wiser_backup_check'
    const tableCounts: Record<string, number> = {}
    await db.query(`ATTACH DATABASE ${db.engine === 'postgres' ? '$1' : '?'} AS ${schema}`, [target])
    try {
        const integrity = await db.query(`PRAGMA ${schema}.integrity_check`)
        const verdict = String(integrity[0]?.integrity_check ?? integrity[0]?.['integrity_check'] ?? '').toLowerCase()
        if (verdict !== 'ok') throw new BackupError(`Backup failed integrity_check: ${JSON.stringify(integrity)}`)
        verification.push('PRAGMA integrity_check = ok')

        const tables = await listTables(db)
        const mismatches: string[] = []
        for (const table of tables) {
            const live = await db.query(`SELECT COUNT(*) AS c FROM ${quote(db.engine, table)}`)
            const copied = await db.query(`SELECT COUNT(*) AS c FROM ${schema}.${quote(db.engine, table)}`)
            const liveCount = Number(live[0]?.c ?? 0)
            const copiedCount = Number(copied[0]?.c ?? 0)
            tableCounts[table] = copiedCount
            if (liveCount !== copiedCount) mismatches.push(`${table}: live ${liveCount} vs backup ${copiedCount}`)
        }
        if (mismatches.length > 0) throw new BackupError(`Backup row counts do not match the live database: ${mismatches.join('; ')}`)
        verification.push(`row counts match across ${tables.length} table(s)`)
    } finally {
        await db.query(`DETACH DATABASE ${schema}`)
    }

    return { engine: db.engine, path: target, bytes, method, verification, sha256: sha256File(target), tableCounts }
}

/** Signatures of the dump formats this module can recognise without running the vendor's own tooling. */
const DUMP_SIGNATURES: readonly { name: string; test: (head: Buffer, text: string) => boolean }[] = [
    { name: 'pg_dump custom format (PGDMP)', test: (head) => head.subarray(0, 5).toString('latin1') === 'PGDMP' },
    { name: 'pg_dump plain SQL', test: (_head, text) => text.includes('PostgreSQL database dump') },
    { name: 'mysqldump / mariadb-dump', test: (_head, text) => /MySQL dump|MariaDB dump|mysqldump/i.test(text) },
    { name: 'gzip archive', test: (head) => head[0] === 0x1f && head[1] === 0x8b },
    { name: 'tar archive', test: (head) => head.subarray(257, 262).toString('latin1') === 'ustar' }
]

/** Postgres / MySQL / MariaDB: run the operator's dump command, then prove the output is readable. */
const backupViaCommand = async (db: Database, options: BackupOptions): Promise<BackupResult> => {
    if (!options.command) {
        throw new BackupError(
            `Engine "${db.engine}" has no in-connection backup mechanism, so REQUIREMENTS-MIGRATION.md §8.1 ` +
                '("no backup, no upgrade") cannot be satisfied automatically. Supply BackupOptions.command — a shell ' +
                'command that writes a dump to {{output}}, for example ' +
                '`pg_dump --format=custom --file={{output}} "$DATABASE_URL"` — or restore from a backup you have ' +
                'already taken and re-run. The migration will not proceed without one.'
        )
    }
    const target = resolveTarget(options, null, db.engine)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) throw new BackupError(`Refusing to overwrite an existing backup: ${target}`)

    const timeout = (options.timeoutSeconds ?? 3600) * 1000
    const command = options.command.split('{{output}}').join(target)
    try {
        execSync(command, { timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
        throw new BackupError(`Backup command failed: ${(error as Error).message}`)
    }

    if (!fs.existsSync(target)) throw new BackupError(`Backup command reported success but produced no file: ${target}`)
    const bytes = fs.statSync(target).size
    if (bytes === 0) throw new BackupError(`Backup file is empty: ${target}`)

    const verification: string[] = [`produced by: ${options.command}`, `${bytes} bytes`]

    if (options.verifyCommand) {
        const verify = options.verifyCommand.split('{{output}}').join(target)
        try {
            execSync(verify, { timeout, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
            throw new BackupError(`Backup verification command failed: ${(error as Error).message}`)
        }
        verification.push(`verified by: ${options.verifyCommand}`)
    } else {
        const head = Buffer.alloc(Math.min(bytes, 8192))
        const handle = fs.openSync(target, 'r')
        try {
            fs.readSync(handle, head, 0, head.length, 0)
        } finally {
            fs.closeSync(handle)
        }
        const text = head.toString('latin1')
        const matched = DUMP_SIGNATURES.find((signature) => signature.test(head, text))
        if (!matched) {
            throw new BackupError(
                `Backup at ${target} is ${bytes} bytes but matches no dump format this tool can recognise, and no ` +
                    'BackupOptions.verifyCommand was supplied. An unverified backup is not a backup (§8.1), so the ' +
                    'migration is aborting. Supply a verifyCommand such as `pg_restore --list {{output}}`.'
            )
        }
        verification.push(`recognised as ${matched.name}`)
    }

    return { engine: db.engine, path: target, bytes, method: 'external-command', verification, sha256: sha256File(target) }
}

/**
 * Take a verified backup, or throw. There is no third outcome — §8.1.
 */
export const createVerifiedBackup = async (db: Database, options: BackupOptions = {}): Promise<BackupResult> =>
    db.engine === 'sqlite' ? backupSqlite(db, options) : backupViaCommand(db, options)

export const formatBackup = (backup: BackupResult): string =>
    [
        `  path:    ${backup.path}`,
        `  bytes:   ${backup.bytes}`,
        `  method:  ${backup.method}`,
        `  sha256:  ${backup.sha256}`,
        ...backup.verification.map((line) => `  verify:  ${line}`)
    ].join('\n')
