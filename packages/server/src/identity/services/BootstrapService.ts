import { DataSource, EntityManager } from 'typeorm'
import { AuditOutcome, AuditSubjectType } from '../../database/entities/identity/AuditEvent'
import { MemberStatus, OrganizationUser } from '../../database/entities/identity/OrganizationUser'
import { Organization } from '../../database/entities/identity/Organization'
import { Role } from '../../database/entities/identity/Role'
import { User } from '../../database/entities/identity/User'
import { DEFAULT_WORKSPACE_NAME, Workspace } from '../../database/entities/identity/Workspace'
import { WorkspaceUser } from '../../database/entities/identity/WorkspaceUser'
import logger from '../../utils/logger'
import { hash, PasswordPolicyError, validatePassword } from '../crypto/passwords'
import { getImplicitViewPermissions, PERMISSION_DEFINITIONS, PermissionCategory, withImpliedViewPermissions } from '../rbac/Permissions'
import { AuditService } from './AuditService'

/**
 * Identity — BootstrapService (REQUIREMENTS-MIGRATION.md §3 role hierarchy, §4 bootstrap;
 * REQUIREMENTS-TENANCY-ACCESS.md §2 access matrix; REQUIREMENTS-AUTH-RBAC.md §2 and §6).
 *
 * Runs on EVERY boot and is idempotent by construction: every step is "find, else create", never
 * "create". §6 asks for a "first-run bootstrap"; making it safe to re-run is what turns that into an
 * operational property rather than a one-shot script an operator has to remember not to repeat.
 *
 * Three things it does, in dependency order:
 *   1. the default Organization and its Default Workspace;
 *   2. the six `isSystem` roles of §3, composed of EXPLICIT permission grants from the catalog —
 *      MIGRATION §3: "implemented as seeded roles composed of explicit permission grants, not
 *      hard-coded tiers — so a deployment can reshape them without a code change";
 *   3. the super-admin account(s), from the environment only.
 *
 * ── Fail closed (REQUIREMENTS-AUTH-RBAC.md §2) ───────────────────────────────────────────────
 * "If the auth subsystem cannot initialise, refuse connections rather than serving
 * unauthenticated." Everything that could leave the instance reachable without a usable
 * administrator throws {@link BootstrapError}; the caller is expected to let that abort startup
 * rather than catch it. In particular a database with no users at all and no bootstrap environment
 * is exactly the "unauthenticated server" §2 exists to prevent.
 */

/** Aborts startup. Never carries the candidate password — §9 keeps secrets out of error messages. */
export class BootstrapError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BootstrapError'
    }
}

/** The six levels of REQUIREMENTS-MIGRATION.md §3, most privileged first. */
export const SYSTEM_ROLE_NAMES = ['super-admin', 'admin', 'super-user', 'org-admin', 'user', 'read-only'] as const
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number]

const allPermissions = (): string[] => PERMISSION_DEFINITIONS.map((permission) => permission.name)

const inCategories = (...categories: PermissionCategory[]): string[] =>
    PERMISSION_DEFINITIONS.filter((permission) => categories.includes(permission.category)).map((permission) => permission.name)

const viewsOf = (...categories: PermissionCategory[]): string[] => categories.flatMap(getImplicitViewPermissions)

/**
 * Workspace-scoped authoring resources — everything the tenancy matrix (§2) treats as "content"
 * rather than as identity or tenancy administration. `datasets`, `evaluations` and `evaluators` are
 * not named as their own row in the matrix; they are grouped here because they are workspace-scoped
 * authoring artefacts with the same lifecycle as a flow, which is the closest row the matrix has
 * ("Tools / assistants / doc stores / variables").
 */
const CONTENT_CATEGORIES: PermissionCategory[] = [
    'chatflows',
    'agentflows',
    'assistants',
    'tools',
    'documentStores',
    'variables',
    'datasets',
    'evaluations',
    'evaluators',
    'executions'
]

