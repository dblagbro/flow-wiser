import { Request, Response, NextFunction } from 'express'
import feedbackService from '../../services/feedback'
import { validateFeedbackForCreation, validateFeedbackForUpdate } from '../../services/feedback/validation'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'
import chatflowsService from '../../services/chatflows'
import { denyUnlessOwned, denyUnlessPublicOrOwned } from '../../utils/flowAccess'

const getAllChatMessageFeedback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: feedbackController.getAllChatMessageFeedback - id not provided!`
            )
        }
        const chatflowid = req.params.id

        // Reading every feedback row a flow has collected is an owner's report. `/feedback` is
        // whitelisted for anonymous callers so the embedded widget can SUBMIT a rating; it was
        // never meant to let them READ the collected ratings, and it had no check at all. QA proved
        // the leak by planting a canary string in a private flow's feedback and retrieving it
        // unauthenticated. A public flow does not change this: strangers may talk to it, which is
        // not the same as reading what every other stranger said.
        const flowForRead = await chatflowsService.getChatflowById(chatflowid)
        if (!flowForRead) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        const readDenied = await denyUnlessOwned(req, res, flowForRead)
        if (readDenied) return readDenied

        const chatId = req.query?.chatId as string | undefined
        const sortOrder = req.query?.order as string | undefined
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const apiResponse = await feedbackService.getAllChatMessageFeedback(chatflowid, chatId, sortOrder, startDate, endDate)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const createChatMessageFeedbackForChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: feedbackController.createChatMessageFeedbackForChatflow - body not provided!`
            )
        }
        await validateFeedbackForCreation(req.body)

        // Writing feedback IS the widget's job, so an anonymous caller is legitimate — but only
        // against a flow that is actually published. Anonymous writes onto a PRIVATE flow were
        // accepted and persisted, which is unauthenticated storage pollution on a resource the
        // caller cannot otherwise see.
        const flowForWrite = await chatflowsService.getChatflowById(req.body?.chatflowid)
        if (!flowForWrite) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        const writeDenied = await denyUnlessPublicOrOwned(req, res, flowForWrite)
        if (writeDenied) return writeDenied

        const apiResponse = await feedbackService.createChatMessageFeedbackForChatflow(req.body)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateChatMessageFeedbackForChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: feedbackController.updateChatMessageFeedbackForChatflow - body not provided!`
            )
        }
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: feedbackController.updateChatMessageFeedbackForChatflow - id not provided!`
            )
        }
        await validateFeedbackForUpdate(req.params.id, req.body)
        const apiResponse = await feedbackService.updateChatMessageFeedbackForChatflow(req.params.id, req.body)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    getAllChatMessageFeedback,
    createChatMessageFeedbackForChatflow,
    updateChatMessageFeedbackForChatflow
}
