import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { QueryRunner } from 'typeorm'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { WorkspaceUserErrorMessage, WorkspaceUserService } from '../../identity/services/WorkspaceUserService'
import { resolveOrganizationIdForWorkspace } from '../../identity/tenancy/ControllerServiceUtils'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { ChatflowType } from '../../Interface'
import { ScheduleBeat } from '../../schedule/ScheduleBeat'
import apiKeyService from '../../services/apikey'
import chatflowsService from '../../services/chatflows'
import scheduleService from '../../services/schedule'
import { GeneralErrorMessage } from '../../utils/constants'
import { assertPublicFlowHasNoCodeNode } from '../../utils/codeNodeGuard'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { denyUnlessPublicOrOwned } from '../../utils/flowAccess'
import { getPageAndLimitParams } from '../../utils/pagination'
import { checkUsageLimit } from '../../utils/quotaUsage'
import { RateLimiterManager } from '../../utils/rateLimit'
import { sanitizeFlowDataForPublicEndpoint } from '../../utils/sanitizeFlowData'
import { stripProtectedFields } from '../../utils/stripProtectedFields'

const checkIfChatflowIsValidForStreaming = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowIsValidForStreaming - id not provided!`
            )
        }
        // Whitelisted for anonymous callers so an embedded widget can ask whether the flow it is
        // about to talk to supports streaming. It had no ownership check at all, so it loaded and
        // parsed the flowData of ANY flow by UUID — leaking whether a private flow exists (200 vs a
        // 500 naming the internal service) and details of its node graph in the error text.
        const streamFlow = await chatflowsService.getChatflowById(req.params.id)
        if (!streamFlow) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        const streamDenied = await denyUnlessPublicOrOwned(req, res, streamFlow)
        if (streamDenied) return streamDenied

        const apiResponse = await chatflowsService.checkIfChatflowIsValidForStreaming(req.params.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const checkIfChatflowIsValidForUploads = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowIsValidForUploads - id not provided!`
            )
        }
        const apiResponse = await chatflowsService.checkIfChatflowIsValidForUploads(req.params.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.deleteChatflow - id not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.deleteChatflow - organization ${orgId} not found!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.deleteChatflow - workspace ${workspaceId} not found!`
            )
        }
        const userPermittedTypes: EnumChatflowType[] = []
        const permissions = req.user!.permissions
        if (req.user?.isOrganizationAdmin) {
            userPermittedTypes.push(EnumChatflowType.CHATFLOW)
            userPermittedTypes.push(EnumChatflowType.AGENTFLOW)
            userPermittedTypes.push(EnumChatflowType.MULTIAGENT)
            userPermittedTypes.push(EnumChatflowType.ASSISTANT)
        } else {
            if (permissions.includes(`chatflows:delete`)) userPermittedTypes.push(EnumChatflowType.CHATFLOW)
            if (permissions.includes(`agentflows:delete`)) userPermittedTypes.push(EnumChatflowType.AGENTFLOW)
            if (permissions.includes(`agentflows:delete`)) userPermittedTypes.push(EnumChatflowType.MULTIAGENT)
            if (permissions.includes(`assistants:delete`)) userPermittedTypes.push(EnumChatflowType.ASSISTANT)
            if (userPermittedTypes.length === 0)
                throw new InternalFlowiseError(StatusCodes.FORBIDDEN, `You do not have permission to delete any chatflow types`)
        }
        const apiResponse = await chatflowsService.deleteChatflow(req.params.id, orgId, workspaceId, userPermittedTypes, req.user?.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getAllChatflows = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { page, limit } = getPageAndLimitParams(req)

        const apiResponse = await chatflowsService.getAllChatflows(
            req.query?.type as ChatflowType,
            req.user?.activeWorkspaceId,
            page,
            limit
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Get specific chatflow via api key
const getChatflowByApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.apikey) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.getChatflowByApiKey - apikey not provided!`
            )
        }
        const apikey = await apiKeyService.getApiKey(req.params.apikey)
        if (!apikey) {
            return res.status(401).send('Unauthorized')
        }
        const apiResponse = await chatflowsService.getChatflowByApiKey(apikey.id, apikey.workspaceId, req.query.keyonly)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getChatflowById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.getChatflowById - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.getChatflowById - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await chatflowsService.getChatflowById(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const saveChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.saveChatflow - body not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.saveChatflow - organization ${orgId} not found!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.saveChatflow - workspace ${workspaceId} not found!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body

        const existingChatflowCount = await chatflowsService.getAllChatflowsCountByOrganization(body.type, orgId)
        const newChatflowCount = 1
        await checkUsageLimit('flows', subscriptionId, getRunningExpressApp().usageCacheManager, existingChatflowCount + newChatflowCount)

        const newChatFlow = new ChatFlow()
        Object.assign(newChatFlow, stripProtectedFields(body))

        // Security 2026-08-07: a public flow is executable without authentication, so a public
        // flow containing a code node is unauthenticated code execution by design.
        assertPublicFlowHasNoCodeNode(newChatFlow.isPublic, newChatFlow.flowData)
        newChatFlow.workspaceId = workspaceId
        // MIGRATION §3a denormalised tenant key. Resolved from the workspace so the two can never
        // disagree. Until this was written, `doctor` failed on every instance holding content.
        ;(newChatFlow as { organizationId?: string | null }).organizationId = await resolveOrganizationIdForWorkspace(workspaceId)
        const apiResponse = await chatflowsService.saveChatflow(
            newChatFlow,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager,
            req.user?.id
        )

        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.updateChatflow - id not provided!`)
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.saveChatflow - workspace ${workspaceId} not found!`
            )
        }
        const chatflow = await chatflowsService.getChatflowById(req.params.id, workspaceId)
        if (!chatflow) {
            return res.status(404).send('Chatflow not found')
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.saveChatflow - organization ${orgId} not found!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        const updateChatFlow = new ChatFlow()
        Object.assign(updateChatFlow, stripProtectedFields(body))

        // Security 2026-08-07: same guard on update. `flowData` may be absent from a partial
        // update that only flips isPublic, so fall back to the stored flow — otherwise publishing
        // an existing code-node flow in a body that omits flowData would slip straight through.
        assertPublicFlowHasNoCodeNode(updateChatFlow.isPublic, updateChatFlow.flowData ?? chatflow.flowData)
        updateChatFlow.id = chatflow.id
        const rateLimiterManager = RateLimiterManager.getInstance()
        await rateLimiterManager.updateRateLimiter(updateChatFlow)

        const apiResponse = await chatflowsService.updateChatflow(
            chatflow,
            updateChatFlow,
            orgId,
            workspaceId,
            subscriptionId,
            req.user?.id
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getSinglePublicChatflow = async (req: Request, res: Response, next: NextFunction) => {
    // No queryRunner here any more: denyUnlessPublicOrOwned owns the connection it needs and
    // releases it in its own finally, so there is one place that can leak it instead of two.
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.getSinglePublicChatflow - id not provided!`
            )
        }
        const chatflow = await chatflowsService.getChatflowById(req.params.id)
        if (!chatflow) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })

        // A public flow is served with its flowData sanitised — this endpoint's own behaviour,
        // not part of the access decision, so it stays here.
        if (chatflow.isPublic)
            return res.status(StatusCodes.OK).json({ ...chatflow, flowData: sanitizeFlowDataForPublicEndpoint(chatflow.flowData) })

        // The access decision itself is shared with getSinglePublicChatbotConfig. This function
        // used to own the only correct copy of it; that is exactly how the other endpoint came
        // to have no copy at all.
        const denied = await denyUnlessPublicOrOwned(req, res, chatflow)
        if (denied) return denied

        return res.status(StatusCodes.OK).json(chatflow)
    } catch (error) {
        next(error)
    }
}

const getSinglePublicChatbotConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.getSinglePublicChatbotConfig - id not provided!`
            )
        }

        // This endpoint returns the flow's chatbot configuration AND its sanitised `flowData` —
        // the node graph, the models chosen, which credential TYPES are wired. It had no access
        // check of any kind, so every private flow's definition was readable by anyone holding
        // its UUID. Found in QA against a live instance: 48 KB of a flow with `isPublic = 0`,
        // returned to an unauthenticated request from the public internet.
        //
        // The lookup has to happen before the ladder, because the ladder decides on `isPublic`
        // and `workspaceId`. A missing flow answers 404 before any of that, which is the same
        // answer an unauthorised caller gets for a flow that exists — so this is not an oracle.
        const chatflow = await chatflowsService.getChatflowById(req.params.id)
        if (!chatflow) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        const denied = await denyUnlessPublicOrOwned(req, res, chatflow)
        if (denied) return denied

        const apiResponse = await chatflowsService.getSinglePublicChatbotConfig(req.params.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const checkIfChatflowHasChanged = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowHasChanged - id not provided!`
            )
        }
        if (!req.params.lastUpdatedDateTime) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowHasChanged - lastUpdatedDateTime not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                'Error: chatflowsController.checkIfChatflowHasChanged - active workspace ID not found!'
            )
        }
        const apiResponse = await chatflowsService.checkIfChatflowHasChanged(req.params.id, req.params.lastUpdatedDateTime, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const setWebhookSecret = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.setWebhookSecret - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, `Error: chatflowsController.setWebhookSecret - workspace not found!`)
        }
        const apiResponse = await chatflowsService.setWebhookSecret(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const clearWebhookSecret = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.clearWebhookSecret - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, `Error: chatflowsController.clearWebhookSecret - workspace not found!`)
        }
        await chatflowsService.clearWebhookSecret(req.params.id, workspaceId)
        return res.sendStatus(StatusCodes.NO_CONTENT)
    } catch (error) {
        next(error)
    }
}

const getScheduleStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.getScheduleStatus - id not provided!'
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Error: chatflowsController.getScheduleStatus - workspace not found!')
        }
        const status = await scheduleService.getScheduleStatus(req.params.id, workspaceId)
        return res.json({
            enabled: status.record?.enabled ?? false,
            canEnable: status.canEnable,
            reason: status.reason,
            record: status.record
        })
    } catch (error) {
        next(error)
    }
}

const getScheduleTriggerLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.getScheduleTriggerLogs - id not provided!'
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                'Error: chatflowsController.getScheduleTriggerLogs - workspace not found!'
            )
        }
        const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined
        const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined
        const statusRaw = req.query.status
        const status = Array.isArray(statusRaw) ? (statusRaw as any) : statusRaw ? (String(statusRaw) as any) : undefined
        const result = await scheduleService.getTriggerLogs(req.params.id, workspaceId, { page, limit, status })
        return res.json(result)
    } catch (error) {
        next(error)
    }
}

const deleteScheduleTriggerLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.deleteScheduleTriggerLogs - id not provided!'
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                'Error: chatflowsController.deleteScheduleTriggerLogs - workspace not found!'
            )
        }
        const logIds: unknown = req.body?.logIds
        if (!Array.isArray(logIds) || logIds.some((x) => typeof x !== 'string')) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'logIds must be a string[]')
        }
        const result = await scheduleService.deleteTriggerLogs(req.params.id, workspaceId, logIds as string[])
        return res.json(result)
    } catch (error) {
        next(error)
    }
}

const toggleScheduleEnabled = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.toggleScheduleEnabled - id not provided!'
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Error: chatflowsController.toggleScheduleEnabled - workspace not found!')
        }
        const { enabled } = req.body
        if (typeof enabled !== 'boolean') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, '"enabled" must be a boolean')
        }
        const record = await scheduleService.toggleScheduleEnabled(req.params.id, workspaceId, enabled)
        await ScheduleBeat.getInstance().onScheduleChanged(record.id, enabled ? 'upsert' : 'delete')
        return res.json(record)
    } catch (error) {
        next(error)
    }
}

export default {
    checkIfChatflowIsValidForStreaming,
    checkIfChatflowIsValidForUploads,
    deleteChatflow,
    getAllChatflows,
    getChatflowByApiKey,
    getChatflowById,
    saveChatflow,
    updateChatflow,
    getSinglePublicChatflow,
    getSinglePublicChatbotConfig,
    checkIfChatflowHasChanged,
    setWebhookSecret,
    clearWebhookSecret,
    getScheduleStatus,
    getScheduleTriggerLogs,
    deleteScheduleTriggerLogs,
    toggleScheduleEnabled
}
