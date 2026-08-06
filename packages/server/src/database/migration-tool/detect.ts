/**
 * Era detection — REQUIREMENTS-MIGRATION.md §1.
 *
 * ── The problem this solves ──────────────────────────────────────────────────────────────────
 * "Flowise records no product version in the database; the set of applied migrations is the only
 * reliable identifier. Detection must read that table, not a version string." There is no
 * `version` row, no `settings` table, no build stamp — nothing anywhere in the schema says which
 * release wrote it. Two things are observable and both are used here:
 *
 *   1. the contents of the `migrations` table, and
 *   2. which tables actually exist.
 *
 * ── Why table existence is the AUTHORITY and the migration list is corroboration ─────────────
 * Deliberately in that order. The migration table can lie in both directions, and both lies happen
 * in the field:
 *
 *   - A record can be present with the table gone. The cut-over commit that unregistered the eleven
 *     identity migrations (929ec984) leaves exactly this state on a fresh install that never had
 *     them: no record, no table. But an operator who restored a schema-only dump, or who ran
 *     `migration:revert`, gets a record with no table.
 *   - A table can be present with no record. `CREATE TABLE IF NOT EXISTS` in a hand-applied patch,
 *     or a database copied between deployments, produces it.
 *
 * A migration tool that trusted the ledger over the schema would try to read a `user` table that is
 * not there, or skip one that is. So: the era is decided by what is actually in the schema, and the
 * migration list is reported alongside it as the fingerprint §1 asks for — and as a WARNING when
 * the two disagree, because that disagreement is worth an operator's attention before an upgrade
 * rather than after one.
 *
 * ── Provenance of the constants below ────────────────────────────────────────────────────────
 * {@link LEGACY_IDENTITY_MIGRATIONS} is the eleven-name list removed from the four migration index
 * files by commit 929ec984 ("unregister the 11 enterprise migrations from all four engines"), taken
 * from that commit's diff of `database/migrations/<engine>/index.ts`. {@link LEGACY_IDENTITY_TABLES}
 * and the shapes read by `migrate.ts` were recovered from a real production database, not from the
 * sources that created them.
 */
import { columnExists, countRows, Database, listTables, quote, tableExists } from './db'

/**
 * The two eras of §1, plus the two states either side of them that a real tool meets and a
 * two-valued enum would have to misreport.
 */
export enum Era {
    /**
     * No `migrations` table and no Flowise tables. A brand-new data directory, or a database that
     * belongs to something else entirely. Nothing to carry; the caller should bootstrap.
     */
    EMPTY = 'empty',
    /**
     * §1: "Pre-3.0 (before 2025-05-27) — None. Single shared login via
     * `FLOWISE_USERNAME`/`FLOWISE_PASSWORD`; no `user`, `organization`, `workspace` or `role`
     * tables at all." There are no accounts to carry across, so the identity layer is bootstrapped
     * fresh and every flow, credential and message is left exactly where it is.
     */
    PRE_3_0 = 'pre-3.0',
    /**
     * §1: "3.0+ — `user`, `organization`, `organization_user`, `workspace`, `workspace_user`,
     * `role`, `login_method`, `login_activity`. Carry the existing user(s) across."
     */
    LEGACY_IDENTITY = '3.0+',
    /**
     * A partially-created old identity schema: some of the tables, not all. Reported separately
     * rather than folded into `3.0+`, because the correct response is to stop and look, not to
     * guess which half is authoritative.
     */
    PARTIAL_LEGACY_IDENTITY = 'partial-3.0+'
}

/**
 * The old identity tables (§1). Order is creation order, which is also the order in which their
 * absence becomes informative.
 */
export const LEGACY_IDENTITY_TABLES = [
    'user',
    'organization',
    'organization_user',
    'workspace',
    'workspace_user',
    'role',
    'login_method',
    'login_activity',
    'workspace_shared'
] as const

export type LegacyIdentityTable = (typeof LEGACY_IDENTITY_TABLES)[number]

/**
 * The four tables whose presence together defines the 3.0+ era. `login_method`, `login_activity`
 * and `workspace_shared` are excluded from the test: they arrived at different points in the chain
 * and a 3.0 database can legitimately lack one.
 */
const ERA_DEFINING_TABLES: readonly LegacyIdentityTable[] = ['user', 'organization', 'workspace', 'role']

/**
 * The eleven migration names that create and extend the old identity schema, from the diff of
 * commit 929ec984. Used only as corroboration — see the file header.
 */
export const LEGACY_IDENTITY_MIGRATIONS = [
    'AddAuthTables1720230151482',
    'AddWorkspace1720230151484',
    'AddWorkspaceShared1726654922034',
    'AddWorkspaceIdToCustomTemplate1726655750383',
    'AddOrganization1727798417345',
    'LinkWorkspaceId1729130948686',
    'LinkOrganizationId1729133111652',
    'AddSSOColumns1730519457880',
    'AddPersonalWorkspace1734074497540',
    'RefactorEnterpriseDatabase1737076223692',
    'ExecutionLinkWorkspaceId1746862866554'
] as const

