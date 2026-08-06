import express, { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { LoginMethodService } from '../services/LoginMethodService'

/**
 * `/loginmethod` — which sign-in methods this instance offers.
 *
 * CLEAN-ROOM PROVENANCE. Paths and shapes come from the Apache-2.0 client,
 * `packages/ui/src/api/loginmethod.js`, and from `utils/constants.ts` WHITELIST_URLS.
 *
 *   GET /loginmethod/default              UNAUTHENTICATED — whitelisted by prefix. The sign-in
 *                                         page calls it before anyone has signed in, to decide
 *                                         which provider buttons to draw.
 *   GET /loginmethod?organizationId=…     authenticated — one tenant's configuration.
 *
 * `PUT /loginmethod` and `POST /loginmethod/test` are NOT implemented. Both write or exercise SSO
 * provider configuration, and Flow-Wiser has no server-side SSO yet
 * (`identity/PlatformManager.ts`: `initializeSSO` is a documented no-op). Writing configuration
 * for a subsystem that cannot consume it would store operator secrets that nothing reads. They are
 * answered with the shared 501 handler rather than left unmounted — see `notImplemented.ts` for
 * why silence is the worse failure.
 */
const router = express.Router()

const service = () => new LoginMethodService()

/**
 * The instance-wide set. Enabled providers only, and only those with no organization.
 *
 * Always 200 with an array, including the empty one: the sign-in page treats a failure and an
 * empty list differently, and "no SSO configured" is a successful answer, not an error.
 */
router.get('/default', (_req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        res.status(StatusCodes.OK).json(await service().getDefaultLoginMethods())
    })().catch(next)
})

/**
 * One tenant's configuration.
 *
 * The organization id arrives in the query string, which is a REQUEST and not an authority
 * (REQUIREMENTS-MIGRATION §3a). It is honoured only when it matches the organization the session
 * already resolved to; anything else answers empty rather than 403, so the endpoint cannot be used
 * to probe which organization ids exist.
 */
router.get('/', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        const requested = typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined
        const active = (req as Request & { user?: { activeOrganizationId?: string } }).user?.activeOrganizationId
        if (!active || (requested && requested !== active)) {
            res.status(StatusCodes.OK).json([])
            return
        }
        res.status(StatusCodes.OK).json(await service().getLoginMethodsByOrganizationId(active))
    })().catch(next)
})

export default router
