import { Flags } from '@oclif/core'
import { DataSource, QueryRunner } from 'typeorm'
import { AuditOutcome } from '../database/entities/identity/AuditEvent'
import { MfaFactor, MfaFactorStatus, Organization, Role, User, Workspace, WorkspaceUser } from '../database/entities/identity'
import { getAuditHealth } from '../identity/services/AuditService'
import { EnvBootstrapAccountResolver } from '../identity/services/MfaPolicyService'
import { SYSTEM_ROLE_NAMES } from '../identity/services/BootstrapService'
import { RecoveryAuditAction, RecoveryCommand, RecoveryContext, buildRecoveryDataSource, recordRecoveryEvent } from './recovery-base'

/**
 * `flow-wiser doctor` — "diagnose schema/identity state" (REQUIREMENTS-MIGRATION.md §7).
 *
 * The command that answers "what is actually wrong with this instance", run before any of the
 * others. Everything it reports is something that has silently broken a real deployment.
 *
 * ── Why it reads SQL and not entities ────────────────────────────────────────────────────────
 * Every check below is written against the query runner, with `hasTable` / `hasColumn` guards in
 * front of it. `doctor` has to work on a database whose migrations only half-applied — that is one
 * of the states it exists to detect — so it cannot assume any table exists, and a check that throws
 * `no such table` instead of reporting `MISSING` has diagnosed nothing. A missing table is a
 * finding, never an exception.
 *
 * ── The four things it exists to catch ───────────────────────────────────────────────────────
 *
 * 1. **Schema drift.** MIGRATION §1: "The `migrations` table is the version fingerprint. Flowise
 *    records no product version in the database; the set of applied migrations is the only reliable
 *    identifier." So the count and the tail of that table are reported first, and the identity
 *    tables are probed individually rather than inferred from it.
 *
 * 2. **Nobody can log in.** An account with no `WorkspaceUser` authenticates and is then rejected
 *    with 'No Workspace Assigned' (spec §F-12); an instance with no account holding an
 *    instance-wide role has nobody who can fix anything. Both look like a healthy server.
 *
 * 3. **Orphaned tenant keys.** MIGRATION §3a: "`resource.organizationId` must always equal
 *    `workspace.organizationId` for its workspace. Enforced at write time, and verified by
 *    `flow-wiser doctor` (§7), which reports any row whose tenant key disagrees with its
 *    workspace." A row whose denormalised tenant key has drifted is invisible to the UI and is
 *    served to the WRONG TENANT by any query that filters on organization alone — the exact breach
 *    the denormalisation was introduced to make impossible.
 *
 * 4. **Credentials referenced by a flow but missing.** Deleting a credential in the UI does not
 *    check whether any flow uses it and does not warn. One deletion orphaned 37 references across
 *    21 flows in production and took a chatbot down; nothing anywhere in the product reported it,
 *    because a flow only discovers the missing credential when it executes. This check is the
 *    reason that outage is now a one-line finding instead of an afternoon.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
    name: string
    status: DoctorStatus
    summary: string
    /** Indented supporting lines. Truncated to a readable number with a "and N more" tail. */
    details: string[]
}

export interface DoctorReport {
    target: string
    checks: DoctorCheck[]
    failures: number
    warnings: number
}

/** Ten tenant-scoped resource tables (MIGRATION §3a's list, in its order). */
const TENANT_SCOPED_TABLES = [
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
]

/** The identity cluster, as `database/entities/identity` declares it. */
const IDENTITY_TABLES = [
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
]

/** Instance-wide roles — the ones that can repair the instance (REQUIREMENTS-TENANCY-ACCESS §2). */
const INSTANCE_WIDE_ROLES = ['super-admin', 'admin', 'super-user']

const MAX_DETAIL_LINES = 12

const truncate = (lines: string[]): string[] =>
    lines.length <= MAX_DETAIL_LINES ? lines : [...lines.slice(0, MAX_DETAIL_LINES), `… and ${lines.length - MAX_DETAIL_LINES} more`]

