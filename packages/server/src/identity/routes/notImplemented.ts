import { NextFunction, Request, Response, Router } from 'express'
import { StatusCodes } from 'http-status-codes'
import logger from '../../utils/logger'

/**
 * A router that answers 501 for everything, with the reason.
 *
 * ── Why this exists rather than simply not mounting the route ────────────────────────────────
 *
 * The Apache-2.0 bootstrap ends with a catch-all that serves the SPA shell:
 *
 *     this.app.use((req, res) => res.sendFile(uiHtmlPath))    packages/server/src/index.ts:364
 *
 * So an unmounted `/api/v1/...` path does not 404. It returns **200 with a page of HTML**, which
 * the client's axios layer then tries to read as JSON. The observable symptom is a parse error, or
 * a screen that renders as though the server returned an empty object — several hops away from the
 * actual cause, which is that the endpoint was never built.
 *
 * A 501 with a message is a diagnosis. It also keeps the honest position visible in the route
 * table: these paths are known, they are not implemented, and nothing is pretending otherwise.
 *
 * ── What is behind these paths ───────────────────────────────────────────────────────────────
 *
 * The identity ADMIN surfaces — user, role and organization-user administration, account
 * self-service (register, invite, email verification, forgot/reset password), the audit query API,
 * and the Stripe billing endpoints. They are a substantial body of work in their own right and
 * none of them is required to sign in, to be authorised, or to run a flow. The cut-over that this
 * router is part of deliberately does not invent them: every other file in `identity/` was derived
 * from an Apache-2.0 call site, and inventing a plausible admin API without one would be the
 * failure mode this project exists to avoid.
 *
 * Removing an entry from this list means implementing it. That is the intended direction of
 * travel, and the list is the backlog.
 */
export const notImplementedRouter = (surface: string, detail: string): Router => {
    const router = Router()
    router.use((req: Request, res: Response, _next: NextFunction) => {
        logger.warn(`[identity] 501 ${req.method} ${req.baseUrl}${req.path} — ${surface} is not implemented`)
        res.status(StatusCodes.NOT_IMPLEMENTED).json({
            message: `${surface} is not available on this instance`,
            error: 'not_implemented',
            detail
        })
    })
    return router
}

export default notImplementedRouter