/**
 * The §2 access matrix, expressed as grants.
 *
 * Read the matrix column-wise: each entry below is one column. Where the matrix says "R only" the
 * grant is the category's implicit-view token(s); where it says "R W" it is the whole category;
 * where it says "—" the category is absent. Absence is the operative mechanism — deny-by-default
 * (REQUIREMENTS-AUTH-RBAC.md §4) means a role holds exactly what is listed and nothing else.
 *
 * ── Two matrix rows that the permission vocabulary cannot express ────────────────────────────
 *  1. `admin` vs `super-admin`. The matrix separates them on "Encryption keys / rotation",
 *     "Recovery CLI" and "MFA exemption" — none of which is a permission token, and none of which
 *     is an HTTP route: key rotation is an operator action, the recovery CLI is gated on filesystem
 *     access by design (§7: "the CLI requires filesystem access to the data directory. That is the
 *     security boundary"), and MFA exemption is a property of the account, not of a request. So the
 *     two roles hold the SAME catalog grants and are distinguished by identity, not by tokens. That
 *     is recorded here rather than papered over with an invented permission, because inventing one
 *     would imply an enforcement point that does not exist.
 *  2. Scope. "instance" vs "own org" vs "assigned workspaces" is the OTHER axis (§1) and is enforced
 *     by the tenant-scoping layer (MIGRATION §3a), not by these grants — `org-admin` and `admin`
 *     share many tokens and differ entirely in how far those tokens reach.
 */
const ROLE_GRANTS: Record<SystemRoleName, () => string[]> = {
    /** Everything. The single break-glass tier (§3 "Break-glass"). */
    'super-admin': () => allPermissions(),

    /** Everything, including `credentials:reveal` (§3: "including revealing stored credential values"). */
    admin: () => allPermissions(),

    /**
     * The auditor-plus-user-administrator (§2 "Why `super-user` is shaped this way"): total
     * visibility, no authority over content, and NO `credentials:reveal` — "a super-user can
     * therefore administer people and audit the entire system without ever holding the keys".
     *
     * `roles:manage` and `sso:manage` are withheld deliberately: the matrix grants super-user
     * "R only" on role definitions and SSO configuration, and both categories have a single
     * read/write token, so read-only is expressed as absence.
     */
    'super-user': () => [
        ...viewsOf(...CONTENT_CATEGORIES),
        ...viewsOf('credentials', 'apikeys', 'templates', 'workspace'),
        'logs:view',
        'loginActivity:view',
        // The one write authority in the column: "Users & role assignment: R W".
        'users:manage'
    ],

    /**
     * Full administration inside ONE organization (§3). Everything except the three instance-wide
     * powers: `credentials:reveal` (matrix ❌), `roles:manage` (matrix —), and cross-tenant moves
     * (not a token — enforced by the scoping layer).
     */
    'org-admin': () => [
        ...inCategories(...CONTENT_CATEGORIES),
        ...inCategories('apikeys', 'templates', 'workspace'),
        // Credential RECORDS but never their values — the §3 credential-value split.
        'credentials:view',
        'credentials:create',
        'credentials:update',
        'credentials:delete',
        'credentials:share',
        'users:manage',
        'sso:manage',
        'logs:view',
        'loginActivity:view'
    ],

    /**
     * Authors (§3): "creates and edits own flows, *uses* existing credentials. No user
     * administration." `credentials:view` is the whole credential grant — §3's credential-value
     * split makes using a credential a read of its RECORD, never of its value.
     *
     * `apikeys:view` without create/update: an API key carries its own permission set (spec §D.10),
     * so minting one is an identity-administration act, which this column does not have.
     * `workspace:export`/`import` are withheld for the same reason §B.2 flags them administrative —
     * they bypass per-resource checks within the workspace.
     */
    user: () => [
        ...inCategories(...CONTENT_CATEGORIES),
        'credentials:view',
        'apikeys:view',
        'templates:marketplace',
        'templates:custom',
        'templates:flowexport',
        'templates:toolexport',
        'workspace:view'
    ],

    /**
     * "Views and executes deployed flows. No create, edit, delete, or credential access" (§3).
     * Execution itself is not a permission — the prediction routes are API-key/whitelisted (spec
     * §0.3) — so this column is exactly the view tokens, minus credentials (matrix "—").
     */
    'read-only': () => [...viewsOf(...CONTENT_CATEGORIES), 'templates:marketplace', 'templates:custom', 'workspace:view']
}