/** Anything shaped like a credential id. Keeps the reference walk from flagging prose. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The key names Flowise stores a credential id under, across every generation of its flow format. */
const CREDENTIAL_KEYS = new Set(['credential', 'credentialId', 'FLOWISE_CREDENTIAL_ID'])

/**
 * Collect every credential id referenced anywhere inside a parsed flow document.
 *
 * A full recursive walk and not a targeted path, because the id appears in at least four places
 * depending on the node and the vintage of the flow: `node.data.credential`,
 * `node.data.inputs.FLOWISE_CREDENTIAL_ID`, nested inside a config object under an input parameter,
 * and inside the `speechToText` / `textToSpeech` / `analytic` provider blobs as `credentialId`.
 * A checker that knows only the shapes that exist today would silently stop finding references the
 * first time the format grows a fifth place — and silently finding nothing is the failure mode this
 * whole check exists to eliminate.
 */
export const collectCredentialReferences = (value: unknown, into: Map<string, number> = new Map()): Map<string, number> => {
    if (Array.isArray(value)) {
        for (const item of value) collectCredentialReferences(item, into)
        return into
    }
    if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
            if (CREDENTIAL_KEYS.has(key) && typeof nested === 'string' && UUID.test(nested.trim())) {
                into.set(nested.trim(), (into.get(nested.trim()) ?? 0) + 1)
                continue
            }
            collectCredentialReferences(nested, into)
        }
    }
    return into
}

const parseJson = (raw: unknown): unknown => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

export const runDoctor = async (context: RecoveryContext & { env?: NodeJS.ProcessEnv; target?: string }): Promise<DoctorReport> => {
    const { dataSource, audit, actor } = context
    const env = context.env ?? process.env
    const checks: DoctorCheck[] = []
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()

    try {
        checks.push(await checkMigrations(queryRunner, dataSource))
        checks.push(await checkIdentityTables(queryRunner))
        checks.push(await checkIdentityCounts(queryRunner, dataSource))
        checks.push(await checkWhoCanLogIn(queryRunner, dataSource))
        checks.push(await checkPasswordAndMfaState(queryRunner, dataSource, env))
        checks.push(await checkTenantKeys(queryRunner, dataSource))
        checks.push(await checkCredentialReferences(queryRunner, dataSource))
        checks.push(checkAuditHealth())
    } finally {
        if (!queryRunner.isReleased) await queryRunner.release()
    }

    const failures = checks.filter((check) => check.status === 'fail').length
    const warnings = checks.filter((check) => check.status === 'warn').length

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.DOCTOR,
        // The command SUCCEEDED even when the instance is broken — the outcome describes the run,
        // not the patient. A failed diagnosis is one that could not be performed.
        outcome: AuditOutcome.SUCCESS,
        targetType: 'instance',
        message: `Recovery CLI ran doctor: ${failures} failure(s), ${warnings} warning(s) across ${checks.length} checks`,
        detail: {
            failures,
            warnings,
            checks: checks.map((check) => ({ name: check.name, status: check.status, summary: check.summary }))
        }
    })

    return { target: context.target ?? 'unknown', checks, failures, warnings }
}

// ── 1. Schema fingerprint ────────────────────────────────────────────────────────────────────

