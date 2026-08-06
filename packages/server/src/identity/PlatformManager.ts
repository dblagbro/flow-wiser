import { NextFunction, Request, Response } from 'express'
import { Platform } from '../Interface'

/**
 * Platform and feature state — the Apache-2.0 replacement for the commercially-licensed
 * identity manager the Apache-2.0 server imports.
 *
 * CLEAN-ROOM PROVENANCE. The surface implemented here was derived entirely from Apache-2.0
 * CALL SITES, never from the original. Those sites are:
 *
 *   getPlatformType()               compared against Platform.CLOUD / Platform.OPEN_SOURCE
 *   isCloud()                       boolean guard
 *   isLicenseValid()                boolean guard, only reached when platform !== OPEN_SOURCE
 *   checkFeatureByPlan('feat:x')    Express middleware, mounted with router.use(...)
 *   getFeaturesByPlan()             map of feature flag -> enabled
 *   getProductIdFromSubscription()  billing identifier
 *   initializeSSO(app)              wires SSO strategies at boot
 *   IdentityManager.getInstance()   singleton accessor
 *
 * ── Why this is 60 lines instead of 560 ───────────────────────────────────────────────────
 *
 * The original gated features behind a paid plan: a licence key was verified against a
 * remote endpoint, a Stripe subscription resolved to a product id, and each feature was
 * allowed or denied according to what the customer had bought.
 *
 * FLOW-WISER HAS NOTHING TO GATE. It is open source, and there is no edition to upsell to.
 * So the honest implementation is not a reimplementation of plan enforcement — it is the
 * permanent absence of it. Every feature is on, for everyone, always.
 *
 * That is a deliberate divergence, not a stub standing in for missing work. Access control
 * in Flow-Wiser is RBAC — see identity/rbac — which asks "may THIS SUBJECT do this?", a
 * question about authorisation. Plan gating asked "has this DEPLOYMENT paid for this?", a
 * question about billing. Only the first is a security control, and only the first survives.
 *
 * The class keeps its name so the 37 Apache-2.0 call sites need an import-path change and
 * nothing else. It genuinely does manage platform identity; it simply no longer sells it.
 */

/** Every feature the Apache-2.0 UI knows how to ask about. All enabled, permanently. */
export const ALL_FEATURES = [
    'feat:account',
    'feat:datasets',
    'feat:evaluations',
    'feat:evaluators',
    'feat:files',
    'feat:login-activity',
    'feat:logs',
    'feat:roles',
    'feat:sso-config',
    'feat:users',
    'feat:workspaces'
] as const

export type FeatureFlag = (typeof ALL_FEATURES)[number]

export class IdentityManager {
    private static _instance: IdentityManager

    /** Singleton, matching how the Apache-2.0 bootstrap obtains it. */
    public static getInstance(): IdentityManager {
        if (!IdentityManager._instance) IdentityManager._instance = new IdentityManager()
        return IdentityManager._instance
    }

    public static get instance(): IdentityManager {
        return IdentityManager.getInstance()
    }

    /**
     * Always OPEN_SOURCE. Flow-Wiser has no cloud tier and no enterprise edition, so the
     * CLOUD and ENTERPRISE branches in the Apache-2.0 services are permanently unreachable
     * — which is correct, since those branches implement metering and seat limits.
     */
    public getPlatformType(): Platform {
        return Platform.OPEN_SOURCE
    }

    public isOpenSource(): boolean {
        return true
    }

    public isCloud(): boolean {
        return false
    }

    public isEnterprise(): boolean {
        return false
    }

    /**
     * True, because there is no licence that could be invalid.
     *
     * The only Apache-2.0 caller (index.ts) reaches this exclusively when the platform is
     * NOT open source, so it is unreachable in practice. Returning true rather than throwing
     * keeps that guard harmless if the condition is ever restructured — failing shut on a
     * licence check would refuse to start an instance that has no licence by design.
     */
    public isLicenseValid(): boolean {
        return true
    }

    /**
     * All features, enabled.
     *
     * `async` and subscription-shaped because the call sites are:
     *   `await this.identityManager.getFeaturesByPlan(subscriptionId)`   index.ts:277
     * The argument is accepted and ignored -- there is no plan to look up -- but dropping it from
     * the signature would break every caller for no gain.
     */
    public async getFeaturesByPlan(_subscriptionId?: string, _withoutCache = false): Promise<Record<string, boolean>> {
        return Object.fromEntries(ALL_FEATURES.map((f) => [f, true]))
    }

    /**
     * No billing, so no product.
     *
     * Returns the EMPTY STRING rather than null, and that is a call-site constraint, not a
     * preference: `schedule/ScheduleExecutor.ts:212` and `utils/buildChatflow.ts:1057` pass the
     * result straight into `executeAgentFlow({ ..., productId })`, whose parameter is a required
     * `string`. Null would not type-check there, and widening that parameter to `string | null`
     * would push the same question into every downstream consumer of it.
     *
     * Empty string is also the honest value: it is what "this deployment has no product" looks
     * like to code that only ever forwards it. Nothing in the Apache-2.0 tree branches on it.
     */
    public async getProductIdFromSubscription(_subscriptionId?: string): Promise<string> {
        return ''
    }

    /**
     * Feature gating middleware — a passthrough.
     *
     * Kept as middleware rather than removed from the 7 `router.use(...)` sites, so the
     * routing shape is unchanged and a future deployment could reintroduce gating in one
     * place. The parameter is accepted and ignored on purpose.
     */
    public static checkFeatureByPlan(_feature: string) {
        return (_req: Request, _res: Response, next: NextFunction): void => next()
    }

    public checkFeatureByPlan(feature: string) {
        return IdentityManager.checkFeatureByPlan(feature)
    }

    /**
     * SSO initialisation.
     *
     * REQUIREMENTS-AUTH-RBAC §7 makes SSO a v1 requirement and the Apache-2.0 UI already
     * ships the client for Google, Azure, GitHub and Auth0. The server side is not built
     * yet, so this is a documented no-op rather than a silent one: an instance with no SSO
     * provider configured behaves exactly as it does today, and `GET /loginmethod/default`
     * answers honestly with an empty provider list.
     */
    public async initializeSSO(_app: unknown): Promise<void> {
        return
    }
}