const ROLE_DESCRIPTIONS: Record<SystemRoleName, string> = {
    'super-admin': 'Instance-wide. Everything, including identity, SSO configuration, role definitions and recovery. Break-glass.',
    admin: 'Instance-wide. Anything in all domains, including revealing stored credential values.',
    'super-user':
        'Instance-wide, read-only on content. Manages users across every organization and sees all logs; never a credential value.',
    'org-admin': 'Full administration within a single organization — its users, workspaces, flows and credential records.',
    user: 'Authors flows in assigned workspaces and uses existing credentials. No user administration.',
    'read-only': 'Views and executes deployed flows in assigned workspaces. No create, edit, delete or credential access.'
}

/**
 * The permission list a system role is seeded with: the column from {@link ROLE_GRANTS}, de-duped,
 * with §B.6 rule 1 applied (granting a non-view token implies the category's view token). Mirroring
 * the client's coupling rule here stops the seed producing a role the shipped role editor cannot
 * represent.
 */
export const systemRolePermissions = (name: SystemRoleName): string[] =>
    Array.from(new Set(withImpliedViewPermissions(ROLE_GRANTS[name]())))

/** One env-supplied bootstrap identity. */
interface BootstrapAccount {
    email: string
    password: string
    /** `FLOWISE_BOOTSTRAP_EMAIL` / `FLOWISE_BOOTSTRAP_EMAIL_2` / … — reported so a rejection names the variable, never the value. */
    source: string
}

export interface BootstrapResult {
    organizationId: string
    workspaceId: string
    /** Role names created on this run. Empty on every run after the first — the idempotence signal. */
    rolesCreated: string[]
    rolesExisting: string[]
    accountsCreated: string[]
    accountsExisting: string[]
    /**
     * The instance has no account anyone can sign in as, and none was supplied by the environment.
     * Only ever true when the caller passed `allowNoIdentity`; otherwise this case throws.
     */
    noAdministrableIdentity: boolean
}

export interface BootstrapRunOptions {
    /**
     * Seed roles and tenancy even when the instance has no identity and none is configured, instead
     * of refusing. For the SERVER BOOT path only — see the comment at the check itself for why
     * throwing there is the wrong trade. Every other caller should leave this unset and treat an
     * unadministrable instance as fatal.
     */
    allowNoIdentity?: boolean
}

export interface BootstrapServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    auditService?: AuditService
    /** Overrides `process.env`. Tests only — production reads the real environment (§4: "environment or CLI at run time"). */
    env?: NodeJS.ProcessEnv
}

const DEFAULT_ORGANIZATION_NAME = 'Default Organization'

/** Actions this service appends to the trail. §4: bootstrap is a standing risk and must be visible. */
const BootstrapAuditAction = {
    ROLE_CREATE: 'identity.bootstrap.role.create',
    ORGANIZATION_CREATE: 'identity.bootstrap.organization.create',
    WORKSPACE_CREATE: 'identity.bootstrap.workspace.create',
    ACCOUNT_CREATE: 'identity.bootstrap.account.create',
    /** §4: the MFA exemption "is recorded in the audit trail on every use, because a permanent MFA-exempt account is a standing risk". */
    COMPLETED: 'identity.bootstrap.completed'
} as const

export class BootstrapService {
    private readonly injectedDataSource?: DataSource
    private readonly audit: AuditService
    private readonly env: NodeJS.ProcessEnv

    constructor(options: BootstrapServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.audit = options.auditService ?? new AuditService({ dataSource: options.dataSource })
        this.env = options.env ?? process.env
    }

