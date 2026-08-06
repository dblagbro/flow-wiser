/**
 * Role mapping — REQUIREMENTS-MIGRATION.md §5, onto the §3 hierarchy.
 *
 * §5: "Existing role assignments map onto the new hierarchy: the org owner becomes **super-admin**,
 * other members become **user** unless their grants indicate otherwise. The mapping is written to
 * the audit trail and printed in the dry-run report."
 *
 * ── "unless their grants indicate otherwise" ─────────────────────────────────────────────────
 * That clause is the whole design. A migration that mapped by ROLE NAME would work on exactly one
 * deployment: the one that never renamed a role or created a custom one. The old `role` table is
 * fully editable — name, description and permission list — and the shipped UI encourages custom
 * roles, so on a real database the names are `owner`, `member`, `personal workspace`, and then
 * whatever the operator called the rest.
 *
 * So the mapping reads the GRANTS, and uses the name only as a tiebreaker for the three stock roles
 * whose meaning is fixed by upstream. The grant list is what actually decided what the account
 * could do yesterday, and it is therefore the only honest basis for deciding what it may do
 * tomorrow.
 *
 * ── The rules, in order ──────────────────────────────────────────────────────────────────────
 *  1. **Org owner → `super-admin`.** Stated outright by §5. Determined by the OWNERSHIP EDGE, not
 *     by the role name: the account whose `organization_user` row carries the organization's owner
 *     role. This is the account that must still be able to log in after the upgrade, so it gets the
 *     break-glass tier and everything else is a downgrade from it.
 *  2. **Organization-administration grants → `org-admin`.** The old stock `owner` role's grant list
 *     is literally `["organization","workspace"]` — two coarse tokens with no `:action` suffix,
 *     which is how the outgoing model expressed "administers the org". A NON-owner holding that
 *     role administers one organization, which is precisely §3's `org-admin`, not `super-admin`:
 *     the instance-wide tiers are reserved for the account §5 names.
 *  3. **User administration → `org-admin`.** `users:manage` / `roles:manage` are identity
 *     administration; §3 puts the lowest tier holding those at `org-admin`.
 *  4. **Any write grant → `user`.** §5's stated default. "Write" is any action that is not `view`
 *     and not one of the read-shaped tokens listed in {@link READ_SHAPED_ACTIONS}.
 *  5. **View-only grants, or none at all → `read-only`.** This is the "otherwise" of §5 pointing
 *     downward. An account whose entire grant list is view tokens could not create anything
 *     yesterday, and §3's `read-only` is the tier that says so. An EMPTY grant list lands here too:
 *     the stock `member` role ships with `permissions = []` and could do nothing at all, so mapping
 *     it to `user` would be a privilege GRANT performed silently by an upgrade — the one thing a
 *     migration must never do. Least privilege is the safe direction: an over-restricted account is
 *     a support ticket, an over-permitted one is an incident. Every such decision is printed and
 *     audited, and `super-admin` can raise any of them in one click.
 *
 * Rule 5's downward direction is the only place this deviates from a literal reading of §5's
 * "other members become user", and it deviates deliberately and visibly. Set
 * {@link RoleMappingOptions.mapEmptyGrantsToUser} to follow §5 literally instead.
 */
import type { SystemRoleName } from '../../identity/services/BootstrapService'

/**
 * The six roles of §3, most privileged first.
 *
 * Typed as `readonly SystemRoleName[]`, so if `BootstrapService.SYSTEM_ROLE_NAMES` ever changes,
 * this file stops compiling instead of silently mapping accounts onto a role that no longer exists.
 * `import type` means the reference is erased at compile time: nothing here pulls in the bootstrap
 * service's transitive dependencies (winston, `flowise-components`) at run time, which is what lets
 * the mapping be unit-tested without a server.
 */
export const TARGET_ROLE_NAMES: readonly SystemRoleName[] = ['super-admin', 'admin', 'super-user', 'org-admin', 'user', 'read-only']

/** The three roles upstream seeds. Recovered from a real 3.1.x database, not from the sources that seed them. */
export const STOCK_ROLE_NAMES = ['owner', 'member', 'personal workspace'] as const

/**
 * Coarse grants the outgoing model used for organization administration. They carry no `:action`
 * suffix because they were never `<category>:<action>` tokens — `["organization","workspace"]` is
 * the entire permission list of the stock `owner` role on a real 3.1.x database.
 */
const ORG_ADMIN_GRANTS = new Set(['organization', 'workspace'])

/** Identity-administration tokens. Holding either is `org-admin` at minimum under §3. */
const IDENTITY_ADMIN_GRANTS = new Set(['users:manage', 'roles:manage', 'sso:manage'])

/**
 * Actions that read rather than write, beyond the obvious `view`.
 *
 * `export` is deliberately NOT here: exporting a flow or a tool copies its contents out of the
 * instance, and §3's `read-only` tier ("views and executes deployed flows") does not include that.
 * An account that could export yesterday keeps a tier that can, which is `user`.
 */
const READ_SHAPED_ACTIONS = new Set(['view', 'marketplace', 'custom', 'preview-process'])

export type MappingRule =
    | 'org-owner'
    | 'org-administration-grants'
    | 'identity-administration-grants'
    | 'write-grants'
    | 'view-only-grants'
    | 'no-grants'
    | 'unmapped-no-role'

