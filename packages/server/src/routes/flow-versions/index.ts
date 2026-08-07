import express, { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { checkPermission } from '../../identity/rbac/PermissionCheck'
import { getVersionStore } from '../../versioning/VersionStore'
import { diffText, filterToPromptChanges, toUnifiedText } from '../../versioning/diff'
import { normaliseFlowData } from '../../versioning/normalise'
import chatflowsService from '../../services/chatflows'

/**
 * `/flow-versions` — read and restore flow history (REQUIREMENTS-VERSIONING.md §"Phase 2").
 *
 * ── Permissions ──────────────────────────────────────────────────────────────────────────────
 *
 * Reads require `chatflows:view` and restore requires `chatflows:update` — history is not a
 * separate object with separate authority, it is the flow, so it must not be reachable by anyone
 * who could not read or edit the flow itself. Introducing new permissions here would create a way
 * to see a prompt's contents without holding `chatflows:view`, which is a privilege-escalation
 * shaped hole rather than a feature.
 *
 * ── Tenant scoping is not optional ───────────────────────────────────────────────────────────
 *
 * Every handler resolves the flow through `chatflowsService.getChatflowById(id, workspaceId)`
 * FIRST and lets that throw. The version store is a flat git repository with no notion of tenancy;
 * asking it for `flows/<id>.json` directly would happily return another organisation's prompts to
 * anyone who could guess a UUID. The database lookup is what enforces the boundary, so it always
 * happens before the store is touched — never after, and never in parallel.
 */

const router = express.Router()

/** Resolve + authorise in one step. Throws through to the error handler when the caller may not see it. */
const requireFlow = async (req: Request, chatflowId: string) => {
    const workspaceId = (req as Request & { user?: { activeWorkspaceId?: string } }).user?.activeWorkspaceId
    return await chatflowsService.getChatflowById(chatflowId, workspaceId)
}

const asDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' || value.length === 0) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** `GET /flow-versions/:id` — history, newest first (§2). */
router.get('/:id', checkPermission('chatflows:view'), (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        await requireFlow(req, req.params.id)
        const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500)
        res.json({ chatflowId: req.params.id, versions: await getVersionStore().history(req.params.id, limit) })
    })().catch(next)
})

/**
 * `GET /flow-versions/:id/at?when=<iso>` — the flow as of a moment (§3).
 *
 * Declared before `/:id/:ref` so the literal segment wins; Express matches in declaration order and
 * `at` would otherwise be swallowed as a ref and fail to resolve.
 */
router.get('/:id/at', checkPermission('chatflows:view'), (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        await requireFlow(req, req.params.id)
        const when = asDate(req.query.when)
        if (!when) {
            res.status(StatusCodes.BAD_REQUEST).json({ message: '`when` must be an ISO-8601 date', error: 'invalid_when' })
            return
        }
        const store = getVersionStore()
        const entry = await store.resolveAsOf(req.params.id, when)
        if (!entry) {
            res.status(StatusCodes.NOT_FOUND).json({ message: 'No version of this flow existed at that time', error: 'no_version_at' })
            return
        }
        res.json({ version: entry, flowData: await store.readAt(req.params.id, entry.oid) })
    })().catch(next)
})

/**
 * `GET /flow-versions/:id/diff?a=&b=` — §4, and §7 with `prompts=true`.
 *
 * `b` defaults to the flow's CURRENT saved state rather than to HEAD. Those differ whenever a save
 * failed to capture — capture is best-effort by design — and "how does this version differ from
 * what is live right now" is the question actually being asked before a restore.
 */
router.get('/:id/diff', checkPermission('chatflows:view'), (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        const chatflow = await requireFlow(req, req.params.id)
        const store = getVersionStore()

        const a = String(req.query.a ?? '')
        if (!a) {
            res.status(StatusCodes.BAD_REQUEST).json({ message: 'Query parameter `a` is required', error: 'missing_ref' })
            return
        }

        const oldText = await store.readAt(req.params.id, a)
        if (oldText === null) {
            res.status(StatusCodes.NOT_FOUND).json({ message: `No version ${a} for this flow`, error: 'unknown_ref' })
            return
        }

        const b = req.query.b ? String(req.query.b) : null
        const newText = b ? await store.readAt(req.params.id, b) : normaliseFlowData(chatflow.flowData)
        if (newText === null) {
            res.status(StatusCodes.NOT_FOUND).json({ message: `No version ${b} for this flow`, error: 'unknown_ref' })
            return
        }

        const full = diffText(oldText, newText)
        const promptsOnly = String(req.query.prompts ?? '') === 'true'
        const result = promptsOnly ? filterToPromptChanges(full) : full

        res.json({
            a,
            b: b ?? 'current',
            promptsOnly,
            added: result.added,
            removed: result.removed,
            identical: result.identical,
            hunks: result.hunks,
            unified: toUnifiedText(result, a, b ?? 'current')
        })
    })().catch(next)
})

/** `POST /flow-versions/:id/tag` — name a checkpoint (§6). */
router.post('/:id/tag', checkPermission('chatflows:update'), (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        await requireFlow(req, req.params.id)
        const { ref, label } = (req.body ?? {}) as { ref?: string; label?: string }
        if (!ref || !label) {
            res.status(StatusCodes.BAD_REQUEST).json({ message: '`ref` and `label` are both required', error: 'missing_field' })
            return
        }
        res.json({ label, oid: await getVersionStore().tag(ref, label) })
    })().catch(next)
})

/**
 * `POST /flow-versions/:id/restore` — §5, non-destructive.
 *
 * Restoring writes the chosen version's content back through the ORDINARY update path, which then
 * captures it as a NEW commit. So the version being moved away from stays in history permanently
 * and is reachable tomorrow — the guarantee §"Restore semantics" is built on — and the restore
 * itself is versioned like any other edit rather than being invisible.
 *
 * Going through the normal update path rather than writing the row directly is deliberate: it keeps
 * schedule syncing, file-path rewriting and every other side effect of a save in one place. A
 * restore that bypassed them would produce a flow that looks right and behaves subtly differently.
 */
router.post('/:id/restore', checkPermission('chatflows:update'), (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        const chatflow = await requireFlow(req, req.params.id)
        const { ref } = (req.body ?? {}) as { ref?: string }
        if (!ref) {
            res.status(StatusCodes.BAD_REQUEST).json({ message: '`ref` is required', error: 'missing_ref' })
            return
        }

        const store = getVersionStore()
        const restored = await store.readAt(req.params.id, ref)
        if (restored === null) {
            res.status(StatusCodes.NOT_FOUND).json({ message: `No version ${ref} for this flow`, error: 'unknown_ref' })
            return
        }

        const user = (req as Request & { user?: { activeOrganizationId?: string; activeWorkspaceId?: string } }).user
        const updated = await chatflowsService.updateChatflow(
            chatflow,
            { ...chatflow, flowData: restored } as typeof chatflow,
            user?.activeOrganizationId ?? '',
            user?.activeWorkspaceId ?? '',
            ''
        )

        res.json({
            restoredFrom: await store.resolve(ref),
            chatflow: updated,
            note: 'The version you moved away from remains in history and can be restored again.'
        })
    })().catch(next)
})

export default router