    /** Lazy `require` for the same reason SessionService uses one: a static import would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    /**
     * Read the bootstrap identities.
     *
     * §4: "Identities and initial password come from environment or CLI at run time. Never from a
     * file in this repository, never a compiled-in default." There is deliberately no default email,
     * no default password and no generated-and-logged fallback — a password printed to a log is a
     * password in a log aggregator.
     *
     * `FLOWISE_BOOTSTRAP_EMAIL` / `FLOWISE_BOOTSTRAP_PASSWORD` is the pair; §4 says "one or more
     * super-admin accounts", so `_2`, `_3`, … are read as additional pairs. Each account gets its
     * OWN password variable — a shared secret across administrators would defeat the point of
     * having more than one.
     */
    private readAccounts(): BootstrapAccount[] {
        const accounts: BootstrapAccount[] = []
        const read = (suffix: string): void => {
            const emailVar = `FLOWISE_BOOTSTRAP_EMAIL${suffix}`
            const passwordVar = `FLOWISE_BOOTSTRAP_PASSWORD${suffix}`
            const email = (this.env[emailVar] ?? '').trim().toLowerCase()
            const password = this.env[passwordVar] ?? ''
            if (!email) return
            if (!password)
                throw new BootstrapError(`${emailVar} is set but ${passwordVar} is not. Refusing to create an account without a password.`)
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BootstrapError(`${emailVar} is not a valid email address.`)
            // §4: "refuses to run with a weak, blank, or known-published password — the same check
            // that rejects `myencryptionkey` for the encryption key". validatePassword IS that check.
            const violations = validatePassword(password)
            if (violations.length > 0) {
                throw new BootstrapError(
                    `${passwordVar} was rejected by the password policy: ${violations.join(', ')}. Refusing to bootstrap.`
                )
            }
            accounts.push({ email, password, source: emailVar })
        }

        read('')
        for (let index = 2; index <= 10; index += 1) read(`_${index}`)

        const seen = new Set<string>()
        for (const account of accounts) {
            if (seen.has(account.email))
                throw new BootstrapError(`Duplicate bootstrap email in ${account.source}. Each account must be distinct.`)
            seen.add(account.email)
        }
        return accounts
    }

    /**
     * Seed roles, tenancy and the bootstrap account(s). Safe on every boot.
     *
     * One transaction: a half-applied bootstrap — roles but no owner, or an owner with no workspace
     * ("No Workspace Assigned" at login, spec §F-12) — is worse than none, because the instance
     * comes up looking healthy and cannot be logged into.
     */
    async run(options: BootstrapRunOptions = {}): Promise<BootstrapResult> {
        const allowNoIdentity = options.allowNoIdentity === true
        let noAdministrableIdentity = false
        const accounts = this.readAccounts()
        const dataSource = this.getDataSource()

        const result = await dataSource.transaction(async (manager) => {
            const organization = await this.ensureOrganization(manager)
            const workspace = await this.ensureWorkspace(manager, organization.id)
            const { created: rolesCreated, existing: rolesExisting, byName } = await this.ensureSystemRoles(manager, organization.id)

            const superAdminRole = byName.get('super-admin')
            if (!superAdminRole) throw new BootstrapError('super-admin role could not be resolved after seeding. Refusing to continue.')

            const accountsCreated: string[] = []
            const accountsExisting: string[] = []

            if (accounts.length === 0) {
                // No env identities. That is fine ONLY if the instance already has someone who can
                // log in; otherwise §2's "auth that degrades safely" is violated in the worst
                // direction — a reachable server nobody administers.
                const existingUsers = await manager.count(User)
                if (existingUsers === 0) {
                    if (!allowNoIdentity) {
                        throw new BootstrapError(
                            'No identity exists and FLOWISE_BOOTSTRAP_EMAIL / FLOWISE_BOOTSTRAP_PASSWORD are not set. ' +
                                'Refusing to start an instance nobody can administer (REQUIREMENTS-AUTH-RBAC.md §2, MIGRATION §4).'
                        )
                    }
                    // The boot path passes `allowNoIdentity` and reports this instead of throwing.
                    //
                    // Throwing here would roll back the whole transaction, taking the six seeded
                    // roles with it — so the first `docker run` of a new instance would refuse to
                    // start AND leave nothing behind, and the operator's next move (`admin:create`)
                    // would find no roles to assign.
                    //
                    // An instance with zero accounts is not the danger §2 describes. That danger is
                    // a server nobody ADMINISTERS but anyone can reach; with no users and no API
                    // keys, nobody can authenticate at all. It is closed, not open. The operator is
                    // told loudly and given the exact command.
                    noAdministrableIdentity = true
                }
            }

            for (const account of accounts) {
                const outcome = await this.ensureAccount(manager, account, organization.id, workspace.id, superAdminRole.id)
                if (outcome.created) accountsCreated.push(account.email)
                else accountsExisting.push(account.email)
            }

            return {
                organizationId: organization.id,
                workspaceId: workspace.id,
                rolesCreated,
                rolesExisting,
                accountsCreated,
                accountsExisting,
                noAdministrableIdentity
            }
        })

        await this.audit.record({
            action: BootstrapAuditAction.COMPLETED,
            outcome: AuditOutcome.SUCCESS,
            subject: { type: AuditSubjectType.SYSTEM, label: 'bootstrap' },
            target: { type: 'organization', id: result.organizationId },
            scope: { organizationId: result.organizationId, workspaceId: result.workspaceId },
            detail: {
                rolesCreated: result.rolesCreated,
                rolesExisting: result.rolesExisting,
                accountsCreated: result.accountsCreated,
                accountsExisting: result.accountsExisting
            },
            message: `Bootstrap completed: ${result.rolesCreated.length} role(s) and ${result.accountsCreated.length} account(s) created`
        })

        logger.info(
            `[BootstrapService] organization=${result.organizationId} workspace=${result.workspaceId} ` +
                `rolesCreated=[${result.rolesCreated.join(',')}] accountsCreated=${result.accountsCreated.length}`
        )
        return result
    }

