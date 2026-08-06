/**
 * Identity data migration — REQUIREMENTS-MIGRATION.md §2, §3, §3a, §5, §6, §8.
 *
 * Carries an existing Flowise deployment's accounts onto the Apache-2.0 `identity_` schema without
 * losing data and without losing access.
 *
 * ── The shape of a run ───────────────────────────────────────────────────────────────────────
 *   detect → plan (reads only) → [dry run stops here] → verified backup → fingerprint BEFORE
 *   → apply inside one transaction → fingerprint AFTER, inside the same transaction → commit
 *
 * The AFTER fingerprint runs BEFORE the commit deliberately. §2 says the upgrade "aborts on any
 * mismatch", and an abort that has already committed is not an abort — it is an incident with a
 * good log message. Checking inside the transaction means a §2 violation rolls the whole thing back
 * on the two engines that can, and is at least detected before anyone logs in on the two that
 * cannot.
 *
 * ── Identifiers are PRESERVED, not reassigned ────────────────────────────────────────────────
 * `identity_user.id` is the old `user.id`, `identity_workspace.id` is the old `workspace.id`, and
 * so on. This is the single most important decision in the file. Every tenant-scoped table already
 * carries `workspaceId` pointing at the old `workspace` rows (§3a: "every resource table already
 * carries `workspaceId`"), and §2 forbids rewriting those rows. Minting new workspace ids would
 * therefore orphan all 25 chatflows, all 3 credentials and everything else on the reference
 * database — the data would still be there and nothing would be able to find it. Preserving ids
 * also makes the migration idempotent for free: a second run finds the rows already present by
 * primary key and does nothing.
 *
 * ── What this does NOT touch (§2) ────────────────────────────────────────────────────────────
 * No statement in this file writes to `chat_flow`, `credential`, `chat_message`, `document_store`,
 * `variable`, `apikey`, `tool`, `assistant`, `dataset` or `evaluation` except the §3a tenant-key
 * stamp, which only ever writes a column those tables did not previously have. Credentials keep
 * their ciphertext and their encryption key; nothing here decrypts anything. `fingerprint.ts`
 * proves it rather than asserting it.
 *
 * ── The old tables survive (§8.4) ────────────────────────────────────────────────────────────
 * Additive only. `user`, `organization`, `workspace`, `role` and the rest are read and left exactly
 * as they were. Dropping them is a separate, later, explicitly-invoked step.
 */
import { randomUUID } from 'crypto'
import type { SystemRoleName } from '../../identity/services/BootstrapService'
import { identifyAlgorithm, PasswordAlgorithm } from '../../identity/crypto/passwords'
import { BackupOptions, BackupResult, createVerifiedBackup, formatBackup } from './backup'
import {
    columnExists,
    countRows,
    Database,
    HAS_TRANSACTIONAL_DDL,
    listColumns,
    listTables,
    placeholder,
    quote,
    tableExists,
    uuidColumnType
} from './db'
import { detect, DetectionReport, Era, formatDetection, IDENTITY_TABLES } from './detect'
import {
    captureFingerprint,
    compareFingerprints,
    Fingerprint,
    FingerprintComparison,
    formatComparison,
    recaptureFingerprint
} from './fingerprint'
import { formatRoleMapping, LegacyRole, mapLegacyRole, RoleMappingDecision, RoleMappingOptions, TARGET_ROLE_NAMES } from './roleMapping'

/** Aborts the migration. Every message names the requirement clause it is enforcing. */
export class MigrationAbort extends Error {
    readonly detail?: unknown
    constructor(message: string, detail?: unknown) {
        super(message)
        this.name = 'MigrationAbort'
        this.detail = detail
    }
}

/**
 * The ten tenant-scoped resource tables §3a names, in the order it names them
 * ("`chat_flow` first, then the other nine").
 *
 * Any OTHER table carrying `workspaceId` is stamped too — see {@link MigrateOptions.stampAllWorkspaceScopedTables}.
 * The reference database has four such tables (`execution`, `evaluator`, `custom_mcp_server`,
 * `schedule_record`); leaving them unstamped would leave exactly the hole §3a exists to close.
 */
export const TENANT_SCOPED_TABLES = [
    'chat_flow',
    'credential',
    'tool',
    'assistant',
    'document_store',
    'variable',
    'apikey',
    'dataset',
    'evaluation',
    'custom_template'
] as const

/** Audit actions written by this tool. `<domain>.<object>.<verb>`, matching the AuditEvent vocabulary. */
export const MigrationAuditAction = {
    RUN_START: 'identity.migration.run.start',
    RUN_COMPLETE: 'identity.migration.run.complete',
    ORGANIZATION_CREATE: 'identity.migration.organization.create',
    WORKSPACE_CREATE: 'identity.migration.workspace.create',
    ROLE_SEED: 'identity.migration.role.seed',
    ROLE_MAP: 'identity.migration.role.map',
    USER_CREATE: 'identity.migration.user.create',
    USER_DISABLED: 'identity.migration.user.disabled',
    MEMBERSHIP_CREATE: 'identity.migration.membership.create',
    WORKSPACE_MEMBER_CREATE: 'identity.migration.workspace_member.create',
    LOGIN_METHOD_CREATE: 'identity.migration.login_method.create',
    TENANT_STAMP: 'identity.migration.tenant_key.stamp'
} as const

/** What happened to one account's stored password hash (§5). */
export type CredentialDisposition = 'carried-bcrypt' | 'carried-unverifiable-disabled' | 'absent-sso-or-invited' | 'unrecognised-disabled'

export interface PlannedUser {
    id: string
    email: string
    name: string | null
    /** §5 — what happened to the hash, and why. */
    credential: CredentialDisposition
    credentialAlgorithm: string | null
    /** §6 — set on every migrated PASSWORD account, never on an SSO-only one. */
    mustChangePassword: boolean
    isSSO: boolean
    /** True when the account is migrated disabled and needs `flow-wiser admin:reset-password` (§5, §7). */
    disabled: boolean
    emailVerified: boolean
    exists: boolean
    note: string
}

export interface PlannedOrganization {
    id: string
    name: string
    exists: boolean
    ownerUserId: string | null
    ownerReason: string
}

export interface PlannedWorkspace {
    id: string
    name: string
    organizationId: string
    isOrgDefault: boolean
    exists: boolean
}

export interface PlannedRoleSeed {
    organizationId: string
    name: SystemRoleName
    permissionCount: number
    exists: boolean
}

export interface PlannedMembership {
    organizationId: string
    userId: string
    status: string
    isOrgOwner: boolean
    exists: boolean
}

export interface PlannedWorkspaceMember {
    workspaceId: string
    userId: string
    target: SystemRoleName
    decision: RoleMappingDecision
    exists: boolean
}

export interface PlannedLoginMethod {
    id: string
    organizationId: string | null
    name: string
    status: string
    exists: boolean
}

export interface PlannedTenantStamp {
    table: string
    namedBySection3a: boolean
    addColumn: boolean
    addIndex: boolean
    /** Rows with a workspaceId whose organizationId is not yet set. */
    rowsToStamp: number
    /** Rows whose workspaceId does not resolve to a workspace — they cannot be stamped and are reported. */
    orphanRows: number
}