const checkMigrations = async (queryRunner: QueryRunner, dataSource: DataSource): Promise<DoctorCheck> => {
    const name = 'Schema — applied migrations'
    if (!(await queryRunner.hasTable('migrations'))) {
        return {
            name,
            status: 'fail',
            summary: 'The `migrations` table does not exist. This database has never been migrated by Flowise.',
            details: ['MIGRATION §1: the set of applied migrations is the only reliable version identifier, and there is none.']
        }
    }

    const escape = (identifier: string): string => dataSource.driver.escape(identifier)
    const rows: { name: string; timestamp: number }[] = await queryRunner.query(
        `SELECT ${escape('name')}, ${escape('timestamp')} FROM ${escape('migrations')} ORDER BY ${escape('timestamp')} ASC`
    )
    const identityMigrations = rows.filter((row) => row.name.includes('Identity'))
    const details = [
        `${rows.length} migration(s) applied.`,
        `Earliest: ${rows[0]?.name ?? '(none)'}`,
        `Latest:   ${rows[rows.length - 1]?.name ?? '(none)'}`,
        `Identity migrations applied: ${identityMigrations.length}${
            identityMigrations.length > 0 ? ` (${identityMigrations.map((row) => row.name).join(', ')})` : ''
        }`
    ]

    if (identityMigrations.length === 0) {
        return {
            name,
            status: 'fail',
            summary: `${rows.length} migration(s) applied, but NONE of them created the identity schema.`,
            details: [...details, 'This is a pre-3.0-shaped database as far as identity is concerned (MIGRATION §1, "the two eras").']
        }
    }

    return {
        name,
        status: 'ok',
        summary: `${rows.length} migration(s) applied, including ${identityMigrations.length} identity one(s).`,
        details
    }
}

// ── 2. Identity tables ───────────────────────────────────────────────────────────────────────

const checkIdentityTables = async (queryRunner: QueryRunner): Promise<DoctorCheck> => {
    const name = 'Schema — identity tables'
    const missing: string[] = []
    const present: string[] = []
    for (const table of IDENTITY_TABLES) {
        if (await queryRunner.hasTable(table)) present.push(table)
        else missing.push(table)
    }

    if (missing.length === IDENTITY_TABLES.length) {
        return {
            name,
            status: 'fail',
            summary: 'No identity table exists. Nothing in the identity layer can work.',
            details: ['Expected: ' + IDENTITY_TABLES.join(', ')]
        }
    }
    if (missing.length > 0) {
        return {
            name,
            status: 'fail',
            summary: `${present.length}/${IDENTITY_TABLES.length} identity tables exist — the schema is half-applied.`,
            details: [
                'Missing: ' + missing.join(', '),
                'A partially-applied identity migration is MIGRATION §8 territory: restore the backup.'
            ]
        }
    }
    return { name, status: 'ok', summary: `All ${IDENTITY_TABLES.length} identity tables exist.`, details: [] }
}

// ── 3. Population ────────────────────────────────────────────────────────────────────────────

const checkIdentityCounts = async (queryRunner: QueryRunner, dataSource: DataSource): Promise<DoctorCheck> => {
    const name = 'Identity — population'
    if (!(await queryRunner.hasTable('identity_user'))) {
        return { name, status: 'skip', summary: 'Skipped: the identity tables do not exist.', details: [] }
    }

    const users = await dataSource.getRepository(User).count()
    const organizations = await dataSource.getRepository(Organization).count()
    const workspaces = await dataSource.getRepository(Workspace).count()
    const roles = await dataSource.getRepository(Role).find()
    const systemRoles = roles.filter((role) => role.isSystem)
    const missingSystemRoles = SYSTEM_ROLE_NAMES.filter((roleName) => !roles.some((role) => role.name === roleName))

    const details = [
        `users          ${users}`,
        `organizations  ${organizations}`,
        `workspaces     ${workspaces}`,
        `roles          ${roles.length} (${systemRoles.length} system, ${roles.length - systemRoles.length} custom)`
    ]

    if (users === 0) {
        return {
            name,
            status: 'fail',
            summary: 'There are no accounts. Nobody can log in.',
            details: [...details, 'Fix: flow-wiser admin:create --email <you> --role super-admin']
        }
    }
    if (missingSystemRoles.length > 0) {
        return {
            name,
            status: 'warn',
            summary: `${users} account(s), but ${missingSystemRoles.length} of the six system roles are not seeded.`,
            details: [...details, `Missing roles: ${missingSystemRoles.join(', ')} (MIGRATION §3)`]
        }
    }
    return { name, status: 'ok', summary: `${users} account(s), ${organizations} organization(s), ${workspaces} workspace(s).`, details }
}

// ── 4. Can anybody actually get in ───────────────────────────────────────────────────────────

