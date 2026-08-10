import express from 'express'
import chatMessageController from '../../controllers/chat-messages'
import { checkAnyPermission } from '../../identity/rbac/PermissionCheck'
const router = express.Router()

// CREATE
// NOTE: Unused route
// router.post(['/', '/:id'], chatMessageController.createChatMessage)

// READ — viewing a flow's conversation history follows viewing the flow.
router.get(['/', '/:id'], checkAnyPermission('chatflows:view,agentflows:view'), chatMessageController.getAllChatMessages)

// UPDATE — aborting a running message is an execution control, not a read.
router.put(
    ['/abort/', '/abort/:chatflowid/:chatid'],
    checkAnyPermission('chatflows:update,agentflows:update'),
    chatMessageController.abortChatMessage
)

// DELETE — this wipes conversation history. QA confirmed a `read-only` user could call it and
// receive 200. Destroying data is never a read operation.
router.delete(
    ['/', '/:id'],
    checkAnyPermission('chatflows:delete,agentflows:delete,executions:delete'),
    chatMessageController.removeAllChatMessages
)

export default router
