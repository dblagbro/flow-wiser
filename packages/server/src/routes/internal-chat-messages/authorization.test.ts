import express from 'express'
import request from 'supertest'
import chatMessagesController from '../../controllers/chat-messages'
import router from './index'

jest.mock('../../controllers/chat-messages', () => ({
    __esModule: true,
    default: {
        getAllInternalChatMessages: jest.fn((_req, res) => res.json({ synthetic: true }))
    }
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    auditLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))

describe('internal conversation history authorization', () => {
    beforeEach(() => jest.clearAllMocks())

    const subjects = [
        { name: 'anonymous', user: undefined, status: 401 },
        { name: 'empty API-key grants', user: { activeWorkspaceId: 'fixture-workspace', permissions: [] }, status: 403 },
        {
            name: 'unrelated API-key grants',
            user: { activeWorkspaceId: 'fixture-workspace', permissions: ['apikeys:view'] },
            status: 403
        },
        { name: 'missing workspace', user: { permissions: ['chatflows:view'] }, status: 403 },
        {
            name: 'chatflow viewer',
            user: { activeWorkspaceId: 'fixture-workspace', permissions: ['chatflows:view'] },
            status: 200
        },
        {
            name: 'agentflow viewer',
            user: { activeWorkspaceId: 'fixture-workspace', permissions: ['agentflows:view'] },
            status: 200
        },
        { name: 'organization administrator', user: { isOrganizationAdmin: true }, status: 200 }
    ]

    describe.each(['/', '/synthetic-flow'])('GET %s', (endpoint) => {
        it.each(subjects)('$name returns $status before reading messages', async ({ user, status }) => {
            const app = express()
            app.use((req, _res, next) => {
                Object.assign(req, { user })
                next()
            })
            app.use('/api/v1/internal-chatmessage', router)
            await request(app).get(`/api/v1/internal-chatmessage${endpoint}`).expect(status)
            expect(chatMessagesController.getAllInternalChatMessages).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
        })
    })
})
