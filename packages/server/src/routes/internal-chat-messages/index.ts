import express from 'express'
import chatMessagesController from '../../controllers/chat-messages'
import { checkAnyPermission } from '../../identity/rbac/PermissionCheck'
const router = express.Router()

// CREATE

// READ
router.get(['/', '/:id'], checkAnyPermission('chatflows:view,agentflows:view'), chatMessagesController.getAllInternalChatMessages)

// UPDATE

// DELETE

export default router
