import { Request, Response, NextFunction } from 'express'
import chatflowsService from '../../services/chatflows'
import leadsService from '../../services/leads'
import { denyUnlessPublicOrOwned } from '../../utils/flowAccess'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const getAllLeadsForChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params.id === 'undefined' || req.params.id === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: leadsController.getAllLeadsForChatflow - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: leadsController.getAllLeadsForChatflow - workspace ${workspaceId} not found!`
            )
        }
        const chatflowid = req.params.id
        const chatflow = await chatflowsService.getChatflowByIdForWorkspace(chatflowid, workspaceId)
        if (!chatflow) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: leadsController.getAllLeadsForChatflow - chatflow ${chatflowid} not found in workspace ${workspaceId}`
            )
        }
        const apiResponse = await leadsService.getAllLeads(chatflowid)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const createLeadInChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.body === 'undefined' || req.body === '') {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: leadsController.createLeadInChatflow - body not provided!`
            )
        }
        // Capturing a lead IS the widget's job, so an anonymous caller is legitimate — but only
        // against a flow that is actually published. Anonymous writes onto a PRIVATE flow were
        // accepted and persisted, and the rows then showed up in the owner's lead list: unauth
        // storage pollution on a resource the caller cannot otherwise see.
        const leadFlow = await chatflowsService.getChatflowById(req.body?.chatflowid)
        if (!leadFlow) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        const leadDenied = await denyUnlessPublicOrOwned(req, res, leadFlow)
        if (leadDenied) return leadDenied

        const apiResponse = await leadsService.createLead(req.body)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    createLeadInChatflow,
    getAllLeadsForChatflow
}
