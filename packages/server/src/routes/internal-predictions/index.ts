import express from 'express'
import internalPredictionsController from '../../controllers/internal-predictions'
import { checkAnyPermission } from '../../identity/rbac/PermissionCheck'
const router = express.Router()

// CREATE
// This is the builder's "run" button, not the public prediction API — that one lives at
// /api/v1/prediction and is API-key authenticated. Running a flow here spends money on the
// configured LLM and, when the flow contains a code node, executes JavaScript in this process
// (see the CODE_EXECUTION_MODE warning at boot). A `read-only` role reaching it was intra-workspace
// privilege escalation: QA confirmed a user holding only *:view permissions could execute flows.
// Edit-level permission is required because being able to run a flow is being able to spend on it.
router.post(['/', '/:id'], checkAnyPermission('chatflows:update,agentflows:update'), internalPredictionsController.createInternalPrediction)

export default router