const checkWhoCanLogIn = async (queryRunner: QueryRunner, dataSource: DataSource): Promise<DoctorCheck> => {
    const name = 'Identity — who can log in'
    if (!(await queryRunner.hasTable('identity_workspace_user'))) {
        return { name, status: 'skip', summary: 'Skipped: the identity tables do not exist.', details: [] }
    }

    const users = await dataSource.getRepository(User).find({ select: { id: true, email: true, credential: true, isSSO: true } })
    if (users.length === 0) return { name, status: 'skip', summary: 'Skipped: there are no accounts.', details: [] }

    const assignments = await dataSource.getRepository(WorkspaceUser).find()
    const roles = await dataSource.getRepository(Role).find()
    const roleById = new Map(roles.map((role) => [role.id, role]))

    const assignedUserIds = new Set(assignments.map((assignment) => assignment.userId))
    const unassigned = users.filter((user) => !assignedUserIds.has(user.id))

    const instanceWideHolders = new Set(
        assignments.filter((assignment) => INSTANCE_WIDE_ROLES.includes(roleById.get(assignment.roleId)?.name ?? '')).map((a) => a.userId)
    )
    const withPassword = users.filter((user) => Boolean(user.credential))

    const details = [
        `accounts with a local password    ${withPassword.length}/${users.length}`,
        `accounts holding an instance-wide role (${INSTANCE_WIDE_ROLES.join('/')})  ${instanceWideHolders.size}`,
        `accounts with no workspace assignment  ${unassigned.length}`
    ]
    if (unassigned.length > 0) details.push(...truncate(unassigned.map((user) => `  no workspace: ${user.email}`)))

    if (instanceWideHolders.size === 0) {
        return {
            name,
            status: 'fail',
            summary: 'No account holds an instance-wide role. Nobody can administer this instance.',
            details: [...details, 'Fix: flow-wiser admin:create --email <you> --role super-admin']
        }
    }
    // A dangling roleId is a data defect, not a role: the assignment grants nothing at all.
    const danglingRoles = assignments.filter((assignment) => !roleById.has(assignment.roleId))
    if (danglingRoles.length > 0) {
        return {
            name,
            status: 'fail',
            summary: `${danglingRoles.length} workspace assignment(s) point at a role that does not exist — those users have no permissions.`,
            details: [...details, ...truncate(danglingRoles.map((a) => `  user ${a.userId} → missing role ${a.roleId}`))]
        }
    }
    if (unassigned.length > 0) {
        return {
            name,
            status: 'warn',
            summary: `${unassigned.length} account(s) have no workspace and will fail login with 'No Workspace Assigned'.`,
            details
        }
    }
    return { name, status: 'ok', summary: `${instanceWideHolders.size} account(s) can administer this instance.`, details }
}

// ── 5. Forced password changes and MFA exemptions ────────────────────────────────────────────

const checkPasswordAndMfaState = async (queryRunner: QueryRunner, dataSource: DataSource, env: NodeJS.ProcessEnv): Promise<DoctorCheck> => {
    const name = 'Identity — password state and MFA exemptions'
    if (!(await queryRunner.hasTable('identity_user'))) {
        return { name, status: 'skip', summary: 'Skipped: the identity tables do not exist.', details: [] }
    }

    const users = await dataSource.getRepository(User).find()
    const mustChange = users.filter((user) => user.mustChangePassword)

    const exemption = new EnvBootstrapAccountResolver(env)
    const exempt = users.filter((user) => exemption.isExempt({ userId: user.id, email: user.email }))

    const confirmedFactors = (await queryRunner.hasTable('identity_mfa_factor'))
        ? await dataSource.getRepository(MfaFactor).count({ where: { status: MfaFactorStatus.CONFIRMED } })
        : 0

    const details = [
        `accounts with mustChangePassword  ${mustChange.length}`,
        ...truncate(mustChange.map((user) => `  must change: ${user.email}`)),
        `confirmed MFA factors             ${confirmedFactors}`,
        `MFA-exempt accounts               ${exempt.length}  (IDENTITY_BOOTSTRAP_EMAILS, IDENTITY_BOOTSTRAP_MFA_EXEMPT)`,
        ...truncate(exempt.map((user) => `  mfa-exempt: ${user.email}`))
    ]

    if (exempt.length > 0) {
        // MIGRATION §4: the exemption exists so a broken TOTP configuration cannot lock out every
        // administrator, and it is "a standing risk that should be visible rather than forgotten".
        // Reporting it as a WARNING every single run is what "visible" has to mean in practice.
        return {
            name,
            status: 'warn',
            summary: `${exempt.length} account(s) are permanently exempt from MFA enforcement (MIGRATION §4).`,
            details: [...details, 'Withdraw the exemption once a working authenticator is enrolled: IDENTITY_BOOTSTRAP_MFA_EXEMPT=false']
        }
    }
    return {
        name,
        status: 'ok',
        summary: `${mustChange.length} account(s) must change password; no MFA exemptions are configured.`,
        details
    }
}