    /**
     * The tenant the bootstrap owns.
     *
     * Multi-org is a v1 non-goal (REQUIREMENTS-AUTH-RBAC.md "Non-goals"), and the entity carries no
     * "is default" flag, so "the default organization" is defined as the OLDEST one. Deterministic,
     * and it means a deployment that later grows a second organization does not have its bootstrap
     * wander to whichever row the engine happened to return first.
     */
    /**
     * Read the id of the oldest row in a LEGACY (pre-fork, commercially licensed) identity table.
     *
     * Returns null when the table is absent — a fresh install has no legacy tables at all — so the
     * caller falls through to creating its own. Never throws: a malformed legacy table must not
     * stop an instance booting.
     */
    private async legacyId(manager: EntityManager, table: 'organization' | 'workspace'): Promise<string | null> {
        try {
            const rows: { id?: string }[] = await manager.query(`SELECT id FROM "${table}" ORDER BY "createdDate" ASC LIMIT 1`)
            return rows?.[0]?.id ?? null
        } catch {
            return null
        }
    }

    /**
     * ── Why this adopts the legacy organization id ───────────────────────────────────────────
     *
     * Upgrading a Flowise 3.x database leaves the old `organization` / `workspace` tables in place
     * alongside the new `identity_*` ones. If the bootstrap mints fresh ids here, every existing
     * row of content — which carries the OLD `workspaceId` — falls outside the new workspace and
     * becomes invisible: 25 chatflows and 3 credentials still in the database, and an empty screen.
     *
     * Found by booting this build against a copy of a real production database. On a fresh install
     * the query finds nothing and the behaviour is unchanged.
     *
     * Adopting the id is preferred over re-stamping the content: it touches no user data, so an
     * upgrade that has to be rolled back leaves the flows exactly as they were.
     */
    private async ensureOrganization(manager: EntityManager): Promise<Organization> {
        const existing = await manager.find(Organization, { order: { createdDate: 'ASC' }, take: 1 })
        if (existing.length > 0) return existing[0]

        const adoptedId = await this.legacyId(manager, 'organization')
        if (adoptedId) {
            const adopted = await manager.save(manager.create(Organization, { id: adoptedId, name: DEFAULT_ORGANIZATION_NAME }))
            logger.info(`👥 [bootstrap]: adopted the existing organization ${adoptedId} so migrated content stays in scope`)
            return adopted
        }

        const organization = await manager.save(manager.create(Organization, { name: DEFAULT_ORGANIZATION_NAME }))
        await this.audit.record({
            action: BootstrapAuditAction.ORGANIZATION_CREATE,
            outcome: AuditOutcome.SUCCESS,
            subject: { type: AuditSubjectType.SYSTEM, label: 'bootstrap' },
            target: { type: 'organization', id: organization.id },
            scope: { organizationId: organization.id },
            message: `Created default organization ${organization.id}`
        })
        return organization
    }

