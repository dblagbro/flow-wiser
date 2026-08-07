import { Request } from 'express'
import { ChatFlow } from '../database/entities/ChatFlow'
import { ApiKey } from '../database/entities/ApiKey'
import { compareKeys } from './apiKey'
import apikeyService from '../services/apikey'

/**
 * Validate flow API Key, this is needed because Prediction/Upsert API is public
 *
 * ── FINDING 2 (security assessment 2026-08-07) — this used to fail OPEN ──────────────────────
 *
 * `if (!chatFlowApiKeyId) return true` meant a flow with no API key was executable by ANYONE who
 * knew its UUID. `/api/v1/prediction/` is whitelisted (`utils/constants.ts`), so the bootstrap
 * auth gate never runs for it, and this function was the only check on the path. Confirmed live:
 * an unauthenticated POST to a private, keyless flow reached `buildChatflow` and returned 500 for
 * a malformed payload — not 401. At the time, 22 of 25 production flows were keyless.
 *
 * That is unauthenticated flow execution: LLM spend, any SSRF reachable from a Requests/URL node,
 * and — combined with FINDING 0 — unauthenticated arbitrary file read/write through a code node.
 *
 * ── The rule now ─────────────────────────────────────────────────────────────────────────────
 *
 * A prediction is permitted when ANY of these holds:
 *   1. the flow carries an API key and the caller supplied a valid one;
 *   2. the flow is explicitly marked `isPublic` — the operator opted in;
 *   3. the caller is already authenticated (a session the middleware resolved, or an
 *      instance-level API key), which is how the editor and internal callers reach this path.
 *
 * "No key configured" is not one of them. Absence of a credential is not a credential.
 *
 * ── Compatibility ────────────────────────────────────────────────────────────────────────────
 *
 * This is a breaking change for anyone calling `/prediction/` on a keyless, non-public flow
 * without a session. That is exactly the access being removed, so it cannot be preserved. On the
 * deployment this was found on it changes nothing: every flow is `isPublic=0`, the one publicly
 * routed flow carries an API key, and nginx already returns 404 for the public prediction alias.
 * Operators relying on keyless external calls should mark the flow public or give it a key.
 */
export const validateFlowAPIKey = async (req: Request, chatflow: ChatFlow): Promise<boolean> => {
    const chatFlowApiKeyId = chatflow?.apikeyid

    if (!chatFlowApiKeyId) {
        // Opted-in public flow: the operator has deliberately made this reachable.
        if (chatflow?.isPublic) return true

        // Already-authenticated caller. `req.user` is populated by the session middleware from the
        // server-side session record, or by the bootstrap gate after validating an instance API
        // key — never from anything client-supplied on this request.
        const authenticated = (req as Request & { user?: { id?: string; activeWorkspaceId?: string } }).user
        if (authenticated?.id || authenticated?.activeWorkspaceId) return true

        // No key, not public, not authenticated — refuse.
        return false
    }

    const authorizationHeader = (req.headers['Authorization'] as string) ?? (req.headers['authorization'] as string) ?? ''
    if (chatFlowApiKeyId && !authorizationHeader) return false

    const suppliedKey = authorizationHeader.split(`Bearer `).pop()
    if (!suppliedKey) return false

    try {
        const apiKey = await apikeyService.getApiKeyById(chatFlowApiKeyId)
        if (!apiKey) return false

        const apiKeyWorkSpaceId = apiKey.workspaceId
        if (!apiKeyWorkSpaceId) return false

        if (apiKeyWorkSpaceId !== chatflow.workspaceId) return false

        const apiSecret = apiKey.apiSecret
        if (!apiSecret || !compareKeys(apiSecret, suppliedKey)) return false

        return true
    } catch (error) {
        return false
    }
}

/**
 * Validate and Get API Key Information
 * @param {Request} req
 * @returns {Promise<{isValid: boolean, apiKey?: ApiKey}>}
 */
export const validateAPIKey = async (req: Request): Promise<{ isValid: boolean; apiKey?: ApiKey }> => {
    const authorizationHeader = (req.headers['Authorization'] as string) ?? (req.headers['authorization'] as string) ?? ''
    if (!authorizationHeader) return { isValid: false }

    const suppliedKey = authorizationHeader.split(`Bearer `).pop()
    if (!suppliedKey) return { isValid: false }

    try {
        const apiKey = await apikeyService.getApiKey(suppliedKey)
        if (!apiKey) return { isValid: false }

        const apiKeyWorkSpaceId = apiKey.workspaceId
        if (!apiKeyWorkSpaceId) return { isValid: false }

        const apiSecret = apiKey.apiSecret
        if (!apiSecret || !compareKeys(apiSecret, suppliedKey)) {
            return { isValid: false, apiKey }
        }

        return { isValid: true, apiKey }
    } catch (error) {
        return { isValid: false }
    }
}
