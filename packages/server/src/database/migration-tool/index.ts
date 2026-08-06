/**
 * Flow-Wiser identity migration tool — REQUIREMENTS-MIGRATION.md.
 *
 * Carries an existing Flowise deployment onto the Apache-2.0 `identity_` schema without losing data
 * and without losing access.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────────────────
 * ```ts
 * import { fromDataSource, migrate, detect } from './database/migration-tool'
 *
 * const db = fromDataSource(appDataSource)
 *
 * // What is this database?
 * console.log(formatDetection(await detect(db)))
 *
 * // What WOULD happen? (This is the default — it writes nothing.)
 * const preview = await migrate(db)
 * console.log(preview.report)
 *
 * // Do it. A verified backup is taken first; §2 and §3a are checked before the commit.
 * const applied = await migrate(db, { dryRun: false, backup: { directory: '/data/backups' } })
 * ```
 *
 * ── Guarantees, and where each is enforced ───────────────────────────────────────────────────
 * | Requirement | Where |
 * | --- | --- |
 * | §1 detect era without a version string | `detect.ts` — schema first, migration ledger as corroboration |
 * | §2 non-user data untouched, verified by count and hash | `fingerprint.ts`, checked inside the transaction |
 * | §3 six-role hierarchy, seeded as explicit grants | `roleMapping.ts` + `BootstrapService.systemRolePermissions` |
 * | §3a organizationId stamped and verified against the workspace | `migrate.ts` `applyTenantStamps` |
 * | §5 bcrypt hash carried, unverifiable hash → disabled account | `migrate.ts` `planCredential` |
 * | §6 mustChangePassword on password accounts, never on SSO-only | `migrate.ts` `applyUsers` |
 * | §8.1 verified backup or no migration | `backup.ts` |
 * | §8.2 dry run by default | `migrate.ts` — `dryRun` defaults to true |
 * | §8.3 transactional where the engine allows | `db.ts` `HAS_TRANSACTIONAL_DDL` |
 * | §8.4 additive; old tables survive | nothing here issues DROP |
 * | §8.5 documented restore | `rollback.ts` `restoreInstructions` |
 *
 * Idempotent: every write is guarded by an existence check on the natural key, and identifiers are
 * preserved rather than reassigned, so a second run is a no-op.
 */
export {
    Database,
    Engine,
    ENGINES,
    HAS_TRANSACTIONAL_DDL,
    TypeOrmDataSourceLike,
    TypeOrmQueryRunnerLike,
    columnExists,
    countRows,
    fromDataSource,
    listColumns,
    listTables,
    normaliseEngine,
    placeholder,
    placeholders,
    quote,
    tableExists,
    uuidColumnType
} from './db'

export {
    AppliedMigration,
    DetectionReport,
    Era,
    IDENTITY_TABLES,
    LEGACY_IDENTITY_MIGRATIONS,
    LEGACY_IDENTITY_TABLES,
    NON_USER_TABLES,
    detect,
    formatDetection,
    hasIdentityDataToMigrate
} from './detect'

export {
    Fingerprint,
    FingerprintComparison,
    FingerprintMismatch,
    FingerprintOptions,
    TableFingerprint,
    captureFingerprint,
    compareFingerprints,
    formatComparison,
    protectedTables,
    recaptureFingerprint
} from './fingerprint'

export {
    LegacyRole,
    MappingRule,
    RoleMappingDecision,
    RoleMappingOptions,
    STOCK_ROLE_NAMES,
    TARGET_ROLE_NAMES,
    formatRoleMapping,
    mapLegacyRole,
    parseLegacyGrants
} from './roleMapping'

export { BackupError, BackupOptions, BackupResult, SQLITE_MAGIC, createVerifiedBackup, formatBackup } from './backup'

export {
    CredentialDisposition,
    MigrateOptions,
    MigrationAbort,
    MigrationAuditAction,
    MigrationPlan,
    MigrationResult,
    PlannedLoginMethod,
    PlannedMembership,
    PlannedOrganization,
    PlannedRoleSeed,
    PlannedTenantStamp,
    PlannedUser,
    PlannedWorkspace,
    PlannedWorkspaceMember,
    TENANT_SCOPED_TABLES,
    formatPlan,
    migrate,
    planMigration
} from './migrate'

export { RestoreError, RestoreOptions, RestoreResult, restoreInstructions, restoreSqliteBackup } from './rollback'
