import express from 'express'
import credentialsController from '../../controllers/credentials'
import { checkPermission, checkAnyPermission } from '../../identity/rbac/PermissionCheck'
const router = express.Router()

// CREATE
router.post('/', checkPermission('credentials:create'), credentialsController.createCredential)

// READ
router.get('/', checkPermission('credentials:view'), credentialsController.getAllCredentials)
router.get(['/', '/:id'], checkAnyPermission('credentials:create,credentials:update'), credentialsController.getCredentialById)

// REVEAL
// N7: disclosing a credential VALUE requires `credentials:reveal` — the admin-only grant that
// tenancy §2 defines and that was, until now, enforced nowhere. `org-admin`, `super-user` and
// `user` deliberately do not hold it.
router.get('/:id/reveal', checkPermission('credentials:reveal'), credentialsController.revealCredentialById)

// UPDATE
router.put(['/', '/:id'], checkAnyPermission('credentials:create,credentials:update'), credentialsController.updateCredential)

// DELETE
router.delete(['/', '/:id'], checkPermission('credentials:delete'), credentialsController.deleteCredentials)

export default router
