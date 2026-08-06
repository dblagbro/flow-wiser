import { DataSource, IsNull } from 'typeorm'
import { LoginMethod, LoginMethodProvider, LoginMethodStatus } from '../../database/entities/identity'

/**
 * Which sign-in methods an instance offers.
 *
 * CLEAN-ROOM PROVENANCE. There is no call site for this service in the Apache-2.0 SERVER tree —
 * the only consumer is the Apache-2.0 CLIENT, which is an equally valid derivation source and is
 * the other end of the same wire. `packages/ui/src/api/loginmethod.js`:
 *
 *     getLoginMethods(organizationId)  GET  /loginmethod?organizationId=${organizationId}
 *     getDefaultLoginMethods()        GET  /loginmethod/default
 *     updateLoginMethods(body)        PUT  /loginmethod
 *     testLoginMethod(body)           POST /loginmethod/test
 *
 * and `/api/v1/loginmethod/default` appears in `utils/constants.ts` WHITELIST_URLS — it is reached
 * before anyone is authenticated, because the sign-in page has to know which buttons to draw.
 *
 * ── What "default" means, and why it is a separate row set ───────────────────────────────────
 *
 * `LoginMethod.organizationId` is nullable. A row with a NULL organization is the INSTANCE-WIDE
 * configuration — the set the sign-in page can be told about before it knows who is signing in.
 * Rows with an organization are that tenant's overrides, readable only once the caller's
 * organization is known. Keeping them apart is what lets `/loginmethod/default` stay whitelisted
 * without leaking one tenant's provider list to an anonymous caller.
 *
 * ── Why the response never contains a secret ─────────────────────────────────────────────────
 *
 * `LoginMethod.clientSecret` is `select: false` on the entity, so it is absent unless asked for by
 * name, and nothing here asks. REQUIREMENTS-AUTH-RBAC §9: "encrypted values never appear in logs,
 * audit records, API responses, or error messages." The projection below is an allowlist rather
 * than a delete-list, so a column added to the entity later cannot leak by default.
 */

/** The safe-to-serve view of a login method. No secret, no encryption metadata. */
export interface LoginMethodSummary {
    id: string
    /** `azure` | `google` | `auth0` | `github` — what the sign-in page keys its buttons on. */
    name: LoginMethodProvider
    /** Operator-chosen button label, when set. */
    providerLabel: string | null
    status: LoginMethodStatus
    organizationId: string | null
    /** Non-secret provider settings (tenant id, issuer URL, …). Never the client secret. */
    config: string | null
}

const toSummary = (method: LoginMethod): LoginMethodSummary => ({
    id: method.id,
    name: method.name,
    providerLabel: method.providerLabel ?? null,
    status: method.status,
    organizationId: method.organizationId ?? null,
    config: method.config ?? null
})

export interface LoginMethodServiceOptions {
    /** Omit in the running server; resolved lazily, exactly as the other identity services do. */
    dataSource?: DataSource
}

export class LoginMethodService {
    private readonly injectedDataSource?: DataSource

    constructor(options: LoginMethodServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
    }

    /** Lazy `require` — a static import of `getRunningExpressApp` would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    /**
     * `GET /loginmethod/default` — the instance-wide, pre-authentication set.
     *
     * ENABLED rows only, and only those with no organization. An anonymous caller is told what it
     * can act on and nothing else: a disabled provider is not a button, and its existence is not
     * the anonymous caller's business.
     *
     * An empty list is the honest answer on a stock Flow-Wiser instance —
     * `identity/PlatformManager.ts` documents that server-side SSO is not implemented yet, so no
     * provider is configured and the sign-in page correctly renders password-only.
     */
    async getDefaultLoginMethods(): Promise<LoginMethodSummary[]> {
        const methods = await this.getDataSource()
            .getRepository(LoginMethod)
            .find({ where: { organizationId: IsNull(), status: LoginMethodStatus.ENABLE }, order: { name: 'ASC' } })
        return methods.map(toSummary)
    }

    /**
     * `GET /loginmethod?organizationId=…` — one tenant's configuration, for its administrators.
     *
     * Returns DISABLED rows too, unlike the default set: this answers "how is SSO configured
     * here?", which an administrator needs in order to turn something on, whereas the anonymous
     * endpoint answers "what can I sign in with?".
     *
     * The caller is responsible for having established that the subject may see this organization
     * — the id arrives in a query string, and a query string is a request, not an authority
     * (REQUIREMENTS-MIGRATION §3a).
     */
    async getLoginMethodsByOrganizationId(organizationId: string | undefined | null): Promise<LoginMethodSummary[]> {
        if (!organizationId) return []
        const methods = await this.getDataSource()
            .getRepository(LoginMethod)
            .find({ where: { organizationId }, order: { name: 'ASC' } })
        return methods.map(toSummary)
    }

    /** Whether any enabled provider exists at all — the one question the sign-in page needs answered. */
    async hasEnabledProvider(organizationId?: string | null): Promise<boolean> {
        const count = await this.getDataSource()
            .getRepository(LoginMethod)
            .count({ where: { organizationId: organizationId ?? IsNull(), status: LoginMethodStatus.ENABLE } })
        return count > 0
    }
}

export default LoginMethodService