export interface MigrationPlan {
    detection: DetectionReport
    users: PlannedUser[]
    organizations: PlannedOrganization[]
    workspaces: PlannedWorkspace[]
    roleSeeds: PlannedRoleSeed[]
    memberships: PlannedMembership[]
    workspaceMembers: PlannedWorkspaceMember[]
    loginMethods: PlannedLoginMethod[]
    tenantStamps: PlannedTenantStamp[]
    warnings: string[]
    /** Nothing to do: an already-migrated database, or a pre-3.0 one with no accounts. */
    empty: boolean
}

export interface MigrateOptions {
    /**
     * §8.2: "Dry run by default." Reports exactly what would change and writes nothing.
     * The caller must pass `dryRun: false` deliberately — an omitted flag never mutates a database.
     */
    dryRun?: boolean
    backup?: BackupOptions
    /**
     * Proceed with no backup. Requires an explicit true; §8.1 is otherwise absolute. Provided
     * because a test harness and a throwaway container are real cases, not because it is advisable.
     */
    allowUnsafeNoBackup?: boolean
    roleMapping?: RoleMappingOptions
    /**
     * Supplies the permission list for each of the six §3 system roles when they must be seeded.
     *
     * Defaults to `BootstrapService.systemRolePermissions`, resolved by a LAZY require: importing
     * that module eagerly would pull `utils/logger` into this file's import graph, which builds
     * winston transports and creates a log directory as a side effect of being loaded. A migration
     * tool that cannot be imported without provisioning a logger cannot be tested.
     */
    rolePermissions?: (name: SystemRoleName) => string[]
    /** §3a. On by default; there is no good reason to turn it off outside a test. */
    stampTenancy?: boolean
    /** Stamp every table carrying `workspaceId`, not only the ten §3a names. Default true. */
    stampAllWorkspaceScopedTables?: boolean
    /** Injected for deterministic tests. */
    now?: () => Date
    newId?: () => string
    log?: (line: string) => void
}

export interface MigrationResult {
    dryRun: boolean
    plan: MigrationPlan
    report: string
    backup: BackupResult | null
    fingerprintBefore: Fingerprint | null
    fingerprintAfter: Fingerprint | null
    comparison: FingerprintComparison | null
    /** Counts of rows actually written, per target table. Empty on a dry run. */
    written: Record<string, number>
    /** §3a verification: rows whose tenant key disagrees with their workspace. Must be zero. */
    tenantKeyInconsistencies: { table: string; rows: number }[]
    warnings: string[]
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const defaultRolePermissions = (name: SystemRoleName): string[] => {
    // Lazy on purpose — see MigrateOptions.rolePermissions.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bootstrap = require('../../identity/services/BootstrapService')
    return bootstrap.systemRolePermissions(name)
}

/**
 * `YYYY-MM-DD HH:MM:SS[.fff]` with NO timezone — the form every engine in scope accepts as a
 * datetime literal, and the form the reference database already stores (`2026-08-06 17:21:17.507`).
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/

/**
 * Carry a stored timestamp across UNCHANGED.
 *
 * A naive datetime string is passed through verbatim rather than parsed. `new Date('2026-08-06
 * 17:21:17.507')` interprets a timezone-less string as LOCAL time, and `toISOString()` then converts
 * it to UTC — so on a host at UTC-4 an account's last login silently moves four hours every time the
 * value is copied. That is data corruption performed by a date library, it is invisible in review,
 * and it compounds on every migration. The string is already in the target format; the correct
 * amount of processing is none.
 */
const asTimestamp = (value: unknown, fallback: Date): string => {
    if (typeof value === 'string' && NAIVE_DATETIME.test(value.trim())) return value.trim().replace('T', ' ')
    const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
    const resolved = date && !Number.isNaN(date.getTime()) ? date : fallback
    return resolved.toISOString().replace('T', ' ').replace('Z', '')
}

const asNullableTimestamp = (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'string' && NAIVE_DATETIME.test(value.trim())) return value.trim().replace('T', ' ')
    const date = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(date.getTime()) ? null : date.toISOString().replace('T', ' ').replace('Z', '')
}

const insert = async (db: Database, table: string, row: Record<string, unknown>): Promise<void> => {
    const columns = Object.keys(row)
    const values = columns.map((column) => row[column])
    const marks = columns.map((_, index) => placeholder(db.engine, index + 1)).join(', ')
    const names = columns.map((column) => quote(db.engine, column)).join(', ')
    await db.query(`INSERT INTO ${quote(db.engine, table)} (${names}) VALUES (${marks})`, values)
}

const exists = async (db: Database, table: string, where: Record<string, unknown>): Promise<boolean> => {
    const columns = Object.keys(where)
    const clause = columns.map((column, index) => `${quote(db.engine, column)} = ${placeholder(db.engine, index + 1)}`).join(' AND ')
    const rows = await db.query(`SELECT 1 AS present FROM ${quote(db.engine, table)} WHERE ${clause}`, Object.values(where))
    return rows.length > 0
}

