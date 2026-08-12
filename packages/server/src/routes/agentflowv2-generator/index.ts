import express from 'express'
import agentflowv2GeneratorController from '../../controllers/agentflowv2-generator'
import { checkAnyPermission } from '../../identity/rbac/PermissionCheck'
const router = express.Router()

// Generating an agentflow calls an LLM and produces a flow definition. It is an authoring
// action, so it takes authoring permission.
router.post('/generate', checkAnyPermission('agentflows:create,agentflows:update'), agentflowv2GeneratorController.generateAgentflowv2)

export default router
