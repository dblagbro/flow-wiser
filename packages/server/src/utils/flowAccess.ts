import { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { WorkspaceUserErrorMessage, WorkspaceUserService } from '../identity/services/WorkspaceUserService'
import { GeneralErrorMessage } from './constants'
import { getRunningExpressApp } from './getRunningExpressApp'

/**
 * The access decision for endpoints that are reachable WITHOUT a session.
 *
 * ── Why these endpoints exist unauthenticated at all ─────────────────────────────────────────
 *
 * An embedded chat widget has no session and never will. So a handful of routes are whitelisted
 * (`utils/constants.ts` WHITELIST_URLS) for anonymous callers: fetching a public flow's chatbot
 * configuration, submitting thumbs-up/down, aborting a stream. What decides access on those routes
 * is the flow's own `isPublic` flag, then workspace membership — not the presence of a session.
 *
 * ── Why it lives in one file ─────────────────────────────────────────────────────────────────
 *
 * Three endpoints with this exact shape existed. `/public-chatflows/:id` implemented the check
 * correctly. `/public-chatbotConfig/:id` implemented nothing at all and returned the complete
 * definition of any private flow to anyone holding its UUID — 48 KB from a production instance,
 * unauthenticated, over the public internet. `/feedback/:chatflowid` also implemented nothing and
 * returned every stored feedback row for a private flow, proven in QA with a planted canary string.
 *
 * Two of three had no check, and the one that did was the one people had looked at. That is what a
 * security rule reimplemented per call site converges to, so there is now exactly one
 * implementation and no second copy to forget.
 *
 * Returns `null` when the caller may proceed. Otherwise it has already written the response and the
 * caller must return immediately.
 */
export const denyUnlessPublicOrOwned = async (
    req: Request,
    res: Response,
    chatflow: { isPublic?: boolean | null; workspaceId?: string }
): Promise<Response | null> => {
    // Public flows are public. This is the widget's path.
    if (chatflow.isPublic) return null

    // Not public: from here on a caller must be signed in AND in the owning workspace.
    if (!req.user) return res.status(StatusCodes.UNAUTHORIZED).json({ message: GeneralErrorMessage.UNAUTHORIZED })

    const queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
    try {
        const workspaceUser = await new WorkspaceUserService().readWorkspaceUserByUserId(req.user.id, queryRunner)
        if (workspaceUser.length === 0)
            return res.status(StatusCodes.NOT_FOUND).json({ message: WorkspaceUserErrorMessage.WORKSPACE_USER_NOT_FOUND })
        const workspaceIds = workspaceUser.map((user) => user.workspaceId)
        if (!workspaceIds.includes(chatflow.workspaceId as string))
            return res.status(StatusCodes.BAD_REQUEST).json({ message: 'You are not in the workspace that owns this chatflow' })
        return null
    } finally {
        await queryRunner.release()
    }
}

/**
 * Stricter sibling: the caller must be signed in AND in the owning workspace, whether or not the
 * flow is public.
 *
 * Reading every feedback row a flow has collected is an owner's report, not part of the widget's
 * job. A flow being public means strangers may TALK to it — it does not mean strangers may read
 * what everyone else said about it. `denyUnlessPublicOrOwned` would wave those requests through on
 * a public flow, which is right for the chatbot config and wrong here.
 */
export const denyUnlessOwned = async (req: Request, res: Response, chatflow: { workspaceId?: string }): Promise<Response | null> =>
    denyUnlessPublicOrOwned(req, res, { isPublic: false, workspaceId: chatflow.workspaceId })