/** `CREATE INDEX IF NOT EXISTS` via the catalog, because MySQL does not support the clause. */
const ensureIndex = async (db: Database, table: string, name: string, columns: readonly string[]): Promise<boolean> => {
    if (db.engine === 'sqlite') {
        const found = await db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${placeholder(db.engine, 1)}`, [name])
        if (found.length > 0) return false
    } else if (db.engine === 'postgres') {
        const found = await db.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${placeholder(db.engine, 1)}`,
            [name]
        )
        if (found.length > 0) return false
    } else {
        const found = await db.query(
            `SELECT index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
            [table, name]
        )
        if (found.length > 0) return false
    }
    const list = columns.map((column) => quote(db.engine, column)).join(', ')
    await db.query(`CREATE INDEX ${quote(db.engine, name)} ON ${quote(db.engine, table)} (${list})`)
    return true
}

const requireIdentitySchema = async (db: Database, detection: DetectionReport): Promise<void> => {
    // Only the tables this tool writes to are strictly required; the session/MFA tables are not
    // touched here, so their absence is a warning from `detect`, not a reason to refuse.
    const needed = [
        'identity_user',
        'identity_organization',
        'identity_organization_user',
        'identity_workspace',
        'identity_workspace_user',
        'identity_role',
        'identity_audit_event'
    ]
    const missing: string[] = []
    for (const table of needed) if (!(await tableExists(db, table))) missing.push(table)
    if (missing.length > 0) {
        throw new MigrationAbort(
            `The identity schema is not present: ${missing.join(', ')} missing. Run the TypeORM migrations ` +
                `(AddIdentityTables1780000000000 and later) before migrating identity data. ` +
                `${detection.identityTablesPresent.length} of ${IDENTITY_TABLES.length} identity_* tables were found.`
        )
    }
    if (!(await columnExists(db, 'identity_user', 'mustChangePassword'))) {
        throw new MigrationAbort(
            'identity_user has no `mustChangePassword` column, so REQUIREMENTS-MIGRATION.md §6 ("any account ' +
                'authenticating by password is flagged after migration") cannot be satisfied. Apply migration ' +
                'AddMustChangePasswordToIdentityUser1780000000010 first.'
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// planning — reads only
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LegacyData {
    users: Record<string, any>[]
    organizations: Record<string, any>[]
    organizationUsers: Record<string, any>[]
    workspaces: Record<string, any>[]
    workspaceUsers: Record<string, any>[]
    roles: Record<string, any>[]
    loginMethods: Record<string, any>[]
}

const readLegacy = async (db: Database): Promise<LegacyData> => {
    const read = async (table: string): Promise<Record<string, any>[]> =>
        (await tableExists(db, table)) ? await db.query(`SELECT * FROM ${quote(db.engine, table)}`) : []
    return {
        users: await read('user'),
        organizations: await read('organization'),
        organizationUsers: await read('organization_user'),
        workspaces: await read('workspace'),
        workspaceUsers: await read('workspace_user'),
        roles: await read('role'),
        loginMethods: await read('login_method')
    }
}

/**
 * Decide what happens to one account's stored hash — §5.
 *
 * "The existing password hash is carried across if its format is verifiable (bcrypt), so the
 * operator is not locked out mid-upgrade. … If the hash format cannot be identified, the account is
 * migrated *disabled* and must be recovered via CLI — never silently left with an unverifiable
 * credential."
 *
 * Four outcomes, and the distinction between the last three is the point:
 *   - bcrypt              → carried verbatim, account stays usable, `mustChangePassword` set (§6).
 *   - argon2id            → the FORMAT is identified but this build has no argon2 backend, so the
 *                           credential is unverifiable HERE. The hash is carried (an argon2-capable
 *                           build would verify it) but the account is migrated disabled, because
 *                           §5's rule is about verifiability, not about recognisability.
 *   - absent              → an SSO-only or invited account. Not a broken credential; there is
 *                           nothing to carry and §6 explicitly does NOT flag it, because "forcing a
 *                           local password change on an SSO-only account is meaningless — there is
 *                           no local password — and would create one where none should exist."
 *   - anything else       → unrecognised. Not carried, account disabled, CLI recovery required.
 */
const planCredential = (credential: unknown): { disposition: CredentialDisposition; algorithm: string | null; carry: string | null } => {
    if (credential === null || credential === undefined || String(credential).trim() === '') {
        return { disposition: 'absent-sso-or-invited', algorithm: null, carry: null }
    }
    const algorithm = identifyAlgorithm(credential)
    if (algorithm === PasswordAlgorithm.BCRYPT) {
        return { disposition: 'carried-bcrypt', algorithm: 'bcrypt', carry: String(credential) }
    }
    if (algorithm === PasswordAlgorithm.ARGON2ID) {
        return { disposition: 'carried-unverifiable-disabled', algorithm: 'argon2id', carry: String(credential) }
    }
    return { disposition: 'unrecognised-disabled', algorithm: null, carry: null }
}

/**
 * Which account owns an organization.
 *
 * Read from the OWNERSHIP EDGE rather than from a role name: the member whose old role grants the
 * coarse `organization` token. Ties break on the earliest membership, because the account that
 * created the organization is the one an operator expects to still be able to log in. If no
 * membership grants it, `organization.createdBy` is the fallback, and if that is not a member
 * either the organization has no owner and the migration says so instead of inventing one.
 */
const resolveOrgOwner = (
    organization: Record<string, any>,
    memberships: Record<string, any>[],
    rolesById: Map<string, LegacyRole>
): { userId: string | null; reason: string } => {
    const members = memberships.filter((row) => String(row.organizationId) === String(organization.id))
    const owners = members.filter((row) => {
        const role = rolesById.get(String(row.roleId))
        if (!role) return false
        try {
            const grants = JSON.parse(role.permissions ?? '[]')
            return Array.isArray(grants) && grants.includes('organization')
        } catch {
            return false
        }
    })
    if (owners.length > 0) {
        const sorted = [...owners].sort((left, right) => String(left.createdDate ?? '').localeCompare(String(right.createdDate ?? '')))
        const role = rolesById.get(String(sorted[0].roleId))
        return {
            userId: String(sorted[0].userId),
            reason:
                `holds the "${role?.name ?? '?'}" role, which grants the coarse \`organization\` token` +
                (owners.length > 1 ? ` (${owners.length} candidates; earliest membership wins)` : '')
        }
    }
    const createdBy = organization.createdBy ? String(organization.createdBy) : null
    if (createdBy && members.some((row) => String(row.userId) === createdBy)) {
        return { userId: createdBy, reason: 'no membership grants organization administration; falling back to organization.createdBy' }
    }
    return { userId: null, reason: 'no owner could be determined — no membership grants organization administration' }
}

/**
 * Which table currently holds the authoritative workspace rows.
 *
 * `identity_workspace` once it has been populated; the old `workspace` table before that. The
 * distinction matters at PLANNING time, when `identity_workspace` exists (the TypeORM migrations
 * created it) but is still empty: resolving against an empty table would report every single
 * resource row as an orphan and produce a report that says the migration is about to fail.
 */
const resolveWorkspaceSource = async (db: Database): Promise<string | null> => {
    if ((await tableExists(db, 'identity_workspace')) && (await countRows(db, 'identity_workspace')) > 0) return 'identity_workspace'
    if (await tableExists(db, 'workspace')) return 'workspace'
    if (await tableExists(db, 'identity_workspace')) return 'identity_workspace'
    return null
}

const planTenantStamps = async (db: Database, detection: DetectionReport, options: MigrateOptions): Promise<PlannedTenantStamp[]> => {
    if (options.stampTenancy === false) return []
    const stampAll = options.stampAllWorkspaceScopedTables !== false
    const named = new Set<string>(TENANT_SCOPED_TABLES)
    const candidates = detection.workspaceScopedTables.filter((table) => stampAll || named.has(table.toLowerCase()))

    const workspaceSource = await resolveWorkspaceSource(db)
    if (!workspaceSource) return []
    const plans: PlannedTenantStamp[] = []
    for (const table of candidates) {
        const hasColumn = await columnExists(db, table, 'organizationId')
        let rowsToStamp = 0
        let orphanRows = 0
        if (hasColumn) {
            const pending = await db.query(
                `SELECT COUNT(*) AS c FROM ${quote(db.engine, table)} WHERE ${quote(db.engine, 'workspaceId')} IS NOT NULL AND ${quote(
                    db.engine,
                    'organizationId'
                )} IS NULL`
            )
            rowsToStamp = Number(pending[0]?.c ?? 0)
        } else {
            const pending = await db.query(
                `SELECT COUNT(*) AS c FROM ${quote(db.engine, table)} WHERE ${quote(db.engine, 'workspaceId')} IS NOT NULL`
            )
            rowsToStamp = Number(pending[0]?.c ?? 0)
        }
        const orphans = await db.query(
            `SELECT COUNT(*) AS c FROM ${quote(db.engine, table)} t WHERE t.${quote(db.engine, 'workspaceId')} IS NOT NULL ` +
                `AND NOT EXISTS (SELECT 1 FROM ${quote(db.engine, workspaceSource)} w WHERE w.${quote(db.engine, 'id')} = t.${quote(
                    db.engine,
                    'workspaceId'
                )})`
        )
        orphanRows = Number(orphans[0]?.c ?? 0)
        plans.push({
            table,
            namedBySection3a: named.has(table.toLowerCase()),
            addColumn: !hasColumn,
            addIndex: true,
            rowsToStamp,
            orphanRows
        })
    }
    return plans
}