/** The `identity_`-prefixed tables this fork's own migrations create. */
export const IDENTITY_TABLES = [
    'identity_user',
    'identity_organization',
    'identity_organization_user',
    'identity_workspace',
    'identity_workspace_user',
    'identity_role',
    'identity_login_method',
    'identity_session',
    'identity_token',
    'identity_mfa_factor',
    'identity_mfa_recovery_code',
    'identity_audit_event'
] as const

/**
 * Tables the identity migration must not touch (§2). Every one of these keeps its rows, its
 * ciphertext and its encryption key.
 *
 * The ten §3a names come first because they are also the tenant-scoped set; the rest follow. Any
 * table present in the schema that is neither here, nor an old identity table, nor an
 * `identity_`-prefixed one, is still fingerprinted — see `fingerprint.ts`, which discovers rather
 * than assumes, so a table added after this list was written is still protected.
 */
export const NON_USER_TABLES = [
    'chat_flow',
    'credential',
    'tool',
    'assistant',
    'document_store',
    'variable',
    'apikey',
    'dataset',
    'evaluation',
    'custom_template',
    'chat_message',
    'chat_message_feedback',
    'document_store_file_chunk',
    'dataset_row',
    'evaluation_run',
    'evaluator',
    'execution',
    'lead',
    'upsert_history',
    'custom_mcp_server',
    'schedule_record',
    'schedule_trigger_log'
] as const

/** One row of the `migrations` table. */
export interface AppliedMigration {
    timestamp: number
    name: string
}

export interface DetectionReport {
    era: Era
    engine: string
    /** False when there is no `migrations` table at all — a database TypeORM has never touched. */
    migrationsTablePresent: boolean
    /** §1: "A current 3.1.x database has applied 57." */
    appliedMigrationCount: number
    appliedMigrations: AppliedMigration[]
    /** Which of {@link LEGACY_IDENTITY_MIGRATIONS} are recorded as applied. */
    legacyIdentityMigrationsApplied: string[]
    /** Which of {@link LEGACY_IDENTITY_TABLES} exist, with their row counts. */
    legacyIdentityTables: { table: string; present: boolean; rows: number }[]
    /** Which `identity_` tables this fork's migrations have already created. */
    identityTablesPresent: string[]
    identityTablesMissing: string[]
    /** True once `identity_user` holds at least one row — the migration is then a re-run (§ idempotency). */
    identitySchemaPopulated: boolean
    /** Row counts for the §2 non-user tables that exist. */
    nonUserTables: { table: string; rows: number }[]
    /** Tables that carry `workspaceId` and are therefore tenant-scoped (§3a). */
    workspaceScopedTables: string[]
    /** Tables that already carry the denormalised `organizationId` of §3a. */
    tenantStampedTables: string[]
    /**
     * Disagreements between the migration ledger and the schema, and anything else an operator
     * should read before running the upgrade. Never fatal on its own — detection reports, it does
     * not decide.
     */
    warnings: string[]
}

const readAppliedMigrations = async (db: Database): Promise<AppliedMigration[]> => {
    const rows = await db.query(`SELECT timestamp, name FROM ${quote(db.engine, 'migrations')} ORDER BY timestamp ASC`)
    return rows.map((row) => ({ timestamp: Number(row.timestamp ?? row.TIMESTAMP), name: String(row.name ?? row.NAME) }))
}

/**
 * Inspect `db` and report what era it is in and what is in it. Reads only; safe on a live database.
 */
