import { Flags } from '@oclif/core'
import { EntityManager } from 'typeorm'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import {
    DEFAULT_WORKSPACE_NAME,
    MemberStatus,
    Organization,
    OrganizationUser,
    Role,
    User,
    Workspace,
    WorkspaceUser
} from '../../database/entities/identity'
import { SYSTEM_ROLE_NAMES, SystemRoleName, systemRolePermissions } from '../../identity/services/BootstrapService'
import {
    RecoveryAuditAction,
    RecoveryCommand,
    RecoveryContext,
    RecoveryError,
    describeViolations,
    hashOrExplain,
    normaliseEmail,
    promptNewPassword,
    recordRecoveryEvent
} from '../recovery-base'

/**
 * `flowise admin:create --email <e> --role <r>` (REQUIREMENTS-MIGRATION.md §7).
 *
 * The command that exists so an instance can never become un-administrable. Everything else in the
 * recovery CLI repairs an account; this one conjures a working login out of nothing but filesystem
 * access to the data directory.
 *
 * ── The password is prompted, never argued ───────────────────────────────────────────────────
 * §7: "Passwords are prompted, never accepted as arguments — argv leaks into shell history and the
 * process table." There is no `--password` flag, and adding one would not be a convenience: on a
 * shared host `ps auxww` shows every argument of every process to every user, and `~/.bash_history`
 * outlives the incident. See `recovery-base.readSecret` for how the prompt refuses a pipe as well.
 *
 * ── The six-role hierarchy is enforced, not suggested ────────────────────────────────────────
 * `--role` must name one of MIGRATION §3's six roles. An unknown role is REFUSED rather than
 * created: a typo (`--role superadmin`) that silently minted a new, permission-less role would hand
 * the operator an account that logs in and can do nothing, at the exact moment they need it to do
 * everything — and the failure would look like a broken instance rather than a typo.
 */
export interface CreateAdminInput extends RecoveryContext {
    email: string
    role: string
    password: string
    name?: string | null
    /** Which tenant to create the account in. Defaults to the oldest organization, as bootstrap does. */
    organizationId?: string | null
}

export interface CreateAdminResult {
    userId: string
    email: string
    roleName: SystemRoleName
    roleId: string
    organizationId: string
    workspaceId: string
    isOrgOwner: boolean
    /** True when the command had to seed the role row / tenant itself because it was absent. */
    seededRole: boolean
    createdOrganization: boolean
    createdWorkspace: boolean
}

const isSystemRole = (role: string): role is SystemRoleName => (SYSTEM_ROLE_NAMES as readonly string[]).includes(role)

/**
 * Create the account, its membership and its workspace assignment in ONE transaction.
 *
 * Partial success is the failure mode that matters here. A user row with no `WorkspaceUser` logs in
 * and is rejected with 'No Workspace Assigned' (spec §F-12) — an account that exists, authenticates,
 * and still cannot be used, which is the most confusing possible outcome for someone already locked
 * out. Either all four rows land or none do.
 */