// ── 6. Orphaned tenant keys (MIGRATION §3a) ──────────────────────────────────────────────────

const checkTenantKeys = async (queryRunner: QueryRunner, dataSource: DataSource): Promise<DoctorCheck> => {
    const name = 'Tenancy — denormalised tenant keys'
    const escape = (identifier: string): string => dataSource.driver.escape(identifier)

    // Which table holds the workspace→organization mapping. `identity_workspace` is the Apache-2.0
    // cluster; `workspace` is what an un-migrated deployment still has. Checking both means the
    // command works on either side of the cut-over, which is when it is most likely to be run.
    const workspaceTable = (await queryRunner.hasTable('identity_workspace'))
        ? 'identity_workspace'
        : (await queryRunner.hasTable('workspace'))
        ? 'workspace'
        : null

    if (!workspaceTable) {
        return {
            name,
            status: 'skip',
            summary: 'Skipped: no workspace table exists, so there is no tenant key to check against.',
            details: []
        }
    }

    const checked: string[] = []
    const notDenormalised: string[] = []
    const problems: string[] = []
    let orphanCount = 0

    for (const table of TENANT_SCOPED_TABLES) {
        if (!(await queryRunner.hasTable(table))) continue
        // §3a's denormalisation ("`organizationId` is written directly onto every tenant-scoped
        // resource row") may not have been applied yet. A table without the column is REPORTED as
        // such, not silently passed — "no column, no mismatches, therefore healthy" is precisely the
        // false clean bill of health a diagnostic must never give.
        if (!(await queryRunner.hasColumn(table, 'organizationId'))) {
            notDenormalised.push(table)
            continue
        }
        checked.push(table)

        const rows: { id: string; workspaceId: string | null; rowOrg: string | null; workspaceOrg: string | null }[] =
            await queryRunner.query(
                `SELECT r.${escape('id')} AS ${escape('id')}, ` +
                    `r.${escape('workspaceId')} AS ${escape('workspaceId')}, ` +
                    `r.${escape('organizationId')} AS ${escape('rowOrg')}, ` +
                    `w.${escape('organizationId')} AS ${escape('workspaceOrg')} ` +
                    `FROM ${escape(table)} r LEFT JOIN ${escape(workspaceTable)} w ON w.${escape('id')} = r.${escape('workspaceId')} ` +
                    `WHERE w.${escape('id')} IS NULL ` +
                    `OR r.${escape('organizationId')} IS NULL ` +
                    `OR r.${escape('organizationId')} <> w.${escape('organizationId')}`
            )

        for (const row of rows) {
            orphanCount += 1
            if (!row.workspaceOrg) problems.push(`${table} ${row.id}: workspace ${row.workspaceId ?? '(null)'} does not exist`)
            else if (!row.rowOrg) problems.push(`${table} ${row.id}: organizationId is NULL, workspace says ${row.workspaceOrg}`)
            else
                problems.push(
                    `${table} ${row.id}: organizationId ${row.rowOrg} but workspace ${row.workspaceId} belongs to ${row.workspaceOrg}`
                )
        }
    }

    const details = [
        `tables checked                    ${checked.length ? checked.join(', ') : '(none)'}`,
        ...(notDenormalised.length > 0
            ? [
                  `tables without an organizationId column  ${notDenormalised.join(', ')}`,
                  'MIGRATION §3a requires the tenant key on every tenant-scoped row; until it is there the boundary is join-only.'
              ]
            : []),
        ...truncate(problems)
    ]

    if (orphanCount > 0) {
        return {
            name,
            status: 'fail',
            summary: `${orphanCount} row(s) carry a tenant key that disagrees with their workspace (MIGRATION §3a).`,
            details: [
                ...details,
                'Each of these is served to the wrong tenant by any query that filters on organization alone. Re-stamp them, transactionally.'
            ]
        }
    }
    if (checked.length === 0) {
        return {
            name,
            status: 'warn',
            summary: 'No tenant-scoped table carries an organizationId column yet — the §3a denormalisation has not been applied.',
            details
        }
    }
    return { name, status: 'ok', summary: `Zero tenant-key inconsistencies across ${checked.length} table(s).`, details }
}