    /**
     * The org's default workspace (spec §F-12: "Does org creation auto-create a 'Default Workspace'?"
     * — decided yes). The name is behaviourally significant: the workspace view and the delete-guard
     * case on it (`Workspace.ts`, DEFAULT_WORKSPACE_NAME), and §F-12 records that every user must end
     * up with an `activeWorkspaceId` or login fails with 'No Workspace Assigned'.
     */
    private async ensureWorkspace(manager: EntityManager, organizationId: string): Promise<Workspace> {
        const existing = await manager.findOne(Workspace, { where: { organizationId, isOrgDefault: true } })
        if (existing) return existing

        const byName = await manager.findOne(Workspace, { where: { organizationId, name: DEFAULT_WORKSPACE_NAME } })
        if (byName) {
            // Adopt a workspace that already carries the reserved name rather than creating a second
            // one and colliding on the (organizationId, name) unique index.
            if (!byName.isOrgDefault) await manager.update(Workspace, { id: byName.id }, { isOrgDefault: true })
            byName.isOrgDefault = true
            return byName
        }

        // Same reasoning as ensureOrganization: adopt the legacy workspace id so content that
        // already carries it stays in scope after an upgrade. Without this an upgraded instance
        // shows an empty workspace while every flow sits in the database, unreachable.
        const adoptedWorkspaceId = await this.legacyId(manager, 'workspace')
        if (adoptedWorkspaceId) {
            const adopted = await manager.save(
                manager.create(Workspace, {
                    id: adoptedWorkspaceId,
                    name: DEFAULT_WORKSPACE_NAME,
                    description: 'Adopted from the pre-fork workspace at upgrade',
                    organizationId,
                    isOrgDefault: true
                })
            )
            logger.info(`👥 [bootstrap]: adopted the existing workspace ${adoptedWorkspaceId} so migrated content stays in scope`)
            return adopted
        }

        const workspace = await manager.save(
            manager.create(Workspace, {
                name: DEFAULT_WORKSPACE_NAME,
                description: 'Created at first-run bootstrap',
                organizationId,
                isOrgDefault: true
            })
        )
        await this.audit.record({
            action: BootstrapAuditAction.WORKSPACE_CREATE,
            outcome: AuditOutcome.SUCCESS,
            subject: { type: AuditSubjectType.SYSTEM, label: 'bootstrap' },
            target: { type: 'workspace', id: workspace.id },
            scope: { organizationId, workspaceId: workspace.id },
            message: `Created ${DEFAULT_WORKSPACE_NAME} ${workspace.id}`
        })
        return workspace
    }

    /**
     * Seed the six §3 roles.
     *
     * EXISTING ROLES ARE NEVER OVERWRITTEN. MIGRATION §3 says seeded roles are "marked `isSystem` to
     * refuse accidental deletion while remaining editable" — re-applying the built-in grant set on
     * every boot would silently undo an operator's edit, and would do it at the least visible moment
     * (a restart). The grant set is therefore a SEED, not a spec the database is reconciled against.
     */
    private async ensureSystemRoles(
        manager: EntityManager,
        organizationId: string
    ): Promise<{ created: string[]; existing: string[]; byName: Map<string, Role> }> {
        const created: string[] = []
        const existing: string[] = []
        const byName = new Map<string, Role>()

        for (const name of SYSTEM_ROLE_NAMES) {
            const found = await manager.findOne(Role, { where: { organizationId, name } })
            if (found) {
                existing.push(name)
                byName.set(name, found)
                continue
            }

            const permissions = systemRolePermissions(name)
            const role = await manager.save(
                manager.create(Role, {
                    name,
                    description: ROLE_DESCRIPTIONS[name],
                    // Role.permissions is a JSON-encoded string[], because the shipped client does
                    // JSON.parse(role.permissions) (spec §D.5, invariant 7).
                    permissions: JSON.stringify(permissions),
                    organizationId,
                    isSystem: true
                })
            )
            created.push(name)
            byName.set(name, role)

            await this.audit.record({
                action: BootstrapAuditAction.ROLE_CREATE,
                outcome: AuditOutcome.SUCCESS,
                subject: { type: AuditSubjectType.SYSTEM, label: 'bootstrap' },
                target: { type: 'role', id: role.id },
                scope: { organizationId },
                // §10 names the permission delta explicitly as what a role event must carry.
                detail: { name, added: permissions, removed: [] },
                message: `Seeded system role '${name}' with ${permissions.length} permission(s)`
            })
        }

        return { created, existing, byName }
    }