/** Build the whole plan. Reads only — nothing in this function or anything it calls writes. */
export const planMigration = async (db: Database, options: MigrateOptions = {}): Promise<MigrationPlan> => {
    const detection = await detect(db)
    const warnings: string[] = [...detection.warnings]
    const rolePermissions = options.rolePermissions ?? defaultRolePermissions

    const legacy = detection.era === Era.PRE_3_0 || detection.era === Era.EMPTY ? null : await readLegacy(db)
    const rolesById = new Map<string, LegacyRole>()
    for (const role of legacy?.roles ?? []) {
        rolesById.set(String(role.id), {
            id: String(role.id),
            name: String(role.name),
            permissions: role.permissions === null || role.permissions === undefined ? null : String(role.permissions),
            organizationId: role.organizationId ? String(role.organizationId) : null
        })
    }

    const users: PlannedUser[] = []
    const organizations: PlannedOrganization[] = []
    const workspaces: PlannedWorkspace[] = []
    const roleSeeds: PlannedRoleSeed[] = []
    const memberships: PlannedMembership[] = []
    const workspaceMembers: PlannedWorkspaceMember[] = []
    const loginMethods: PlannedLoginMethod[] = []

    if (legacy) {
        // ── organizations and their owners ────────────────────────────────────────────────────
        const ownerByOrg = new Map<string, string | null>()
        for (const organization of legacy.organizations) {
            const owner = resolveOrgOwner(organization, legacy.organizationUsers, rolesById)
            ownerByOrg.set(String(organization.id), owner.userId)
            organizations.push({
                id: String(organization.id),
                name: String(organization.name ?? 'Default Organization'),
                exists: await exists(db, 'identity_organization', { id: String(organization.id) }),
                ownerUserId: owner.userId,
                ownerReason: owner.reason
            })
            if (!owner.userId) {
                warnings.push(
                    `Organization ${organization.id} ("${organization.name}") has no determinable owner, so no account is ` +
                        'promoted to super-admin for it (§5). Provision one with `flow-wiser admin:create --role super-admin`.'
                )
            }
            for (const name of TARGET_ROLE_NAMES) {
                roleSeeds.push({
                    organizationId: String(organization.id),
                    name,
                    permissionCount: rolePermissions(name).length,
                    exists: await exists(db, 'identity_role', { organizationId: String(organization.id), name })
                })
            }
        }

        // ── users ─────────────────────────────────────────────────────────────────────────────
        const ownerIds = new Set([...ownerByOrg.values()].filter((value): value is string => Boolean(value)))
        const ssoEnabledOrgs = new Set(
            legacy.loginMethods
                .filter((row) => String(row.status ?? '').toLowerCase() === 'enable')
                .map((row) => (row.organizationId ? String(row.organizationId) : ''))
        )
        for (const user of legacy.users) {
            const credential = planCredential(user.credential)
            const membership = legacy.organizationUsers.find((row) => String(row.userId) === String(user.id))
            const organizationId = membership ? String(membership.organizationId) : ''
            const sso = credential.disposition === 'absent-sso-or-invited' && (ssoEnabledOrgs.has(organizationId) || ssoEnabledOrgs.has(''))
            const disabled =
                credential.disposition === 'carried-unverifiable-disabled' || credential.disposition === 'unrecognised-disabled'
            const oldStatus = String(user.status ?? '').toLowerCase()
            users.push({
                id: String(user.id),
                email: String(user.email),
                name: user.name === null || user.name === undefined ? null : String(user.name),
                credential: credential.disposition,
                credentialAlgorithm: credential.algorithm,
                // §6: password accounts are flagged, SSO-only accounts are not. A disabled account
                // gets no flag either — it cannot reach the change-password endpoint, and the flag
                // would be a promise the login path cannot keep.
                mustChangePassword: credential.disposition === 'carried-bcrypt',
                isSSO: sso,
                disabled,
                emailVerified: oldStatus === 'active',
                exists: await exists(db, 'identity_user', { id: String(user.id) }),
                note:
                    credential.disposition === 'carried-bcrypt'
                        ? 'bcrypt hash carried across; the existing password still works and a change is forced on first login (§5, §6)'
                        : credential.disposition === 'carried-unverifiable-disabled'
                        ? `hash is ${credential.algorithm} and this build has no backend for it; carried but the account is DISABLED pending \`flow-wiser admin:reset-password\` (§5)`
                        : credential.disposition === 'unrecognised-disabled'
                        ? 'stored hash is in no recognised format; NOT carried and the account is DISABLED pending `flow-wiser admin:reset-password` (§5)'
                        : sso
                        ? 'no local password and SSO is configured; migrated as an SSO account and NOT flagged for password change (§6)'
                        : 'no local password (invited but never registered); migrated without a credential and not flagged (§6)'
            })
            if (disabled) {
                warnings.push(
                    `User ${user.email} is migrated DISABLED: ${
                        credential.disposition === 'unrecognised-disabled'
                            ? 'its stored hash is in no recognised format'
                            : `its ${credential.algorithm} hash cannot be verified by this build`
                    }. Recover with \`flow-wiser admin:reset-password --email ${user.email}\` (§5, §7).`
                )
            }
        }

        // ── workspaces ────────────────────────────────────────────────────────────────────────
        const defaultWorkspaceByOrg = new Map<string, string>()
        for (const workspace of legacy.workspaces) {
            const organizationId = String(workspace.organizationId)
            if (!defaultWorkspaceByOrg.has(organizationId)) defaultWorkspaceByOrg.set(organizationId, String(workspace.id))
            if (String(workspace.name) === 'Default Workspace') defaultWorkspaceByOrg.set(organizationId, String(workspace.id))
        }
        for (const workspace of legacy.workspaces) {
            workspaces.push({
                id: String(workspace.id),
                name: String(workspace.name),
                organizationId: String(workspace.organizationId),
                isOrgDefault: defaultWorkspaceByOrg.get(String(workspace.organizationId)) === String(workspace.id),
                exists: await exists(db, 'identity_workspace', { id: String(workspace.id) })
            })
        }

        // ── memberships ───────────────────────────────────────────────────────────────────────
        for (const membership of legacy.organizationUsers) {
            const organizationId = String(membership.organizationId)
            const userId = String(membership.userId)
            const plannedUser = users.find((entry) => entry.id === userId)
            const status = plannedUser?.disabled ? 'inactive' : String(membership.status ?? 'active').toLowerCase()
            memberships.push({
                organizationId,
                userId,
                status,
                isOrgOwner: ownerByOrg.get(organizationId) === userId,
                exists: await exists(db, 'identity_organization_user', { organizationId, userId })
            })
        }

        // ── workspace membership, and the §5 role mapping ─────────────────────────────────────
        const workspaceOrg = new Map(workspaces.map((workspace) => [workspace.id, workspace.organizationId]))
        for (const assignment of legacy.workspaceUsers) {
            const workspaceId = String(assignment.workspaceId)
            const userId = String(assignment.userId)
            const organizationId = workspaceOrg.get(workspaceId) ?? ''
            const isOrgOwner = ownerByOrg.get(organizationId) === userId
            const decision = mapLegacyRole(rolesById.get(String(assignment.roleId)) ?? null, isOrgOwner, options.roleMapping)
            workspaceMembers.push({
                workspaceId,
                userId,
                target: decision.target,
                decision,
                exists: await exists(db, 'identity_workspace_user', { workspaceId, userId })
            })
        }

        // ── SSO configuration ─────────────────────────────────────────────────────────────────
        for (const method of legacy.loginMethods) {
            loginMethods.push({
                id: String(method.id),
                organizationId: method.organizationId ? String(method.organizationId) : null,
                name: String(method.name).toLowerCase(),
                status: String(method.status ?? 'disable').toLowerCase(),
                exists: await exists(db, 'identity_login_method', { id: String(method.id) })
            })
        }
    }

    const tenantStamps = await planTenantStamps(db, detection, options)
    for (const stamp of tenantStamps) {
        if (stamp.orphanRows > 0) {
            warnings.push(
                `${stamp.table}: ${stamp.orphanRows} row(s) carry a workspaceId that matches no workspace. They cannot be ` +
                    'given a tenant key and will be left with a NULL organizationId; `flow-wiser doctor` will keep reporting them (§3a).'
            )
        }
    }

    const empty =
        users.length === 0 &&
        organizations.length === 0 &&
        workspaces.length === 0 &&
        tenantStamps.every((stamp) => !stamp.addColumn && stamp.rowsToStamp === 0)

    if (detection.era === Era.PRE_3_0) {
        warnings.push(
            'Pre-3.0 database: there are no user, organization, workspace or role tables, so there are no accounts to ' +
                'carry across (§1). Every flow, credential and message is left untouched; provision an administrator with ' +
                'the bootstrap environment or `flow-wiser admin:create --role super-admin` (§4, §7).'
        )
    }
    if (!HAS_TRANSACTIONAL_DDL[db.engine]) {
        warnings.push(
            `${db.engine} does not have transactional DDL: an implicit COMMIT surrounds every schema statement, so a ` +
                'failure part-way through CANNOT be rolled back (§8.3). This path depends on the pre-migration backup. ' +
                'The migration is additive only (§8.4), so a half-applied schema is still readable by the previous build.'
        )
    }

    return {
        detection,
        users,
        organizations,
        workspaces,
        roleSeeds,
        memberships,
        workspaceMembers,
        loginMethods,
        tenantStamps,
        warnings,
        empty
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// applying
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ApplyContext {
    db: Database
    plan: MigrationPlan
    options: MigrateOptions
    now: Date
    newId: () => string
    written: Record<string, number>
    roleIdByOrgAndName: Map<string, string>
}

const count = (context: ApplyContext, table: string, by = 1): void => {
    context.written[table] = (context.written[table] ?? 0) + by
}

const audit = async (
    context: ApplyContext,
    action: string,
    fields: {
        targetType?: string
        targetId?: string
        organizationId?: string | null
        workspaceId?: string | null
        subjectLabel?: string | null
        message: string
        detail?: unknown
        outcome?: 'success' | 'failure'
    }
): Promise<void> => {
    await insert(context.db, 'identity_audit_event', {
        id: context.newId(),
        // The migration is not a person. §10's vocabulary has a value for exactly this — "bootstrap,
        // migrations, scheduled jobs, key rotation passes".
        subjectType: 'system',
        subjectId: null,
        subjectLabel: fields.subjectLabel ?? 'migration-tool',
        sessionId: null,
        action,
        targetType: fields.targetType ?? null,
        targetId: fields.targetId ?? null,
        occurredAt: asTimestamp(context.now, context.now),
        ipAddress: null,
        userAgent: null,
        route: null,
        organizationId: fields.organizationId ?? null,
        workspaceId: fields.workspaceId ?? null,
        outcome: fields.outcome ?? 'success',
        reason: null,
        message: fields.message,
        detail: fields.detail === undefined ? null : JSON.stringify(fields.detail),
        versionCommitId: null
    })
    count(context, 'identity_audit_event')
}

const applyOrganizations = async (context: ApplyContext, legacy: LegacyData): Promise<void> => {
    const byId = new Map(legacy.organizations.map((row) => [String(row.id), row]))
    for (const planned of context.plan.organizations) {
        if (await exists(context.db, 'identity_organization', { id: planned.id })) continue
        const source = byId.get(planned.id) ?? {}
        await insert(context.db, 'identity_organization', {
            id: planned.id,
            name: planned.name,
            subscriptionId: source.subscriptionId ?? null,
            customerId: source.customerId ?? null,
            createdBy: source.createdBy ?? null,
            updatedBy: source.updatedBy ?? null,
            createdDate: asTimestamp(source.createdDate, context.now),
            updatedDate: asTimestamp(source.updatedDate, context.now)
        })
        count(context, 'identity_organization')
        await audit(context, MigrationAuditAction.ORGANIZATION_CREATE, {
            targetType: 'organization',
            targetId: planned.id,
            organizationId: planned.id,
            message: `Carried organization "${planned.name}" across, preserving its id`,
            detail: { ownerUserId: planned.ownerUserId, ownerReason: planned.ownerReason }
        })
    }
}

const applyRoleSeeds = async (context: ApplyContext): Promise<void> => {
    const rolePermissions = context.options.rolePermissions ?? defaultRolePermissions
    for (const seed of context.plan.roleSeeds) {
        const key = `${seed.organizationId} ${seed.name}`
        const found = await context.db.query(
            `SELECT ${quote(context.db.engine, 'id')} FROM ${quote(context.db.engine, 'identity_role')} WHERE ${quote(
                context.db.engine,
                'organizationId'
            )} = ${placeholder(context.db.engine, 1)} AND ${quote(context.db.engine, 'name')} = ${placeholder(context.db.engine, 2)}`,
            [seed.organizationId, seed.name]
        )
        if (found.length > 0) {
            context.roleIdByOrgAndName.set(key, String(found[0].id))
            continue
        }
        const id = context.newId()
        const permissions = rolePermissions(seed.name)
        await insert(context.db, 'identity_role', {
            id,
            name: seed.name,
            description: `Seeded by the identity migration (REQUIREMENTS-MIGRATION.md §3).`,
            permissions: JSON.stringify(permissions),
            organizationId: seed.organizationId,
            // §3: "Seeded roles are marked isSystem to refuse accidental deletion while remaining editable."
            isSystem: true,
            createdBy: null,
            updatedBy: null,
            createdDate: asTimestamp(context.now, context.now),
            updatedDate: asTimestamp(context.now, context.now)
        })
        context.roleIdByOrgAndName.set(key, id)
        count(context, 'identity_role')
        await audit(context, MigrationAuditAction.ROLE_SEED, {
            targetType: 'role',
            targetId: id,
            organizationId: seed.organizationId,
            message: `Seeded system role "${seed.name}" with ${permissions.length} permission(s)`,
            detail: { permissions }
        })
    }
}

const applyUsers = async (context: ApplyContext, legacy: LegacyData): Promise<void> => {
    const byId = new Map(legacy.users.map((row) => [String(row.id), row]))
    for (const planned of context.plan.users) {
        if (await exists(context.db, 'identity_user', { id: planned.id })) continue
        const source = byId.get(planned.id) ?? {}
        const credential = planCredential(source.credential)
        await insert(context.db, 'identity_user', {
            id: planned.id,
            name: planned.name,
            email: planned.email,
            // §2 in spirit: the hash is moved, never recomputed. Re-hashing would need the
            // plaintext, which nobody has, and would lock the operator out — the exact outcome §5
            // exists to prevent.
            credential: credential.carry,
            isSSO: planned.isSSO,
            pendingEmail: null,
            emailVerifiedDate: planned.emailVerified ? asTimestamp(source.createdDate, context.now) : null,
            credentialUpdatedDate: null,
            referral: null,
            mustChangePassword: planned.mustChangePassword,
            createdDate: asTimestamp(source.createdDate, context.now),
            updatedDate: asTimestamp(source.updatedDate, context.now)
        })
        count(context, 'identity_user')
        await audit(context, MigrationAuditAction.USER_CREATE, {
            targetType: 'user',
            targetId: planned.id,
            subjectLabel: planned.email,
            message: `Carried account ${planned.email} across: ${planned.note}`,
            detail: {
                credential: planned.credential,
                algorithm: planned.credentialAlgorithm,
                mustChangePassword: planned.mustChangePassword,
                isSSO: planned.isSSO,
                disabled: planned.disabled
            }
        })
        if (planned.disabled) {
            await audit(context, MigrationAuditAction.USER_DISABLED, {
                targetType: 'user',
                targetId: planned.id,
                subjectLabel: planned.email,
                outcome: 'failure',
                message: `Account ${planned.email} migrated DISABLED — ${planned.note}`,
                detail: { recovery: `flow-wiser admin:reset-password --email ${planned.email}` }
            })
        }
    }
}

const applyWorkspaces = async (context: ApplyContext, legacy: LegacyData): Promise<void> => {
    const byId = new Map(legacy.workspaces.map((row) => [String(row.id), row]))
    for (const planned of context.plan.workspaces) {
        if (await exists(context.db, 'identity_workspace', { id: planned.id })) continue
        const source = byId.get(planned.id) ?? {}
        await insert(context.db, 'identity_workspace', {
            id: planned.id,
            name: planned.name,
            description: source.description ?? null,
            organizationId: planned.organizationId,
            isOrgDefault: planned.isOrgDefault,
            createdBy: source.createdBy ?? null,
            updatedBy: source.updatedBy ?? null,
            createdDate: asTimestamp(source.createdDate, context.now),
            updatedDate: asTimestamp(source.updatedDate, context.now)
        })
        count(context, 'identity_workspace')
        await audit(context, MigrationAuditAction.WORKSPACE_CREATE, {
            targetType: 'workspace',
            targetId: planned.id,
            organizationId: planned.organizationId,
            workspaceId: planned.id,
            message: `Carried workspace "${planned.name}" across, preserving its id so every workspaceId already on chat_flow, credential and the rest still resolves`
        })
    }
}

const applyMemberships = async (context: ApplyContext, legacy: LegacyData): Promise<void> => {
    const byKey = new Map(legacy.organizationUsers.map((row) => [`${row.organizationId} ${row.userId}`, row]))
    for (const planned of context.plan.memberships) {
        if (await exists(context.db, 'identity_organization_user', { organizationId: planned.organizationId, userId: planned.userId }))
            continue
        const source = byKey.get(`${planned.organizationId} ${planned.userId}`) ?? {}
        // §F-1: lastLogin belongs to the membership, and upstream stored it on workspace_user.
        // Take the most recent across the user's workspaces in this organization so the "Never"
        // that the users table would otherwise render is not a fresh lie.
        const workspaceIds = context.plan.workspaces
            .filter((workspace) => workspace.organizationId === planned.organizationId)
            .map((workspace) => workspace.id)
        const lastLogins = legacy.workspaceUsers
            .filter((row) => String(row.userId) === planned.userId && workspaceIds.includes(String(row.workspaceId)))
            .map((row) => asNullableTimestamp(row.lastLogin))
            .filter((value): value is string => Boolean(value))
            .sort()
        await insert(context.db, 'identity_organization_user', {
            organizationId: planned.organizationId,
            userId: planned.userId,
            status: planned.status,
            lastLogin: lastLogins.length > 0 ? lastLogins[lastLogins.length - 1] : null,
            isOrgOwner: planned.isOrgOwner,
            createdBy: source.createdBy ?? null,
            updatedBy: source.updatedBy ?? null,
            createdDate: asTimestamp(source.createdDate, context.now),
            updatedDate: asTimestamp(source.updatedDate, context.now)
        })
        count(context, 'identity_organization_user')
        await audit(context, MigrationAuditAction.MEMBERSHIP_CREATE, {
            targetType: 'organization_user',
            targetId: `${planned.organizationId}/${planned.userId}`,
            organizationId: planned.organizationId,
            message: `Carried membership across with status "${planned.status}"${planned.isOrgOwner ? ' as the organization owner' : ''}`,
            detail: { isOrgOwner: planned.isOrgOwner, status: planned.status }
        })
    }
}

const applyWorkspaceMembers = async (context: ApplyContext, legacy: LegacyData): Promise<void> => {
    const byKey = new Map(legacy.workspaceUsers.map((row) => [`${row.workspaceId} ${row.userId}`, row]))
    const orgByWorkspace = new Map(context.plan.workspaces.map((workspace) => [workspace.id, workspace.organizationId]))
    for (const planned of context.plan.workspaceMembers) {
        if (await exists(context.db, 'identity_workspace_user', { workspaceId: planned.workspaceId, userId: planned.userId })) continue
        const organizationId = orgByWorkspace.get(planned.workspaceId) ?? ''
        const roleId = context.roleIdByOrgAndName.get(`${organizationId} ${planned.target}`)
        if (!roleId) {
            throw new MigrationAbort(
                `Role "${planned.target}" is not seeded for organization ${organizationId}, so the assignment for user ` +
                    `${planned.userId} in workspace ${planned.workspaceId} cannot be written. Aborting rather than leaving ` +
                    'an unscoped membership (§3).'
            )
        }
        const source = byKey.get(`${planned.workspaceId} ${planned.userId}`) ?? {}
        await insert(context.db, 'identity_workspace_user', {
            workspaceId: planned.workspaceId,
            userId: planned.userId,
            roleId,
            createdBy: source.createdBy ?? null,
            updatedBy: source.updatedBy ?? null,
            createdDate: asTimestamp(source.createdDate, context.now),
            updatedDate: asTimestamp(source.updatedDate, context.now)
        })
        count(context, 'identity_workspace_user')
        // §5: "The mapping is written to the audit trail and printed in the dry-run report."
        await audit(context, MigrationAuditAction.ROLE_MAP, {
            targetType: 'workspace_user',
            targetId: `${planned.workspaceId}/${planned.userId}`,
            organizationId,
            workspaceId: planned.workspaceId,
            message: `Mapped "${planned.decision.legacyRoleName}" to "${planned.target}" — ${planned.decision.reason}`,
            detail: {
                legacyRoleId: planned.decision.legacyRoleId,
                legacyRoleName: planned.decision.legacyRoleName,
                legacyGrantCount: planned.decision.legacyGrantCount,
                rule: planned.decision.rule,
                target: planned.target
            }
        })
    }
}

/**
 * SSO configuration.
 *
 * The outgoing `login_method.config` is a single opaque blob that holds the client secret alongside
 * the non-secret fields; the new `identity_login_method` splits them. The blob is carried VERBATIM
 * into `config` and nothing is decrypted, re-encrypted or split apart here — §2's rule about
 * ciphertext applies to this secret exactly as it does to `credential`. Splitting it is a separate
 * operation the SSO screen performs when the provider is next saved.
 */
const applyLoginMethods = async (context: ApplyContext, legacy: LegacyData): Promise<void> => {
    if (!(await tableExists(context.db, 'identity_login_method'))) return
    const byId = new Map(legacy.loginMethods.map((row) => [String(row.id), row]))
    for (const planned of context.plan.loginMethods) {
        if (await exists(context.db, 'identity_login_method', { id: planned.id })) continue
        const source = byId.get(planned.id) ?? {}
        await insert(context.db, 'identity_login_method', {
            id: planned.id,
            organizationId: planned.organizationId,
            name: planned.name,
            providerLabel: null,
            status: planned.status === 'enable' ? 'enable' : 'disable',
            config: source.config ?? null,
            clientSecret: null,
            userId: source.createdBy ?? null,
            createdDate: asTimestamp(source.createdDate, context.now),
            updatedDate: asTimestamp(source.updatedDate, context.now)
        })
        count(context, 'identity_login_method')
        await audit(context, MigrationAuditAction.LOGIN_METHOD_CREATE, {
            targetType: 'login_method',
            targetId: planned.id,
            organizationId: planned.organizationId,
            message: `Carried SSO provider "${planned.name}" across with status "${planned.status}"; its config blob was moved verbatim and not decrypted`
        })
    }
}

/**
 * §3a — stamp `organizationId` onto every tenant-scoped resource row, derived from
 * `workspace.organizationId`, and index `(organizationId, workspaceId)`.
 *
 * The column is ADDED, never replaced, and the value is DERIVED, never taken from anywhere else —
 * which is what makes this safe under §2: the pre-existing columns of these tables are not read,
 * not rewritten, and not re-encrypted. `fingerprint.ts` pins the pre-existing column set precisely
 * so this stamp is visible to a human and invisible to the integrity check.
 */
const applyTenantStamps = async (context: ApplyContext): Promise<{ table: string; rows: number }[]> => {
    const db = context.db
    const inconsistencies: { table: string; rows: number }[] = []
    const workspaceSource = await resolveWorkspaceSource(db)
    if (!workspaceSource) return inconsistencies

    for (const stamp of context.plan.tenantStamps) {
        if (stamp.addColumn && !(await columnExists(db, stamp.table, 'organizationId'))) {
            await db.query(
                `ALTER TABLE ${quote(db.engine, stamp.table)} ADD COLUMN ${quote(db.engine, 'organizationId')} ${uuidColumnType(db.engine)}`
            )
        }
        // §3a: "A composite index (organizationId, workspaceId) on each, so the common scoped query
        // needs no join at all."
        await ensureIndex(db, stamp.table, `IDX_${stamp.table}_org_ws`, ['organizationId', 'workspaceId'])

        const updated = await db.query(
            `UPDATE ${quote(db.engine, stamp.table)} SET ${quote(db.engine, 'organizationId')} = ` +
                `(SELECT w.${quote(db.engine, 'organizationId')} FROM ${quote(db.engine, workspaceSource)} w ` +
                `WHERE w.${quote(db.engine, 'id')} = ${quote(db.engine, stamp.table)}.${quote(db.engine, 'workspaceId')}) ` +
                `WHERE ${quote(db.engine, 'workspaceId')} IS NOT NULL AND ${quote(db.engine, 'organizationId')} IS NULL`
        )
        void updated
        if (stamp.rowsToStamp > 0) {
            count(context, stamp.table, stamp.rowsToStamp)
            await audit(context, MigrationAuditAction.TENANT_STAMP, {
                targetType: 'table',
                targetId: stamp.table,
                message: `Stamped organizationId onto ${stamp.rowsToStamp} row(s) of ${stamp.table}, derived from workspace.organizationId (§3a)`,
                detail: { addedColumn: stamp.addColumn, orphanRows: stamp.orphanRows }
            })
        }

        // §3a: "Consistency is enforced, not assumed. resource.organizationId must always equal
        // workspace.organizationId for its workspace." Verified here and again by `flow-wiser doctor`.
        const disagreeing = await db.query(
            `SELECT COUNT(*) AS c FROM ${quote(db.engine, stamp.table)} t ` +
                `JOIN ${quote(db.engine, workspaceSource)} w ON w.${quote(db.engine, 'id')} = t.${quote(db.engine, 'workspaceId')} ` +
                `WHERE t.${quote(db.engine, 'organizationId')} IS NULL OR t.${quote(db.engine, 'organizationId')} <> w.${quote(
                    db.engine,
                    'organizationId'
                )}`
        )
        const rows = Number(disagreeing[0]?.c ?? 0)
        if (rows > 0) inconsistencies.push({ table: stamp.table, rows })
    }
    return inconsistencies
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// reporting
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const formatPlan = (plan: MigrationPlan): string => {
    const lines: string[] = []
    lines.push('── Detection ─────────────────────────────────────────────────────────────────')
    lines.push(formatDetection(plan.detection))
    lines.push('')
    lines.push('── Accounts (§5) ─────────────────────────────────────────────────────────────')
    if (plan.users.length === 0) lines.push('  (none — nothing to carry across)')
    for (const user of plan.users) {
        lines.push(
            `  ${user.exists ? 'SKIP' : 'CREATE'} ${user.email.padEnd(32)} credential=${user.credential}` +
                `${user.credentialAlgorithm ? `(${user.credentialAlgorithm})` : ''}` +
                ` mustChangePassword=${user.mustChangePassword} isSSO=${user.isSSO}${user.disabled ? ' DISABLED' : ''}`
        )
        lines.push(`      ${user.note}`)
    }
    lines.push('')
    lines.push('── Organizations and workspaces ──────────────────────────────────────────────')
    for (const organization of plan.organizations) {
        lines.push(`  ${organization.exists ? 'SKIP' : 'CREATE'} organization ${organization.id} "${organization.name}"`)
        lines.push(`      owner: ${organization.ownerUserId ?? '(none)'} — ${organization.ownerReason}`)
    }
    for (const workspace of plan.workspaces) {
        lines.push(
            `  ${workspace.exists ? 'SKIP' : 'CREATE'} workspace ${workspace.id} "${workspace.name}"` +
                ` org=${workspace.organizationId}${workspace.isOrgDefault ? ' (org default)' : ''}`
        )
    }
    lines.push('')
    lines.push('── Seeded roles (§3) ─────────────────────────────────────────────────────────')
    for (const seed of plan.roleSeeds) {
        lines.push(`  ${seed.exists ? 'SKIP' : 'SEED'}   ${seed.name.padEnd(12)} org=${seed.organizationId} ${seed.permissionCount} grants`)
    }
    lines.push('')
    lines.push('── Role mapping (§5) ─────────────────────────────────────────────────────────')
    lines.push(
        formatRoleMapping(
            plan.workspaceMembers.map((member) => ({
                ...member.decision,
                subject: member.userId,
                scope: `workspace ${member.workspaceId.slice(0, 8)}…`
            }))
        )
    )
    lines.push('')
    lines.push('── Tenant key (§3a) ──────────────────────────────────────────────────────────')
    if (plan.tenantStamps.length === 0) lines.push('  (no workspace-scoped tables found)')
    for (const stamp of plan.tenantStamps) {
        lines.push(
            `  ${stamp.table.padEnd(20)} ${stamp.addColumn ? 'ADD COLUMN organizationId' : 'column present'}` +
                `, index (organizationId, workspaceId), stamp ${stamp.rowsToStamp} row(s)` +
                `${stamp.orphanRows > 0 ? `, ${stamp.orphanRows} ORPHAN row(s)` : ''}` +
                `${stamp.namedBySection3a ? '' : '  [not named by §3a; stamped because it carries workspaceId]'}`
        )
    }
    if (plan.warnings.length > 0) {
        lines.push('')
        lines.push('── Warnings ──────────────────────────────────────────────────────────────────')
        for (const warning of plan.warnings) lines.push(`  ! ${warning}`)
    }
    return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// the entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Migrate identity data onto the `identity_` schema.
 *
 * **Writes nothing unless `dryRun: false` is passed explicitly** (§8.2).
 */
export const migrate = async (db: Database, options: MigrateOptions = {}): Promise<MigrationResult> => {
    const dryRun = options.dryRun !== false
    const log = options.log ?? (() => undefined)
    const now = options.now ? options.now() : new Date()
    const newId = options.newId ?? randomUUID

    const detection = await detect(db)
    if (detection.era !== Era.EMPTY) await requireIdentitySchema(db, detection)

    const plan = await planMigration(db, options)
    const warnings = [...plan.warnings]

    if (dryRun) {
        const report = [
            '════ DRY RUN — nothing was written (REQUIREMENTS-MIGRATION.md §8.2) ════',
            '',
            formatPlan(plan),
            '',
            'Re-run with dryRun: false to apply. A verified backup is taken first and the migration',
            'aborts if the backup, its verification, or the §2 non-user data check fails.'
        ].join('\n')
        log(report)
        return {
            dryRun: true,
            plan,
            report,
            backup: null,
            fingerprintBefore: null,
            fingerprintAfter: null,
            comparison: null,
            written: {},
            tenantKeyInconsistencies: [],
            warnings
        }
    }

    // ── §8.1 — no backup, no upgrade. ─────────────────────────────────────────────────────────
    let backup: BackupResult | null = null
    if (options.allowUnsafeNoBackup === true) {
        warnings.push('Backup skipped by allowUnsafeNoBackup. REQUIREMENTS-MIGRATION.md §8.1 was deliberately overridden.')
    } else {
        backup = await createVerifiedBackup(db, options.backup)
        log(`Verified backup taken:\n${formatBackup(backup)}`)
    }

    // ── §2 — capture before. ──────────────────────────────────────────────────────────────────
    const fingerprintBefore = await captureFingerprint(db)

    const written: Record<string, number> = {}
    let tenantKeyInconsistencies: { table: string; rows: number }[] = []
    let fingerprintAfter: Fingerprint | null = null
    let comparison: FingerprintComparison | null = null

    const work = async (tx: Database): Promise<void> => {
        const legacy = plan.detection.era === Era.PRE_3_0 || plan.detection.era === Era.EMPTY ? emptyLegacy() : await readLegacy(tx)
        const context: ApplyContext = { db: tx, plan, options, now, newId, written, roleIdByOrgAndName: new Map() }

        await audit(context, MigrationAuditAction.RUN_START, {
            message: `Identity migration started: era=${plan.detection.era}, engine=${tx.engine}, ${plan.users.length} account(s) to carry`,
            detail: { backup: backup ? { path: backup.path, sha256: backup.sha256 } : null }
        })

        await applyOrganizations(context, legacy)
        await applyRoleSeeds(context)
        await applyUsers(context, legacy)
        await applyWorkspaces(context, legacy)
        await applyMemberships(context, legacy)
        await applyWorkspaceMembers(context, legacy)
        await applyLoginMethods(context, legacy)
        tenantKeyInconsistencies = await applyTenantStamps(context)

        if (tenantKeyInconsistencies.length > 0) {
            throw new MigrationAbort(
                'Tenant key verification failed: ' +
                    tenantKeyInconsistencies
                        .map((entry) => `${entry.table} has ${entry.rows} row(s) whose organizationId ` + 'disagrees with their workspace')
                        .join('; ') +
                    ' (§3a). Rolling back.',
                tenantKeyInconsistencies
            )
        }

        await audit(context, MigrationAuditAction.RUN_COMPLETE, {
            message: 'Identity migration completed',
            detail: { written }
        })

        // ── §2 — capture after, INSIDE the transaction, so a mismatch can still roll back. ────
        fingerprintAfter = await recaptureFingerprint(tx, fingerprintBefore)
        comparison = compareFingerprints(fingerprintBefore, fingerprintAfter)
        if (!comparison.identical) {
            throw new MigrationAbort(
                'Non-user data changed during migration, which REQUIREMENTS-MIGRATION.md §2 forbids. Aborting:\n' +
                    formatComparison(comparison),
                comparison.mismatches
            )
        }
    }

    if (db.transaction) {
        await db.transaction(work)
    } else if (HAS_TRANSACTIONAL_DDL[db.engine]) {
        throw new MigrationAbort(
            `${db.engine} supports transactional DDL but the supplied Database has no transaction(). Refusing to run ` +
                'a migration that could not be rolled back on an engine where it could have been (§8.3).'
        )
    } else {
        warnings.push(`Applied without a transaction: ${db.engine} would not have rolled DDL back in any case (§8.3).`)
        await work(db)
    }

    const report = [
        '════ MIGRATION APPLIED ════',
        '',
        formatPlan(plan),
        '',
        '── Backup (§8.1) ─────────────────────────────────────────────────────────────',
        backup ? formatBackup(backup) : '  SKIPPED by allowUnsafeNoBackup',
        '',
        '── Non-user data (§2) ────────────────────────────────────────────────────────',
        comparison ? formatComparison(comparison) : '  (not compared)',
        '',
        '── Rows written ──────────────────────────────────────────────────────────────',
        ...Object.entries(written).map(([table, rows]) => `  ${table.padEnd(32)} ${rows}`),
        '',
        '── Tenant key consistency (§3a) ──────────────────────────────────────────────',
        tenantKeyInconsistencies.length === 0
            ? '  every tenant-scoped row agrees with its workspace'
            : tenantKeyInconsistencies.map((entry) => `  FAIL ${entry.table}: ${entry.rows}`).join('\n'),
        '',
        '── The old tables are still there (§8.4) ─────────────────────────────────────',
        '  user, organization, organization_user, workspace, workspace_user, role, login_method',
        '  are read-only inputs to this tool and were not dropped. Dropping them is a separate,',
        '  later, explicitly-invoked step once the operator is satisfied.'
    ].join('\n')
    log(report)

    return {
        dryRun: false,
        plan,
        report,
        backup,
        fingerprintBefore,
        fingerprintAfter,
        comparison,
        written,
        tenantKeyInconsistencies,
        warnings
    }
}

const emptyLegacy = (): LegacyData => ({
    users: [],
    organizations: [],
    organizationUsers: [],
    workspaces: [],
    workspaceUsers: [],
    roles: [],
    loginMethods: []
})

/** Re-exported so callers do not have to reach into two modules for the common case. */
export { listColumns, listTables, countRows }
