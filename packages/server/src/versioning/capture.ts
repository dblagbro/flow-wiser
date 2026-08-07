import { ChatFlow } from '../database/entities/ChatFlow'
import logger from '../utils/logger'
import { getVersionStore } from './VersionStore'
import { normaliseFlowData } from './normalise'
import { diffText } from './diff'

/**
 * Versioning — automatic capture (REQUIREMENTS-VERSIONING.md §1: "every flow create/update commits.
 * No user action.").
 *
 * ── Best effort, always ──────────────────────────────────────────────────────────────────────
 *
 * Every function here swallows its own failures after logging. A full disk, a permissions problem
 * or a corrupt version repository must never stop someone saving their work. Losing one version is
 * recoverable — the next save captures the current state — while losing the save is not. This is
 * the opposite of the read paths, which surface their errors, because an empty history returned
 * silently is indistinguishable from a flow that has never been edited.
 *
 * ── Why the message names the changed field ──────────────────────────────────────────────────
 *
 * §"Commit metadata" asks for `Update Ask Devin — chatPromptTemplate.systemMessagePrompt`. A list
 * of twenty commits all reading "Update Ask Devin" is a list you have to open twenty times. Naming
 * the field that moved is what makes the history skimmable, and it is computable here for free: the
 * previous version is already on disk, and the normalised form is line-oriented, so the changed
 * JSON keys fall out of the same diff the UI will show.
 */

/** Pull the changed field names out of a diff of the normalised forms. */
const describeChange = (previous: string | null, next: string): string | null => {
    if (previous === null) return null
    const result = diffText(previous, next, 0)
    if (result.identical) return null

    const keys = new Set<string>()
    for (const hunk of result.hunks) {
        for (const line of hunk.lines) {
            if (line.op === 'context') continue
            const match = /^\s*"([^"]+)"\s*:/.exec(line.text)
            // `id`, `type` and `position` move whenever a node is dragged; naming them in the
            // subject line would bury the field the user actually edited.
            if (match && !['id', 'type', 'position', 'positionAbsolute', 'width', 'height', 'selected', 'dragging'].includes(match[1])) {
                keys.add(match[1])
            }
        }
    }
    if (keys.size === 0) return null

    const named = [...keys].slice(0, 3).join(', ')
    return keys.size > 3 ? `${named} +${keys.size - 3} more` : named
}

export interface CaptureActor {
    name?: string | null
    email?: string | null
}

/**
 * Resolve the acting user's name and address from their id.
 *
 * §"Commit metadata" requires "Author: the acting user", and acceptance §1 requires every commit to
 * carry the correct author. `req.user` carries only an id — it is built by `AuthService.authenticate`,
 * which does not populate an address — so the identity row has to be read to turn that id into
 * something a history drawer can display.
 *
 * Best-effort, like everything else on the capture path: an unresolvable id falls back to the
 * placeholder rather than failing the save. It is looked up per capture rather than cached, because
 * a save is already doing database work and a stale cached address on an audit-adjacent record is
 * worse than one extra indexed read.
 */
const resolveActor = async (actorUserId?: string | null): Promise<CaptureActor | undefined> => {
    if (!actorUserId) return undefined
    try {
        // Required lazily: this module is imported by the chatflow service, which the CLI commands
        // pull in transitively — and the CLI has no running Express app to ask for a DataSource.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../utils/getRunningExpressApp')
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { User } = require('../database/entities/identity')
        const user = await getRunningExpressApp().AppDataSource.getRepository(User).findOne({ where: { id: actorUserId } })
        if (!user) return undefined
        return { name: user.name || user.email, email: user.email }
    } catch {
        return undefined
    }
}

/**
 * Capture a create or update. Returns the commit sha, or null when nothing changed or capture
 * failed — callers treat both the same way and must not branch on it for correctness.
 */
export const captureFlowVersion = async (
    chatflow: Partial<ChatFlow> & { id: string },
    actor?: CaptureActor | string,
    options: { action?: 'create' | 'update'; label?: string } = {}
): Promise<string | null> => {
    try {
        const resolved = typeof actor === 'string' ? await resolveActor(actor) : actor
        const store = getVersionStore()
        const next = normaliseFlowData(chatflow.flowData)
        const previous = await store.readAt(chatflow.id, 'HEAD').catch(() => null)

        const changed = describeChange(previous, next)
        const verb = options.action === 'create' || previous === null ? 'Create' : 'Update'
        const subject = `${verb} ${chatflow.name || chatflow.id}${changed ? ` — ${changed}` : ''}`

        const oid = await store.captureFlow({
            chatflowId: chatflow.id,
            flowData: chatflow.flowData,
            meta: {
                name: chatflow.name ?? null,
                type: chatflow.type ?? null,
                deployed: chatflow.deployed ?? null,
                category: chatflow.category ?? null,
                workspaceId: (chatflow as { workspaceId?: string }).workspaceId ?? null,
                organizationId: (chatflow as { organizationId?: string }).organizationId ?? null
            },
            author: { name: resolved?.name || 'unknown', email: resolved?.email || 'unknown@flow-wiser.local' },
            message: options.label ? `${subject}\n\n${options.label}` : subject,
            when: new Date()
        })

        if (oid) logger.info(`🗂️ [versioning]: captured ${oid.slice(0, 8)} for flow ${chatflow.id}`)
        return oid
    } catch (error) {
        logger.warn(`⚠️ [versioning]: could not capture a version for flow ${chatflow.id}: ${asMessage(error)}`)
        return null
    }
}

/** Record a deletion, so a flow's history ends explicitly rather than simply stopping. */
export const captureFlowDeletion = async (
    chatflowId: string,
    name?: string | null,
    actor?: CaptureActor | string
): Promise<string | null> => {
    try {
        const resolved = typeof actor === 'string' ? await resolveActor(actor) : actor
        return await getVersionStore().captureDeletion({
            chatflowId,
            name,
            author: { name: resolved?.name || 'unknown', email: resolved?.email || 'unknown@flow-wiser.local' }
        })
    } catch (error) {
        logger.warn(`⚠️ [versioning]: could not record the deletion of flow ${chatflowId}: ${asMessage(error)}`)
        return null
    }
}

const asMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
