import express from 'express'
import vectorsController from '../../controllers/vectors'
import { checkAnyPermission } from '../../identity/rbac/PermissionCheck'
import { getMulterStorage } from '../../utils'

const router = express.Router()

// CREATE
router.post(
    ['/upsert/', '/upsert/:id'],
    getMulterStorage().array('files'),
    vectorsController.getRateLimiterMiddleware,
    vectorsController.upsertVectorMiddleware
)
// `/internal-upsert/` is the builder's own upsert and is session-authenticated, so it takes the
// same edit-level permission as running a flow: it writes embeddings and costs money.
//
// `/upsert/` above is deliberately NOT guarded here. It is the API-key surface that external
// integrations call, and `checkAnyPermission` resolves permissions from a session user — adding it
// blind would break every key-based caller. Making that route require "a valid API key OR a
// session with permission" is a real design change, not a one-line guard, and is tracked
// separately rather than pretended to be fixed.
router.post(
    ['/internal-upsert/', '/internal-upsert/:id'],
    checkAnyPermission('chatflows:update,agentflows:update'),
    getMulterStorage().array('files'),
    vectorsController.createInternalUpsert
)

export default router
