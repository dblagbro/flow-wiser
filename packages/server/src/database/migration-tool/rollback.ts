/**
 * Rollback — REQUIREMENTS-MIGRATION.md §8.
 *
 * §8 opens with "Assume every upgrade can fail, because at some point one will." There are two
 * layers of recovery here and they answer different failures:
 *
 *  1. **Transactional rollback**, which lives in `migrate.ts`: on SQLite and Postgres the whole
 *     migration runs inside one transaction and any abort — including the §2 non-user-data check
 *     and the §3a tenant-key check, both of which run BEFORE the commit — unwinds it completely.
 *     Nothing in this file is needed for that case.
 *
 *  2. **Restore from the pre-migration backup**, which is this file. It is the answer when the
 *     transaction was not enough: MySQL and MariaDB, where DDL commits implicitly and no client-side
 *     rollback exists (§8.3); a process killed between statements; or a migration that succeeded
 *     technically and is wrong in a way only a human notices afterwards.
 *
 * ── The restore is deliberately blunt ────────────────────────────────────────────────────────
 * It replaces the database file. It does not try to undo the migration statement by statement, and
 * that is not a shortcut — a partial, hand-rolled "un-migration" is a second migration with none of
 * the testing of the first, and it runs at the worst possible moment. §8.5 documents restoring a
 * copy, so restoring a copy is exactly what this does.
 *
 * ── The server must be stopped ───────────────────────────────────────────────────────────────
 * Overwriting a SQLite file that an open connection is using produces corruption, not an error.
 * There is no portable way to detect that from inside the process, so it is stated as a precondition
 * and the documented procedure (§8.5) begins with `docker compose stop`. {@link restoreSqliteBackup}
 * additionally refuses to run while a `-wal` or `-shm` sidecar is present, which is the one
 * observable symptom of a live connection.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { BackupResult, SQLITE_MAGIC } from './backup'

export class RestoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RestoreError'
    }
}

export interface RestoreOptions {
    /** The verified backup to restore. */
    backupPath: string
    /** The database file to overwrite. */
    targetPath: string
    /** SHA-256 from {@link BackupResult.sha256}. Checked when supplied — a backup that changed on disk is not the backup that was verified. */
    expectedSha256?: string
    /**
     * Copy the CURRENT target aside before overwriting it, so a restore performed in error is itself
     * recoverable. On by default: the state you are throwing away is the only evidence of what went
     * wrong, and the cost of keeping it is one file.
     */
    safetyCopy?: boolean
    /**
     * Proceed even though `-wal`/`-shm` sidecars are present. They indicate an open connection, and
     * overwriting underneath one corrupts the database rather than failing. Off by default.
     */
    ignoreOpenConnectionEvidence?: boolean
}

export interface RestoreResult {
    restoredFrom: string
    restoredTo: string
    bytes: number
    /** Where the pre-restore state was copied, if `safetyCopy` was on. */
    safetyCopyPath: string | null
    checks: string[]
}

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

const readHeader = (file: string, length: number): Buffer => {
    const header = Buffer.alloc(length)
    const handle = fs.openSync(file, 'r')
    try {
        fs.readSync(handle, header, 0, length, 0)
    } finally {
        fs.closeSync(handle)
    }
    return header
}

/**
 * Restore a SQLite database from a backup taken by `backup.ts`.
 *
 * Every check happens BEFORE anything is overwritten. A restore that fails halfway is worse than
 * the state it was called to fix.
 */
