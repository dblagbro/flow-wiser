import { DataSource, QueryRunner } from 'typeorm'
import { MemberStatus, Organization, OrganizationUser } from '../../database/entities/identity'

/**
 * Organization reads — the tenant boundary itself.
 *
 * CLEAN-ROOM PROVENANCE. Derived from the Apache-2.0 call sites that resolve an organization from
 * a workspace, and from the Apache-2.0 client's use of `/organization`:
 *
 *   index.ts:268-278                 workspace.organizationId -> Organization row -> subscriptionId,
 *                                    customerId, then features and product id
 *   schedule/ScheduleExecutor.ts:171 the same lookup, for a scheduled run with no request
 *   packages/ui/src/api/user.js      GET /organizationuser?organizationId=…&userId=…
 *   packages/ui/src/views/organization/index.jsx:128
 *                                    first-run setup posts `body.organization` to /account/register
 *
 * Those sites all want the same three things: the organization row for an id, the membership row
 * that links a user to it, and the billing identifiers hung off it.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────────────────
 *
 * Every `/organization/*` endpoint the shipped client calls is a STRIPE endpoint —
 * `additional-seats-proration`, `plan-proration`, `customer-default-source`, `get-current-usage`,
 * `update-subscription-plan`. Flow-Wiser has no billing (`identity/PlatformManager.ts`: "there is
 * no edition to upsell to"), so there is nothing behind them to implement and inventing a
 * plausible-looking proration response would be worse than not answering.
 *
 * `subscriptionId` and `customerId` are still read and carried, because the Apache-2.0 code passes
 * them through to `executeAgentFlow` and onto the login payload. They are opaque strings here: the
 * identity layer stores and returns whatever an operator put in the column and never interprets
 * it.
 */

/** Organization plus the caller's relationship to it — the shape the login and scope paths need. */
export interface OrganizationMembership {
    organization: Organization
    membership: OrganizationUser
}

export interface OrganizationServiceOptions {
    /** Omit in the running server; resolved lazily, exactly as the other identity services do. */
    dataSource?: DataSource
}

export class OrganizationService {
    private readonly injectedDataSource?: DataSource

    constructor(options: OrganizationServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
    }

    /** Lazy `require` — a static import of `getRunningExpressApp` would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    /** One organization by id, or null. Null rather than a throw — every caller branches on absence. */
    async readOrganizationById(organizationId: string | undefined | null, queryRunner?: QueryRunner): Promise<Organization | null> {
        if (!organizationId) return null
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.findOne(Organization, { where: { id: organizationId } })
    }

    /**
     * Every organization a user belongs to, newest membership first.
     *
     * Returns the pair, not just the organization: `OrganizationUser.status` and `isOrgOwner` are
     * what decide whether the membership grants anything, and a caller handed a bare Organization
     * would have to go back for them — which is the shape of query that ends up forgotten.
     */
    async readOrganizationsByUserId(userId: string | undefined | null, queryRunner?: QueryRunner): Promise<OrganizationMembership[]> {
        if (!userId) return []
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager

        const memberships = await manager.find(OrganizationUser, { where: { userId }, order: { createdDate: 'DESC' } })
        if (memberships.length === 0) return []

        const pairs: OrganizationMembership[] = []
        for (const membership of memberships) {
            const organization = await manager.findOne(Organization, { where: { id: membership.organizationId } })
            // A membership pointing at a deleted organization is skipped rather than surfaced as a
            // half-populated pair: `flowise doctor` (MIGRATION §7) is where orphans get
            // reported, not a read path that a login depends on.
            if (organization) pairs.push({ organization, membership })
        }
        return pairs
    }

    /** The membership row for one (organization, user) pair, or null. */
    async readOrganizationUser(
        organizationId: string | undefined | null,
        userId: string | undefined | null,
        queryRunner?: QueryRunner
    ): Promise<OrganizationUser | null> {
        if (!organizationId || !userId) return null
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.findOne(OrganizationUser, { where: { organizationId, userId } })
    }

    /** Members of an organization. `ACTIVE` only by default — invited and inactive are not yet, or no longer, members. */
    async readOrganizationUsers(
        organizationId: string | undefined | null,
        options: { includeInactive?: boolean } = {},
        queryRunner?: QueryRunner
    ): Promise<OrganizationUser[]> {
        if (!organizationId) return []
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        const where = options.includeInactive ? { organizationId } : { organizationId, status: MemberStatus.ACTIVE }
        return manager.find(OrganizationUser, { where })
    }

    /**
     * Whether the instance has been bootstrapped.
     *
     * `AuthService.resolve` asks the same question to decide between first-run setup and the
     * sign-in form. Kept here as well so a route can answer it without constructing an
     * `AuthService`, and because "how many tenants exist" is an organization question.
     */
    async count(queryRunner?: QueryRunner): Promise<number> {
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.count(Organization)
    }
}

export default OrganizationService