export const createAdminAccount = async (input: CreateAdminInput): Promise<CreateAdminResult> => {
    const email = normaliseEmail(input.email)
    const { dataSource, audit, actor } = input

    const fail = async (reason: string, message: string): Promise<never> => {
        await recordRecoveryEvent(audit, actor, {
            action: RecoveryAuditAction.ADMIN_CREATE,
            outcome: AuditOutcome.FAILURE,
            targetType: 'user',
            targetId: email || null,
            reason,
            message,
            detail: { email: email || null, role: input.role }
        })
        throw new RecoveryError(message)
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) await fail('invalid_email', `'${input.email}' is not a valid email address.`)

    if (!isSystemRole(input.role)) {
        await fail(
            'unknown_role',
            `Unknown role '${input.role}'. The six roles are: ${SYSTEM_ROLE_NAMES.join(', ')} ` +
                '(REQUIREMENTS-MIGRATION.md §3). Nothing was created.'
        )
    }
    const roleName = input.role as SystemRoleName

    // Belt-and-braces. The prompt already applied the policy; this catches a programmatic caller and
    // makes the refusal auditable in exactly the same way (MIGRATION §4: "the same check").
    const credential = await hashOrExplain(input.password).catch(async (error) => {
        await fail('weak_password', error instanceof Error ? error.message : String(error))
        return ''
    })

    const result = await dataSource.transaction(async (manager: EntityManager): Promise<CreateAdminResult> => {
        const existing = await manager.findOne(User, { where: { email } })
        if (existing) {
            throw new RecoveryError(
                `An account already exists for ${email}. Use 'flowise admin:reset-password --email ${email}' to regain access to it; ` +
                    'admin:create never overwrites an existing credential.'
            )
        }

        const tenant = await resolveTenant(manager, input.organizationId ?? null)
        const role = await resolveRole(manager, tenant.organization.id, roleName)

        const user = await manager.save(
            manager.create(User, {
                email,
                name: input.name?.trim() || email.split('@')[0],
                credential,
                isSSO: false,
                // MIGRATION §6: any account authenticating by password is flagged. A recovery password
                // has, by definition, just been typed by someone who is not necessarily its owner —
                // an operator recovering an instance for a colleague — so the flag is not optional
                // and there is no flag to suppress it.
                mustChangePassword: true,
                // The address came from the operator on the host, not from a self-service form. There
                // is nothing to verify and no mail server to verify it with; an unverified account
                // that cannot log in would defeat the whole command.
                emailVerifiedDate: new Date()
            })
        )

        // §D.3 — exactly one row per organization carries isOrgOwner, and it bypasses permission
        // evaluation entirely. It is claimed only when the organization has no owner at all, and only
        // by a super-admin: a recovery CLI that could silently hand org-ownership to a `read-only`
        // account would be a privilege-escalation tool.
        const ownerExists = await manager.findOne(OrganizationUser, { where: { organizationId: tenant.organization.id, isOrgOwner: true } })
        const isOrgOwner = !ownerExists && roleName === 'super-admin'
        await manager.save(
            manager.create(OrganizationUser, {
                organizationId: tenant.organization.id,
                userId: user.id,
                status: MemberStatus.ACTIVE,
                isOrgOwner
            })
        )

        await manager.save(manager.create(WorkspaceUser, { workspaceId: tenant.workspace.id, userId: user.id, roleId: role.role.id }))

        return {
            userId: user.id,
            email,
            roleName,
            roleId: role.role.id,
            organizationId: tenant.organization.id,
            workspaceId: tenant.workspace.id,
            isOrgOwner,
            seededRole: role.seeded,
            createdOrganization: tenant.createdOrganization,
            createdWorkspace: tenant.createdWorkspace
        }
    })

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.ADMIN_CREATE,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'user',
        targetId: result.userId,
        organizationId: result.organizationId,
        workspaceId: result.workspaceId,
        message: `Recovery CLI created ${roleName} ${email} (password change forced on first login)`,
        // The address and the role, never the password and never its hash (§9, §10).
        detail: {
            email,
            role: roleName,
            isOrgOwner: result.isOrgOwner,
            // NOT `mustChangePassword`: `crypto/redaction.ts` redacts any key whose NAME contains
            // `password`, `credential`, `secret`, `token` … The redactor is right — a name-based
            // denylist is what catches the field nobody anticipated — so the key bends, not the rule.
            // Spelled this way the flag survives into the trail; spelled the obvious way it arrives
            // as the string "[redacted]", which tells an investigator nothing.
            forcedChangeOnNextLogin: true,
            seededRole: result.seededRole,
            createdOrganization: result.createdOrganization,
            createdWorkspace: result.createdWorkspace
        }
    })

    return result
}

/**
 * Find the tenant to create the account in, creating a default one if the instance has none.
 *
 * Creating the tenant is deliberate. §7 requires every identity operation to work "without a working
 * UI and without a working login", and an instance whose bootstrap never completed has neither —
 * refusing here would mean the recovery command works everywhere except the one state it exists for.
 * The names and the `isOrgDefault` flag match `BootstrapService` exactly, so a later bootstrap adopts
 * what this created instead of building a second, competing default.
 */