export const restoreSqliteBackup = (options: RestoreOptions): RestoreResult => {
    const checks: string[] = []

    if (!fs.existsSync(options.backupPath)) throw new RestoreError(`Backup does not exist: ${options.backupPath}`)
    const bytes = fs.statSync(options.backupPath).size
    if (bytes === 0) throw new RestoreError(`Backup is empty: ${options.backupPath}`)
    checks.push(`backup present, ${bytes} bytes`)

    const header = readHeader(options.backupPath, SQLITE_MAGIC.length)
    if (!header.equals(SQLITE_MAGIC)) throw new RestoreError(`Backup is not a SQLite database (bad header): ${options.backupPath}`)
    checks.push('SQLite file header present')

    if (options.expectedSha256) {
        const actual = sha256File(options.backupPath)
        if (actual !== options.expectedSha256) {
            throw new RestoreError(
                `Backup no longer matches the hash recorded when it was verified.\n  expected ${options.expectedSha256}\n  actual   ${actual}\n` +
                    'Refusing to restore a file that has changed since verification (§8.1).'
            )
        }
        checks.push(`sha256 matches the verified backup (${actual.slice(0, 16)}…)`)
    }

    if (!options.ignoreOpenConnectionEvidence) {
        const sidecars = [`${options.targetPath}-wal`, `${options.targetPath}-shm`].filter((file) => fs.existsSync(file))
        if (sidecars.length > 0) {
            throw new RestoreError(
                `${sidecars.join(' and ')} exist, which means a connection is (or was) open on ${options.targetPath}. ` +
                    'Stop the server before restoring — overwriting a live SQLite file corrupts it silently rather than ' +
                    'failing. Pass ignoreOpenConnectionEvidence only after confirming nothing is attached.'
            )
        }
        checks.push('no -wal/-shm sidecars: no evidence of an open connection')
    }

    let safetyCopyPath: string | null = null
    if (options.safetyCopy !== false && fs.existsSync(options.targetPath)) {
        safetyCopyPath = `${options.targetPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`
        fs.copyFileSync(options.targetPath, safetyCopyPath)
        checks.push(`current database copied aside to ${safetyCopyPath}`)
    }

    fs.mkdirSync(path.dirname(options.targetPath), { recursive: true })
    fs.copyFileSync(options.backupPath, options.targetPath)
    checks.push(`restored ${bytes} bytes over ${options.targetPath}`)

    const restoredHeader = readHeader(options.targetPath, SQLITE_MAGIC.length)
    if (!restoredHeader.equals(SQLITE_MAGIC))
        throw new RestoreError(`Restore wrote a file that is not a SQLite database: ${options.targetPath}`)
    if (sha256File(options.targetPath) !== sha256File(options.backupPath)) {
        throw new RestoreError(`Restored file does not match the backup byte for byte: ${options.targetPath}`)
    }
    checks.push('restored file matches the backup byte for byte')

    return { restoredFrom: options.backupPath, restoredTo: options.targetPath, bytes, safetyCopyPath, checks }
}

/**
 * The documented restore procedure — §8.5, "Documented restore, tested as part of the release".
 *
 * Printed by the tool on every applied migration so it is in the operator's terminal scrollback at
 * the moment they need it, rather than in a document they will look for later.
 */
export const restoreInstructions = (backup: BackupResult | null, dataDirectory = '<data-dir>'): string => {
    const backupPath = backup?.path ?? '<backup>'
    if (!backup || backup.engine === 'sqlite') {
        return [
            'To restore (REQUIREMENTS-MIGRATION.md §8.5):',
            '',
            '  docker compose stop flowise',
            `  cp ${backupPath} ${dataDirectory}/database.sqlite`,
            '  # revert the image tag',
            '  docker compose up -d --force-recreate --no-deps flowise',
            '',
            backup ? `The backup's sha256 is ${backup.sha256}; restoreSqliteBackup() checks it before overwriting anything.` : ''
        ]
            .filter(Boolean)
            .join('\n')
    }
    const restore =
        backup.engine === 'postgres'
            ? `  pg_restore --clean --if-exists --dbname "$DATABASE_URL" ${backupPath}`
            : `  mysql --host=$DB_HOST --user=$DB_USER --password $DB_NAME < ${backupPath}`
    return [
        `To restore (REQUIREMENTS-MIGRATION.md §8.5) — ${backup.engine}:`,
        '',
        '  docker compose stop flowise',
        restore,
        '  # revert the image tag',
        '  docker compose up -d --force-recreate --no-deps flowise',
        '',
        `${backup.engine} has no transactional DDL (§8.3), so this backup is the ONLY rollback path for a failure`,
        'part-way through the migration. Its sha256 is ' + backup.sha256 + '.'
    ].join('\n')
}