// ── 7. Credentials referenced by a flow but missing ──────────────────────────────────────────

export interface BrokenCredentialReference {
    credentialId: string
    /** Every flow (or assistant) that points at it, with how many times each does. */
    referencedBy: { type: string; id: string; name: string; references: number }[]
    totalReferences: number
}

export const findBrokenCredentialReferences = async (
    queryRunner: QueryRunner,
    dataSource: DataSource
): Promise<BrokenCredentialReference[] | null> => {
    if (!(await queryRunner.hasTable('credential'))) return null
    const escape = (identifier: string): string => dataSource.driver.escape(identifier)

    const credentialRows: { id: string }[] = await queryRunner.query(`SELECT ${escape('id')} FROM ${escape('credential')}`)
    const existing = new Set(credentialRows.map((row) => row.id))

    // credentialId -> holder -> count
    const broken = new Map<string, Map<string, { type: string; id: string; name: string; references: number }>>()

    const note = (credentialId: string, holder: { type: string; id: string; name: string }, count: number): void => {
        if (existing.has(credentialId)) return
        const holders = broken.get(credentialId) ?? new Map()
        const key = `${holder.type}:${holder.id}`
        const current = holders.get(key)
        if (current) current.references += count
        else holders.set(key, { ...holder, references: count })
        broken.set(credentialId, holders)
    }

    if (await queryRunner.hasTable('chat_flow')) {
        // The whole `flowData` document is walked, plus the four sibling columns that carry provider
        // configuration with credential ids of their own. See `collectCredentialReferences`.
        const columns = ['flowData', 'speechToText', 'textToSpeech', 'analytic', 'followUpPrompts'].filter(Boolean)
        const available: string[] = []
        for (const column of columns) if (await queryRunner.hasColumn('chat_flow', column)) available.push(column)

        const selected = ['id', 'name', ...available].map((column) => `${escape(column)}`).join(', ')
        const flows: Record<string, string | null>[] = await queryRunner.query(`SELECT ${selected} FROM ${escape('chat_flow')}`)

        for (const flow of flows) {
            const references = new Map<string, number>()
            for (const column of available) collectCredentialReferences(parseJson(flow[column]), references)
            for (const [credentialId, count] of references) {
                note(credentialId, { type: 'chatflow', id: String(flow.id), name: String(flow.name ?? '') }, count)
            }
        }
    }

    if ((await queryRunner.hasTable('assistant')) && (await queryRunner.hasColumn('assistant', 'credential'))) {
        const assistants: Record<string, string | null>[] = await queryRunner.query(
            `SELECT ${escape('id')}, ${escape('credential')} FROM ${escape('assistant')}`
        )
        for (const assistant of assistants) {
            const credentialId = (assistant.credential ?? '').trim()
            if (UUID.test(credentialId)) note(credentialId, { type: 'assistant', id: String(assistant.id), name: '' }, 1)
        }
    }

    return [...broken.entries()].map(([credentialId, holders]) => ({
        credentialId,
        referencedBy: [...holders.values()],
        totalReferences: [...holders.values()].reduce((sum, holder) => sum + holder.references, 0)
    }))
}