export interface LegacyRole {
    id: string
    name: string
    /** The raw `permissions` column — a JSON-encoded `string[]` on every version that has the column. */
    permissions: string | null
    organizationId: string | null
}

export interface RoleMappingDecision {
    /** The old role, or null when the assignment referenced a role id that no longer exists. */
    legacyRoleId: string | null
    legacyRoleName: string
    legacyGrantCount: number
    target: SystemRoleName
    rule: MappingRule
    /** One sentence, printed in the dry-run report and stored on the audit record. */
    reason: string
}

export interface RoleMappingOptions {
    /**
     * Follow §5's wording literally and map an EMPTY grant list to `user` instead of `read-only`.
     * Off by default — see rule 5 in the header for why.
     */
    mapEmptyGrantsToUser?: boolean
}

/** Parse the old `permissions` column. Anything unparseable is treated as no grants, and says so. */
export const parseLegacyGrants = (permissions: string | null | undefined): string[] => {
    if (typeof permissions !== 'string' || permissions.trim() === '') return []
    try {
        const parsed = JSON.parse(permissions)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((entry): entry is string => typeof entry === 'string')
    } catch {
        return []
    }
}

const isWriteGrant = (grant: string): boolean => {
    const separator = grant.indexOf(':')
    if (separator === -1) return false // coarse grants are handled by rule 2, not here
    const action = grant.slice(separator + 1)
    return !READ_SHAPED_ACTIONS.has(action)
}

/**
 * Decide the §3 role for one legacy assignment.
 *
 * @param role      the old `role` row, or null when the assignment points at a missing role id
 * @param isOrgOwner whether this user holds the organization's ownership edge (rule 1)
 */
export const mapLegacyRole = (role: LegacyRole | null, isOrgOwner: boolean, options: RoleMappingOptions = {}): RoleMappingDecision => {
    const grants = parseLegacyGrants(role?.permissions)
    const base = {
        legacyRoleId: role?.id ?? null,
        legacyRoleName: role?.name ?? '(missing role)',
        legacyGrantCount: grants.length
    }

    if (isOrgOwner) {
        return {
            ...base,
            target: 'super-admin',
            rule: 'org-owner',
            reason: `holds the organization ownership edge; §5 maps the org owner to super-admin (was "${base.legacyRoleName}")`
        }
    }

    if (!role) {
        // A membership row pointing at a deleted role. Not a reason to drop the account — it is a
        // reason to give it the least authority that still lets someone log in and be looked at.
        return {
            ...base,
            target: 'read-only',
            rule: 'unmapped-no-role',
            reason: 'assignment references a role id that no longer exists; mapped to the least-privileged tier for review'
        }
    }

    if (grants.some((grant) => ORG_ADMIN_GRANTS.has(grant))) {
        const matched = grants.filter((grant) => ORG_ADMIN_GRANTS.has(grant)).join(', ')
        return {
            ...base,
            target: 'org-admin',
            rule: 'org-administration-grants',
            reason: `"${role.name}" grants organization administration (${matched}) but does not hold the ownership edge; §3 bounds that to one organization`
        }
    }

    if (grants.some((grant) => IDENTITY_ADMIN_GRANTS.has(grant))) {
        const matched = grants.filter((grant) => IDENTITY_ADMIN_GRANTS.has(grant)).join(', ')
        return {
            ...base,
            target: 'org-admin',
            rule: 'identity-administration-grants',
            reason: `"${role.name}" grants identity administration (${matched}); the lowest §3 tier holding those is org-admin`
        }
    }

    const writes = grants.filter(isWriteGrant)
    if (writes.length > 0) {
        return {
            ...base,
            target: 'user',
            rule: 'write-grants',
            reason: `"${role.name}" holds ${writes.length} write grant(s) (e.g. ${writes
                .slice(0, 3)
                .join(', ')}); §5's default for a member`
        }
    }

    if (grants.length === 0) {
        const target: SystemRoleName = options.mapEmptyGrantsToUser ? 'user' : 'read-only'
        return {
            ...base,
            target,
            rule: 'no-grants',
            reason: options.mapEmptyGrantsToUser
                ? `"${role.name}" has an empty grant list; mapped to user by §5's literal wording (mapEmptyGrantsToUser)`
                : `"${role.name}" has an empty grant list and could do nothing before the upgrade; mapped to read-only rather than granted authority by a migration`
        }
    }

    return {
        ...base,
        target: 'read-only',
        rule: 'view-only-grants',
        reason: `"${role.name}" holds only read-shaped grants (${grants.length}); §3's read-only tier is what that was`
    }
}

/** One line per decision, for the dry-run report and the migration report. */
export const formatRoleMapping = (decisions: readonly (RoleMappingDecision & { subject: string; scope: string })[]): string => {
    if (decisions.length === 0) return '  (no role assignments to map)'
    return decisions
        .map(
            (decision) =>
                `  ${decision.subject.padEnd(32)} ${decision.scope.padEnd(22)} ` +
                `${decision.legacyRoleName} -> ${decision.target}\n` +
                `      rule=${decision.rule}: ${decision.reason}`
        )
        .join('\n')
}
