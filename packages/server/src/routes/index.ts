import express from 'express'
import agentflowv2GeneratorRouter from './agentflowv2-generator'
import apikeyRouter from './apikey'
import assistantsRouter from './assistants'
import attachmentsRouter from './attachments'
import chatMessageRouter from './chat-messages'
import chatflowsRouter from './chatflows'
import chatflowsStreamingRouter from './chatflows-streaming'
import chatflowsUploadsRouter from './chatflows-uploads'
import componentsCredentialsRouter from './components-credentials'
import componentsCredentialsIconRouter from './components-credentials-icon'
import credentialsRouter from './credentials'
import customMcpServersRouter from './custom-mcp-servers'
import datasetRouter from './dataset'
import documentStoreRouter from './documentstore'
import evaluationsRouter from './evaluations'
import evaluatorsRouter from './evaluator'
import executionsRouter from './executions'
import exportImportRouter from './export-import'
import feedbackRouter from './feedback'
import fetchLinksRouter from './fetch-links'
import flowConfigRouter from './flow-config'
import getUploadFileRouter from './get-upload-file'
import internalChatmessagesRouter from './internal-chat-messages'
import internalPredictionRouter from './internal-predictions'
import leadsRouter from './leads'
import loadPromptRouter from './load-prompts'
import logsRouter from './log'
import marketplacesRouter from './marketplaces'
import mcpEndpointRouter from './mcp-endpoint'
import mcpServerRouter from './mcp-server'
import nodeConfigRouter from './node-configs'
import nodeCustomFunctionRouter from './node-custom-functions'
import nodeIconRouter from './node-icons'
import nodeLoadMethodRouter from './node-load-methods'
import nodesRouter from './nodes'
import nvidiaNimRouter from './nvidia-nim'
import oauth2Router from './oauth2'
import openaiAssistantsRouter from './openai-assistants'
import openaiAssistantsFileRouter from './openai-assistants-files'
import openaiAssistantsVectorStoreRouter from './openai-assistants-vector-store'
import openaiRealtimeRouter from './openai-realtime'
import pingRouter from './ping'
import predictionRouter from './predictions'
import pricingRouter from './pricing'
import promptListsRouter from './prompts-lists'
import publicChatbotRouter from './public-chatbots'
import publicChatflowsRouter from './public-chatflows'
import publicExecutionsRouter from './public-executions'
import settingsRouter from './settings'
import statsRouter from './stats'
import textToSpeechRouter from './text-to-speech'
import toolsRouter from './tools'
import upsertHistoryRouter from './upsert-history'
import validationRouter from './validation'
import variablesRouter from './variables'
import vectorRouter from './vectors'
import verifyRouter from './verify'
import versionRouter from './versions'
import webhookRouter from './webhook'
import webhookListenerRouter from './webhook-listener'

// Apache-2.0 identity layer. Ten mount points, three states — implemented, partially implemented,
// and explicitly 501. See docs/STATUS.md; the 501s are the backlog, not a design.
import createAccountRouter from '../identity/routes/account'
import createAuthRouter from '../identity/routes/auth'
import loginMethodRouter from '../identity/routes/loginMethod'
import mfaRouter from '../identity/routes/mfa'
import { notImplementedRouter } from '../identity/routes/notImplemented'
import { workspaceRouter, workspaceUserRouter } from '../identity/routes/workspace'
import { IdentityManager } from '../identity/PlatformManager'

const router = express.Router()

