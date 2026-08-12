import express from 'express'
import chatMessageController from '../../controllers/chat-messages'
import { checkAnyPermission } from '../../identity/rbac/PermissionCheck'
const router = express.Router()

// CREATE
// NOTE: Unused route
// router.post(['/', '/:id'], chatMessageController.createChatMessage)

// READ — viewing a flow's conversation history follows viewing the flow.
router.get(['/', '/:id'], checkAnyPermission('chatflows:view,agentflows:view'), chatMessageController.getAllChatMessages)

// UPDATE — deliberately NOT permission-guarded.
//
// This route is in WHITELIST_URLS (utils/constants.ts) so that an ANONYMOUS chat session can stop
// a stream it started. It is the "stop generating" button in the embedded widget, where there is
// no session and never will be.
//
// A guard was added here in the first pass at fixing API-03 and re-verification caught it: it made
// a route that is explicitly whitelisted for anonymous callers answer anonymous callers with 401.
// Guarding it was my own addition — the QA finding named internal-prediction, vector upsert,
// agentflow generation and message DELETE, not this. Aborting a stream you are already permitted
// to run is not an escalation; it stops work rather than starting it, and refusing it only strands
// the generation.
router.put(['/abort/', '/abort/:chatflowid/:chatid'], chatMessageController.abortChatMessage)

// DELETE — this wipes conversation history. QA confirmed a `read-only` user could call it and
// receive 200. Destroying data is never a read operation.
router.delete(
    ['/', '/:id'],
    checkAnyPermission('chatflows:delete,agentflows:delete,executions:delete'),
    chatMessageController.removeAllChatMessages
)

export default router