    /**
     * Create one bootstrap super-admin, or adopt the account that is already there.
     *
     * An EXISTING account keeps its credential. Re-hashing the env password on every boot would
     * silently revert a password the administrator had since changed — and would re-arm
     * `mustChangePassword` forever, so the forced change could never be satisfied. Recovery for a
     * genuinely lost password is `flowise admin:reset-password` (§7), which prompts rather than
     * reading argv or the environment. Membership and workspace assignment ARE still ensured, so an
     * account that lost its role assignment is repaired on the next boot rather than locked out.
     */
    private async ensureAccount(
        manager: EntityManager,
        account: BootstrapAccount,
        organizationId: string,
        workspaceId: string,
        roleId: string
    ): Promise<{ created: boolean; user: User }> {
        let user = await manager.findOne(User, { where: { email: account.email } })
        let created = false

        if (!user) {
            let credential: string
            try {
                credential = await hash(account.password)
            } catch (error) {
                // Belt-and-braces: readAccounts() already validated. Re-raise as a BootstrapError so
                // the abort path is uniform, and never echo the candidate (§9).
                if (error instanceof PasswordPolicyError) {
                    throw new BootstrapError(`${account.source}'s password was rejected by policy: ${error.violations.join(', ')}`)
                }
                throw error
            }

            user = await manager.save(
                manager.create(User, {
                    email: account.email,
                    name: account.email.split('@')[0],
                    credential,
                    isSSO: false,
                    // Bootstrap provisions an account whose password has been typed into a shell, a
                    // compose file or a secret store and read by at least one human. MIGRATION §6
                    // and §4 both require the change on first interactive login.
                    mustChangePassword: true,
                    // The address came from the operator's own environment, not from a self-service
                    // form, so there is nothing to verify and no email to send.
                    emailVerifiedDate: new Date()
                })
            )
            created = true
        }

        // §D.3 — exactly one row per organization carries isOrgOwner. The first bootstrap account
        // becomes it; later ones are ordinary super-admins. `isOrganizationAdmin` bypasses all
        // permission evaluation (spec invariant 4), which REQUIREMENTS §4 permits for exactly one
        // bootstrap owner and nobody else.
        const membership = await manager.findOne(OrganizationUser, { where: { organizationId, userId: user.id } })
        if (!membership) {
            const ownerExists = await manager.findOne(OrganizationUser, { where: { organizationId, isOrgOwner: true } })
            await manager.save(
                manager.create(OrganizationUser, {
                    organizationId,
                    userId: user.id,
                    status: MemberStatus.ACTIVE,
                    isOrgOwner: !ownerExists
                })
            )
        }

        const assignment = await manager.findOne(WorkspaceUser, { where: { workspaceId, userId: user.id } })
        if (!assignment) {
            await manager.save(manager.create(WorkspaceUser, { workspaceId, userId: user.id, roleId }))
        }

        if (created) {
            await this.audit.record({
                action: BootstrapAuditAction.ACCOUNT_CREATE,
                outcome: AuditOutcome.SUCCESS,
                subject: { type: AuditSubjectType.SYSTEM, label: 'bootstrap' },
                target: { type: 'user', id: user.id },
                scope: { organizationId, workspaceId },
                // The source VARIABLE, never its value (§9, §10).
                detail: { email: account.email, role: 'super-admin', source: account.source, mustChangePassword: true },
                message: `Bootstrapped super-admin ${account.email} (password change required on first login)`
            })
            logger.info(
                `[BootstrapService] created super-admin ${account.email} from ${account.source}; password change is forced on first login`
            )
        }

        return { created, user }
    }
}