router.use('/ping', pingRouter)
router.use('/apikey', apikeyRouter)
router.use('/assistants', assistantsRouter)
router.use('/attachments', attachmentsRouter)
router.use('/chatflows', chatflowsRouter)
router.use('/chatflows-streaming', chatflowsStreamingRouter)
router.use('/chatmessage', chatMessageRouter)
router.use('/chatflows-uploads', chatflowsUploadsRouter)
router.use('/components-credentials', componentsCredentialsRouter)
router.use('/components-credentials-icon', componentsCredentialsIconRouter)
router.use('/credentials', credentialsRouter)
router.use('/datasets', IdentityManager.checkFeatureByPlan('feat:datasets'), datasetRouter)
router.use('/document-store', documentStoreRouter)
router.use('/evaluations', IdentityManager.checkFeatureByPlan('feat:evaluations'), evaluationsRouter)
router.use('/evaluators', IdentityManager.checkFeatureByPlan('feat:evaluators'), evaluatorsRouter)
router.use('/export-import', exportImportRouter)
router.use('/feedback', feedbackRouter)
router.use('/fetch-links', fetchLinksRouter)
router.use('/flow-config', flowConfigRouter)
router.use('/internal-chatmessage', internalChatmessagesRouter)
router.use('/internal-prediction', internalPredictionRouter)
router.use('/get-upload-file', getUploadFileRouter)
router.use('/leads', leadsRouter)
router.use('/load-prompt', loadPromptRouter)
router.use('/marketplaces', marketplacesRouter)
router.use('/node-config', nodeConfigRouter)
router.use('/node-custom-function', nodeCustomFunctionRouter)
router.use('/node-icon', nodeIconRouter)
router.use('/node-load-method', nodeLoadMethodRouter)
router.use('/nodes', nodesRouter)
router.use('/oauth2-credential', oauth2Router)
router.use('/openai-assistants', openaiAssistantsRouter)
router.use('/openai-assistants-file', openaiAssistantsFileRouter)
router.use('/openai-assistants-vector-store', openaiAssistantsVectorStoreRouter)
router.use('/openai-realtime', openaiRealtimeRouter)
router.use('/prediction', predictionRouter)
router.use('/prompts-list', promptListsRouter)
router.use('/public-chatbotConfig', publicChatbotRouter)
router.use('/public-chatflows', publicChatflowsRouter)
router.use('/public-executions', publicExecutionsRouter)
router.use('/stats', statsRouter)
router.use('/tools', toolsRouter)
router.use('/variables', variablesRouter)
router.use('/vector', vectorRouter)
router.use('/verify', verifyRouter)
router.use('/webhook', webhookRouter)
router.use('/webhook-listener', webhookListenerRouter)
router.use('/version', versionRouter)
router.use('/upsert-history', upsertHistoryRouter)
router.use('/settings', settingsRouter)
router.use('/pricing', pricingRouter)
router.use('/nvidia-nim', nvidiaNimRouter)
router.use('/executions', executionsRouter)
router.use('/validation', validationRouter)
router.use('/agentflowv2-generator', agentflowv2GeneratorRouter)
router.use('/text-to-speech', textToSpeechRouter)
router.use('/custom-mcp-servers', customMcpServersRouter)
router.use('/mcp-server', mcpServerRouter)
router.use('/mcp', mcpEndpointRouter)

// ── Identity ─────────────────────────────────────────────────────────────────────────────────
// Sign-in, sign-out, session refresh, MFA and the permission catalog are implemented. The
// administration surfaces below them are not, and say so with a 501 rather than falling through
// to the SPA catch-all at index.ts:364 — which would answer a JSON request with a page of HTML.
router.use('/auth', createAuthRouter())
router.use('/mfa', mfaRouter)
router.use('/account', createAccountRouter())
router.use('/loginmethod', loginMethodRouter)
router.use('/workspace', workspaceRouter)
router.use('/workspaceuser', workspaceUserRouter)
router.use(
    '/audit',
    IdentityManager.checkFeatureByPlan('feat:login-activity'),
    notImplementedRouter('The audit query API', 'Audit events are recorded; the query endpoint over them is not implemented in this build.')
)
router.use('/user', notImplementedRouter('User administration', 'Reading and updating user accounts is not implemented in this build.'))
router.use(
    '/organization',
    notImplementedRouter(
        'Organization administration',
        'Every /organization endpoint the client calls is a billing endpoint. Flow-Wiser has no billing, so there is nothing behind them.'
    )
)
router.use(
    '/role',
    IdentityManager.checkFeatureByPlan('feat:roles'),
    notImplementedRouter(
        'Role administration',
        'Roles are seeded by the bootstrap (identity/services/BootstrapService.ts); editing them over HTTP is not implemented in this build.'
    )
)
router.use(
    '/organizationuser',
    notImplementedRouter('Organization membership administration', 'Managing organization members is not implemented in this build.')
)
router.use('/logs', IdentityManager.checkFeatureByPlan('feat:logs'), logsRouter)
// router.use('/files', IdentityManager.checkFeatureByPlan('feat:files'), filesRouter)

export default router
