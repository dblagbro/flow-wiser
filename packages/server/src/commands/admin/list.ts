import { Flags } from '@oclif/core'
import { DataSource } from 'typeorm'
import { AuditOutcome } from '../../database/entities/identity/AuditEvent'
import {
    MfaFactor,
    MfaFactorStatus,
    Organization,
    OrganizationUser,
    Role,
    User,
    Workspace,
    WorkspaceUser
} from '../../database/entities/identity'
import { EnvBootstrapAccountResolver } from '../../identity/services/MfaPolicyService'
import { LockoutState, RecoveryAuditAction, RecoveryCommand, RecoveryContext, lockoutStateFor, recordRecoveryEvent } from '../recovery-base'

/**
 * `flow-wiser admin:list` (REQUIREMENTS-MIGRATION.md §7).
 *
 * The command every other recovery command's error message points at, and the first thing anyone
 * runs: "who can actually get into this instance?"
 *
 * ── Why it shows more than a list of addresses ───────────────────────────────────────────────
 * The Apache-2.0 `flowise user` command prints email addresses and a count. That answers "does this
 * address exist", which is almost never the question during a lockout. The question is "why can
 * nobody log in", and the answers are all in the columns below: the account is `inactive`, or it is
 * locked out, or it holds a role with no authority, or it is SSO-only and the provider is down, or
 * it has an MFA factor and the authenticator is gone. A list that omits those sends the operator to
 * `sqlite3` — which is the moment a recovery tool has failed.
 *
 * ── Reading is audited too ───────────────────────────────────────────────────────────────────
 * §7 says "every recovery command writes an audit record", without an exception for the read-only
 * ones — and it is right not to make one. Enumerating every administrator on an instance is
 * reconnaissance; it is exactly what an intruder with host access does first, and the trail is the
 * only thing that distinguishes them from an on-call engineer. The record names the count, not the
 * addresses, so the audit table does not become a second copy of the user list.
 */
export interface AdminListRow {
    userId: string
    email: string
    name: string | null
    /** Membership status per organization — a user may be active in one and inactive in another (§F-1). */
    memberships: { organizationId: string; organizationName: string | null; status: string; isOrgOwner: boolean; lastLogin: Date | null }[]
    /** Role held in each assigned workspace. An account with none cannot log in ('No Workspace Assigned'). */
    assignments: { workspaceId: string; workspaceName: string; roleName: string; isSystemRole: boolean }[]
    hasPassword: boolean
    isSSO: boolean
    mustChangePassword: boolean
    emailVerified: boolean
    confirmedMfaFactors: number
    /** Break-glass accounts named by `IDENTITY_BOOTSTRAP_EMAILS` are exempt from MFA enforcement (§4). */
    mfaExempt: boolean
    lockout: LockoutState
}

export const listAdminAccounts = async (
    context: RecoveryContext & { env?: NodeJS.ProcessEnv; emailFilter?: string | null }
): Promise<AdminListRow[]> => {
    const { dataSource, audit, actor } = context
    const env = context.env ?? process.env

    const users = await dataSource.getRepository(User).find({ order: { createdDate: 'ASC' } })
    const filtered = context.emailFilter ? users.filter((user) => user.email.includes(context.emailFilter as string)) : users

    const organizations = await dataSource.getRepository(Organization).find()
    const organizationName = new Map(organizations.map((organization) => [organization.id, organization.name ?? null]))
    const workspaces = await dataSource.getRepository(Workspace).find()
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    const roles = await dataSource.getRepository(Role).find()
    const roleById = new Map(roles.map((role) => [role.id, role]))

    const exemption = new EnvBootstrapAccountResolver(env)
    const rows: AdminListRow[] = []

    for (const user of filtered) {
        const memberships = await dataSource.getRepository(OrganizationUser).find({ where: { userId: user.id } })
        const assignments = await dataSource.getRepository(WorkspaceUser).find({ where: { userId: user.id } })
        const factors = await dataSource.getRepository(MfaFactor).count({ where: { userId: user.id, status: MfaFactorStatus.CONFIRMED } })
        // `credential` is `select: false`, so "does this account have a local password" needs an
        // explicit ask. The VALUE is never read out of the row — only whether one is present.
        const withCredential = await dataSource
            .getRepository(User)
            .findOne({ where: { id: user.id }, select: { id: true, credential: true } })

        rows.push({
            userId: user.id,
            email: user.email,
            name: user.name ?? null,
            memberships: memberships.map((membership) => ({
                organizationId: membership.organizationId,
                organizationName: organizationName.get(membership.organizationId) ?? null,
                status: membership.status,
                isOrgOwner: membership.isOrgOwner,
                lastLogin: membership.lastLogin ?? null
            })),
            assignments: assignments.map((assignment) => {
                const role = roleById.get(assignment.roleId)
                return {
                    workspaceId: assignment.workspaceId,
                    workspaceName: workspaceById.get(assignment.workspaceId)?.name ?? '(missing workspace)',
                    roleName: role?.name ?? '(missing role)',
                    isSystemRole: role?.isSystem ?? false
                }
            }),
            hasPassword: Boolean(withCredential?.credential),
            isSSO: user.isSSO,
            mustChangePassword: user.mustChangePassword,
            emailVerified: Boolean(user.emailVerifiedDate),
            confirmedMfaFactors: factors,
            mfaExempt: exemption.isExempt({ userId: user.id, email: user.email }),
            lockout: await lockoutStateFor(dataSource, user.id, env)
        })
    }

    await recordRecoveryEvent(audit, actor, {
        action: RecoveryAuditAction.ADMIN_LIST,
        outcome: AuditOutcome.SUCCESS,
        targetType: 'user',
        message: `Recovery CLI listed ${rows.length} account(s)`,
        // The COUNT, never the addresses — see the header.
        detail: { accounts: rows.length, locked: rows.filter((row) => row.lockout.locked).length, filtered: Boolean(context.emailFilter) }
    })

    return rows
}