const resolveTenant = async (
    manager: EntityManager,
    requestedOrganizationId: string | null
): Promise<{ organization: Organization; workspace: Workspace; createdOrganization: boolean; createdWorkspace: boolean }> => {
    let createdOrganization = false
    let createdWorkspace = false

    let organization: Organization | null
    if (requestedOrganizationId) {
        organization = await manager.findOne(Organization, { where: { id: requestedOrganizationId } })
        if (!organization) throw new RecoveryError(`No organization with id ${requestedOrganizationId}. Run 'flowise admin:list'.`)
    } else {
        // "The default organization" is the OLDEST one — the same definition BootstrapService uses,
        // so the two cannot disagree about which tenant they are operating on.
        const oldest = await manager.find(Organization, { order: { createdDate: 'ASC' }, take: 1 })
        organization = oldest[0] ?? null
        if (!organization) {
            organization = await manager.save(manager.create(Organization, { name: 'Default Organization' }))
            createdOrganization = true
        }
    }

    let workspace =
        (await manager.findOne(Workspace, { where: { organizationId: organization.id, isOrgDefault: true } })) ??
        (await manager.findOne(Workspace, { where: { organizationId: organization.id, name: DEFAULT_WORKSPACE_NAME } }))

    if (!workspace) {
        workspace = await manager.save(
            manager.create(Workspace, {
                name: DEFAULT_WORKSPACE_NAME,
                description: 'Created by the recovery CLI',
                organizationId: organization.id,
                isOrgDefault: true
            })
        )
        createdWorkspace = true
    }

    return { organization, workspace, createdOrganization, createdWorkspace }
}

/**
 * Find the role row, seeding it from `systemRolePermissions()` if the organization does not have it.
 *
 * An EXISTING role is used exactly as it stands and is never re-seeded — the same rule
 * `BootstrapService.ensureSystemRoles` states: the built-in grant set is a seed, not a spec the
 * database is reconciled against, and silently re-applying it would undo an operator's edits at the
 * least visible moment.
 */
const resolveRole = async (
    manager: EntityManager,
    organizationId: string,
    roleName: SystemRoleName
): Promise<{ role: Role; seeded: boolean }> => {
    const existing = await manager.findOne(Role, { where: { organizationId, name: roleName } })
    if (existing) return { role: existing, seeded: false }

    const permissions = systemRolePermissions(roleName)
    const role = await manager.save(
        manager.create(Role, {
            name: roleName,
            description: `Seeded by the recovery CLI (REQUIREMENTS-MIGRATION.md §3)`,
            // JSON-encoded string[], because the shipped client does JSON.parse(role.permissions).
            permissions: JSON.stringify(permissions),
            organizationId,
            isSystem: true
        })
    )
    return { role, seeded: true }
}

export default class AdminCreate extends RecoveryCommand {
    /** `RecoveryCommand` is `hidden` so the abstract base does not appear in help; the concrete
     *  commands opt back in, because static members are inherited. */
    static hidden = false

    static description = 'Create an administrative account. The password is prompted, never passed as an argument.'

    static examples = [
        '<%= config.bin %> admin:create --email ops@example.com --role super-admin',
        '<%= config.bin %> admin:create --email auditor@example.com --role super-user --name "Night Auditor"'
    ]

    static flags = {
        ...RecoveryCommand.flags,
        email: Flags.string({ description: 'Email address for the new account', required: true }),
        role: Flags.string({ description: `One of: ${SYSTEM_ROLE_NAMES.join(', ')}`, required: true, options: [...SYSTEM_ROLE_NAMES] }),
        name: Flags.string({ description: 'Display name (defaults to the local part of the address)' }),
        organization: Flags.string({ description: 'Organization id to create the account in (default: the oldest organization)' })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AdminCreate)
        const email = normaliseEmail(flags.email)

        const { password, violations } = await promptNewPassword(email)
        if (violations.length > 0) {
            // Audited as a failure BEFORE anything is written. A refused break-glass attempt is at
            // least as interesting to an investigator as a successful one (§10).
            await this.recordRecovery({
                action: RecoveryAuditAction.ADMIN_CREATE,
                outcome: AuditOutcome.FAILURE,
                targetType: 'user',
                targetId: email,
                reason: 'weak_password',
                message: `Recovery CLI refused to create ${email}: password rejected by policy`,
                detail: { email, role: flags.role, violations }
            })
            throw new RecoveryError(describeViolations(violations))
        }

        const result = await createAdminAccount({
            dataSource: this.dataSource,
            audit: this.audit,
            actor: this.actor,
            email,
            role: flags.role,
            password,
            name: flags.name ?? null,
            organizationId: flags.organization ?? null
        })

        if (result.createdOrganization) this.log(`Created organization ${result.organizationId} (the instance had none).`)
        if (result.createdWorkspace) this.log(`Created ${DEFAULT_WORKSPACE_NAME} ${result.workspaceId}.`)
        if (result.seededRole) this.log(`Seeded the '${result.roleName}' role for this organization.`)
        this.log(`Created ${result.roleName} ${result.email} (${result.userId}).`)
        if (result.isOrgOwner) this.log('This account is the organization owner.')
        this.log('A password change is required at first login.')
    }
}