const checkCredentialReferences = async (queryRunner: QueryRunner, dataSource: DataSource): Promise<DoctorCheck> => {
    const name = 'Flows — credential references'
    const broken = await findBrokenCredentialReferences(queryRunner, dataSource)
    if (broken === null) {
        return { name, status: 'skip', summary: 'Skipped: there is no `credential` table.', details: [] }
    }

    if (broken.length === 0) {
        return { name, status: 'ok', summary: 'Every credential referenced by a flow exists.', details: [] }
    }

    const totalReferences = broken.reduce((sum, entry) => sum + entry.totalReferences, 0)
    const affected = new Set(broken.flatMap((entry) => entry.referencedBy.map((holder) => `${holder.type}:${holder.id}`)))

    const details: string[] = []
    for (const entry of broken) {
        details.push(`credential ${entry.credentialId} — MISSING, ${entry.totalReferences} reference(s):`)
        for (const holder of entry.referencedBy) {
            details.push(`    ${holder.type} ${holder.id}${holder.name ? ` "${holder.name}"` : ''} (${holder.references}×)`)
        }
    }

    return {
        name,
        status: 'fail',
        summary: `${broken.length} deleted credential(s) are still referenced: ${totalReferences} reference(s) across ${affected.size} flow(s).`,
        details: [
            ...truncate(details),
            'Each of these fails only when the flow runs. Re-create the credential with the SAME id, or edit every reference.'
        ]
    }
}

// ── 8. Is the trail intact ───────────────────────────────────────────────────────────────────

const checkAuditHealth = (): DoctorCheck => {
    const name = 'Audit — sink health (this process)'
    const health = getAuditHealth()
    if (health.healthy) {
        return { name, status: 'ok', summary: 'No audit write has failed in this process.', details: [] }
    }
    return {
        name,
        status: 'fail',
        summary: `${health.failures} audit write(s) failed in this process — the trail has holes.`,
        details: [`last failure ${health.lastFailureAt?.toISOString()}`, `last error   ${health.lastError}`]
    }
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────

const BADGE: Record<DoctorStatus, string> = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ', skip: ' SKIP ' }

export const formatDoctorReport = (report: DoctorReport, verbose: boolean): string[] => {
    const lines: string[] = [`flow-wiser doctor — ${report.target}`, '']
    for (const check of report.checks) {
        lines.push(`[${BADGE[check.status]}] ${check.name}`)
        lines.push(`          ${check.summary}`)
        // Failures always show their evidence; the healthy checks only do so on request, so a clean
        // run stays short enough to read and a broken one never hides the detail behind a flag.
        if (check.details.length > 0 && (verbose || check.status === 'fail' || check.status === 'warn')) {
            for (const detail of check.details) lines.push(`          ${detail}`)
        }
        lines.push('')
    }
    lines.push(
        report.failures === 0
            ? `No failures. ${report.warnings} warning(s).`
            : `${report.failures} FAILURE(S), ${report.warnings} warning(s).`
    )
    return lines
}

export default class Doctor extends RecoveryCommand {
    static description = 'Diagnose schema and identity state: migrations, identity tables, tenant keys, and broken credential references.'

    static examples = ['<%= config.bin %> doctor', '<%= config.bin %> doctor --verbose', '<%= config.bin %> doctor --json']

    static flags = {
        ...RecoveryCommand.flags,
        verbose: Flags.boolean({ description: 'Show supporting detail for healthy checks too' }),
        json: Flags.boolean({ description: 'Emit the report as JSON' })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(Doctor)
        const report = await runDoctor({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            target: buildRecoveryDataSource(process.env).describe
        })

        if (flags.json) this.log(JSON.stringify(report, null, 2))
        else for (const line of formatDoctorReport(report, flags.verbose)) this.log(line)

        // A doctor that exits 0 on a broken instance cannot be used in a health check or a
        // pre-upgrade gate, which is most of what a doctor is for.
        if (report.failures > 0) this.exitWithFailure = true
    }
}