/** One line per account, plus indented detail — readable in an 80-column ssh session, which is where this runs. */
export const formatAdminList = (rows: AdminListRow[]): string[] => {
    if (rows.length === 0) return ['No accounts exist. Run: flow-wiser admin:create --email <you> --role super-admin']

    const lines: string[] = [`${rows.length} account(s):`, '']
    for (const row of rows) {
        const flags: string[] = []
        if (row.lockout.locked) flags.push(`LOCKED (${row.lockout.failures} failures, until ${row.lockout.unlocksAt?.toISOString()})`)
        if (row.mustChangePassword) flags.push('must-change-password')
        if (!row.hasPassword) flags.push('no-local-password')
        if (row.isSSO) flags.push('sso')
        if (!row.emailVerified) flags.push('email-unverified')
        if (row.confirmedMfaFactors > 0) flags.push(`mfa:${row.confirmedMfaFactors}`)
        if (row.mfaExempt) flags.push('mfa-exempt')
        if (row.assignments.length === 0) flags.push('NO-WORKSPACE (cannot log in)')

        lines.push(`${row.email}  [${row.userId}]`)
        if (row.name) lines.push(`    name         ${row.name}`)
        for (const membership of row.memberships) {
            lines.push(
                `    org          ${membership.organizationName ?? membership.organizationId} — ${membership.status}${
                    membership.isOrgOwner ? ' (owner)' : ''
                }${membership.lastLogin ? `, last login ${membership.lastLogin.toISOString()}` : ', never logged in'}`
            )
        }
        for (const assignment of row.assignments) {
            lines.push(
                `    role         ${assignment.roleName}${assignment.isSystemRole ? '' : ' (custom)'} in ${assignment.workspaceName}`
            )
        }
        if (flags.length > 0) lines.push(`    flags        ${flags.join(', ')}`)
        lines.push('')
    }
    return lines
}

export default class AdminList extends RecoveryCommand {
    /** `RecoveryCommand` is `hidden` so the abstract base does not appear in help; the concrete
     *  commands opt back in, because static members are inherited. */
    static hidden = false

    static description = 'List every account, with the state that explains why it can or cannot log in.'

    static examples = ['<%= config.bin %> admin:list', '<%= config.bin %> admin:list --json']

    static flags = {
        ...RecoveryCommand.flags,
        json: Flags.boolean({ description: 'Emit JSON instead of the human-readable listing' }),
        email: Flags.string({ description: 'Only show accounts whose address contains this substring' })
    }

    protected async runRecovery(): Promise<void> {
        const { flags } = await this.parse(AdminList)
        const rows = await listAdminAccounts({
            dataSource: this.dataSource as DataSource,
            audit: this.audit,
            actor: this.actor,
            emailFilter: flags.email ?? null
        })

        if (flags.json) this.log(JSON.stringify(rows, null, 2))
        else for (const line of formatAdminList(rows)) this.log(line)
    }
}