export const detect = async (db: Database): Promise<DetectionReport> => {
    const warnings: string[] = []
    const tables = await listTables(db)
    const present = new Set(tables.map((name) => name.toLowerCase()))
    const has = (name: string): boolean => present.has(name.toLowerCase())

    const migrationsTablePresent = has('migrations')
    const appliedMigrations = migrationsTablePresent ? await readAppliedMigrations(db) : []
    const appliedNames = new Set(appliedMigrations.map((migration) => migration.name))
    const legacyIdentityMigrationsApplied = LEGACY_IDENTITY_MIGRATIONS.filter((name) => appliedNames.has(name))

    const legacyIdentityTables = await Promise.all(
        LEGACY_IDENTITY_TABLES.map(async (table) => ({
            table,
            present: has(table),
            rows: has(table) ? await countRows(db, table) : 0
        }))
    )
    const legacyPresent = new Set(legacyIdentityTables.filter((entry) => entry.present).map((entry) => entry.table))

    const identityTablesPresent = IDENTITY_TABLES.filter((table) => has(table))
    const identityTablesMissing = IDENTITY_TABLES.filter((table) => !has(table))
    const identitySchemaPopulated = has('identity_user') ? (await countRows(db, 'identity_user')) > 0 : false

    const nonUserTables = await Promise.all(
        NON_USER_TABLES.filter((table) => has(table)).map(async (table) => ({ table, rows: await countRows(db, table) }))
    )

    // Tenant scope is discovered from the schema, not from a list: any table carrying `workspaceId`
    // is tenant-scoped whether or not §3a happened to name it.
    const workspaceScopedTables: string[] = []
    const tenantStampedTables: string[] = []
    for (const table of tables) {
        if (table.toLowerCase().startsWith('identity_')) continue
        if ((LEGACY_IDENTITY_TABLES as readonly string[]).includes(table.toLowerCase())) continue
        if (await columnExists(db, table, 'workspaceId')) {
            workspaceScopedTables.push(table)
            if (await columnExists(db, table, 'organizationId')) tenantStampedTables.push(table)
        }
    }

    // ── Era decision. Schema first; the ledger only ever adds a warning. ──────────────────────
    const eraDefiningPresent = ERA_DEFINING_TABLES.filter((table) => legacyPresent.has(table))
    let era: Era
    if (!migrationsTablePresent && legacyPresent.size === 0 && nonUserTables.length === 0) {
        era = Era.EMPTY
    } else if (eraDefiningPresent.length === 0) {
        era = Era.PRE_3_0
    } else if (eraDefiningPresent.length === ERA_DEFINING_TABLES.length) {
        era = Era.LEGACY_IDENTITY
    } else {
        era = Era.PARTIAL_LEGACY_IDENTITY
        warnings.push(
            `Old identity schema is incomplete: found ${eraDefiningPresent.join(', ')} but not ` +
                `${ERA_DEFINING_TABLES.filter((table) => !legacyPresent.has(table)).join(', ')}. ` +
                'Migration will carry across only what is present; inspect this before proceeding.'
        )
    }

    // ── Ledger vs schema, in both directions. ─────────────────────────────────────────────────
    if (legacyIdentityMigrationsApplied.length > 0 && era === Era.PRE_3_0) {
        warnings.push(
            `The migrations table records ${legacyIdentityMigrationsApplied.length} identity migration(s) as applied ` +
                `(${legacyIdentityMigrationsApplied.join(', ')}) but none of the tables they create exist. ` +
                'The ledger and the schema disagree; the schema is being treated as authoritative.'
        )
    }
    if (legacyIdentityMigrationsApplied.length === 0 && era === Era.LEGACY_IDENTITY) {
        warnings.push(
            'The old identity tables exist but no identity migration is recorded as applied. ' +
                'They were most likely created outside TypeORM; the schema is being treated as authoritative.'
        )
    }
    if (!migrationsTablePresent && nonUserTables.length > 0) {
        warnings.push('No `migrations` table, but Flowise data tables exist. This database was not created by TypeORM.')
    }
    if (identityTablesMissing.length > 0 && era !== Era.EMPTY) {
        warnings.push(
            `${identityTablesMissing.length} of the ${IDENTITY_TABLES.length} identity_* tables are missing ` +
                `(${identityTablesMissing.join(', ')}). Run the TypeORM migrations before migrating identity data.`
        )
    }
    if (identitySchemaPopulated) {
        warnings.push('identity_user already holds rows. This run will be treated as a re-run and will not duplicate anything.')
    }

    return {
        era,
        engine: db.engine,
        migrationsTablePresent,
        appliedMigrationCount: appliedMigrations.length,
        appliedMigrations,
        legacyIdentityMigrationsApplied: [...legacyIdentityMigrationsApplied],
        legacyIdentityTables,
        identityTablesPresent: [...identityTablesPresent],
        identityTablesMissing: [...identityTablesMissing],
        identitySchemaPopulated,
        nonUserTables,
        workspaceScopedTables,
        tenantStampedTables,
        warnings
    }
}

/** True when there are accounts to carry across. */
export const hasIdentityDataToMigrate = (report: DetectionReport): boolean =>
    (report.era === Era.LEGACY_IDENTITY || report.era === Era.PARTIAL_LEGACY_IDENTITY) &&
    report.legacyIdentityTables.some((entry) => entry.present && entry.rows > 0)

/** Human-readable detection summary, used verbatim at the top of the dry-run report. */
export const formatDetection = (report: DetectionReport): string => {
    const lines: string[] = []
    lines.push(`Engine:                 ${report.engine}`)
    lines.push(`Era:                    ${report.era}`)
    lines.push(`Applied migrations:     ${report.appliedMigrationCount}` + (report.migrationsTablePresent ? '' : '  (no migrations table)'))
    lines.push(
        `Identity migrations:    ${report.legacyIdentityMigrationsApplied.length} of ${LEGACY_IDENTITY_MIGRATIONS.length} recorded as applied`
    )
    const legacy = report.legacyIdentityTables.filter((entry) => entry.present)
    lines.push(`Old identity tables:    ${legacy.length ? legacy.map((entry) => `${entry.table}(${entry.rows})`).join(' ') : 'none'}`)
    lines.push(`identity_* tables:      ${report.identityTablesPresent.length} present, ${report.identityTablesMissing.length} missing`)
    lines.push(`Non-user tables:        ${report.nonUserTables.map((entry) => `${entry.table}(${entry.rows})`).join(' ') || 'none'}`)
    lines.push(`Workspace-scoped:       ${report.workspaceScopedTables.join(' ') || 'none'}`)
    lines.push(`Already tenant-stamped: ${report.tenantStampedTables.join(' ') || 'none'}`)
    for (const warning of report.warnings) lines.push(`WARNING: ${warning}`)
    return lines.join('\n')
}
