import { ExpressAdapter } from '@bull-board/express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { Request, Response } from 'express'
import 'global-agent/bootstrap'
import http from 'http'
import path from 'path'
import { DataSource } from 'typeorm'
import { AbortControllerPool } from './AbortControllerPool'
import { CachePool } from './CachePool'
import { ChatFlow } from './database/entities/ChatFlow'
import { getDataSource } from './DataSource'
import { Organization } from './database/entities/identity'
import { Workspace } from './database/entities/identity'
import { LoggedInUser } from './identity/Interface'
import { initializeJwtCookieMiddleware, verifyToken, verifyTokenForBullMQDashboard } from './identity/middleware/session'
import { initAuthSecrets } from './identity/utils/authSecrets'
import { IdentityManager } from './identity/PlatformManager'
import { MODE, Platform } from './Interface'
import { IMetricsProvider } from './Interface.Metrics'
import { OpenTelemetry } from './metrics/OpenTelemetry'
import { Prometheus } from './metrics/Prometheus'
import { getErrorMessage } from './errors/utils'
import errorHandlerMiddleware from './middlewares/errors'
import { NodesPool } from './NodesPool'
import { QueueManager } from './queue/QueueManager'
import { ScheduleBeat } from './schedule/ScheduleBeat'
import { RedisEventSubscriber } from './queue/RedisEventSubscriber'
import { initWebhookListenerRegistry } from './services/webhook-listener'
import flowiseApiV1Router from './routes'
import { UsageCacheManager } from './UsageCacheManager'
import { getEncryptionKey, getNodeModulesPackagePath } from './utils'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from './utils/constants'
import logger, { expressRequestLogger } from './utils/logger'
import { RateLimiterManager } from './utils/rateLimit'
import { SSEStreamer } from './utils/SSEStreamer'
import { Telemetry } from './utils/telemetry'
import { validateAPIKey } from './utils/validateKey'
import { getCorsOptions, getIframeSecurityHeaders, sanitizeMiddleware, validateCorsConfig } from './utils/XSS'

declare global {
    namespace Express {
        interface User extends LoggedInUser {}
        interface Request {
            user?: LoggedInUser
        }
        namespace Multer {
            interface File {
                bucket: string
                key: string
                acl: string
                contentType: string
                contentDisposition: null
                storageClass: string
                serverSideEncryption: null
                metadata: any
                location: string
                etag: string
            }
        }
    }
}

/**
 * Postgres: create the `uuid-ossp` extension before migrations run.
 *
 * Nineteen postgres migrations default a primary key to `uuid_generate_v4()`, starting with
 * the very first one (`Init1693891895163`). That function lives in the `uuid-ossp` extension,
 * and nothing in the codebase has ever created it — so a brand-new Postgres database aborts
 * on the first migration with `function uuid_generate_v4() does not exist`, and the server
 * never starts. Existing deployments are unaffected: their extension was created by hand, or
 * by a template database, years ago.
 *
 * This runs after `initialize()` and before `runMigrations()`, which is the only window where
 * it is both possible and early enough — migrations execute in timestamp order, so no
 * migration can be scheduled ahead of `Init1693891895163` to do it.
 *
 * A least-privilege database user may not hold CREATE on the database. That is a legitimate
 * configuration, so a failure here is logged and swallowed rather than fatal: if the extension
 * is already present the migrations succeed regardless, and if it is genuinely absent the
 * migration that needs it fails immediately afterwards with a clearer error than this one.
 */
const ensurePostgresUuidExtension = async (dataSource: DataSource): Promise<void> => {
    if (dataSource.options.type !== 'postgres') return
    try {
        await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')
    } catch (error) {
        logger.warn(
            `⚠️ [server]: Could not ensure the uuid-ossp extension exists (${getErrorMessage(error)}). ` +
                'If this is a new database, create it as a superuser: CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
        )
    }
}

/**
 * Seed the six system roles, the default tenancy, and any environment-supplied administrator.
 *
 * `BootstrapService` has existed, fully written and documented, with **no caller anywhere**. So on
 * every fresh install the six-role hierarchy — super-admin, admin, super-user, org-admin, user,
 * read-only — was never created, and `FLOWISE_BOOTSTRAP_EMAIL` / `FLOWISE_BOOTSTRAP_PASSWORD` did
 * nothing. The only role that ever came into existence was the single one `admin:create` seeded on
 * demand, which is why `doctor` reported five of six missing on a working instance. RBAC was fully
 * designed and one-sixth usable.
 *
 * Runs after migrations, because it writes to the tables they create, and before the identity
 * manager, so nothing can serve a request against a half-seeded instance. It is idempotent by
 * construction — existing organizations, workspaces, roles and accounts are adopted, never
 * duplicated — so it is safe on every boot, including against a database migrated from Flowise 3.x.
 *
 * A failure here is FATAL. Seeding is what makes the instance administrable; continuing past a
 * failure would produce exactly the half-initialized server that `initDatabase`'s catch block used
 * to allow.
 */
const runIdentityBootstrap = async (): Promise<void> => {
    const { BootstrapService } = await import('./identity/services/BootstrapService')
    // `allowNoIdentity`: seed roles and tenancy even with no account configured, rather than
    // refusing to start. See BootstrapService for why throwing there is the wrong trade.
    const result = await new BootstrapService().run({ allowNoIdentity: true })

    const created = result.rolesCreated.length
    logger.info(
        `👥 [server]: Identity bootstrap complete — ${created} role(s) created, ${result.rolesExisting.length} already present; ` +
            `${result.accountsCreated.length} account(s) created`
    )

    if (result.noAdministrableIdentity) {
        logger.warn(
            '⚠️ [server]: This instance has NO accounts, so nobody can sign in yet. Create the first ' +
                'administrator with:  flowise admin:create --email <you> --role super-admin  ' +
                '(or set FLOWISE_BOOTSTRAP_EMAIL and FLOWISE_BOOTSTRAP_PASSWORD and restart).'
        )
    }
}

export class App {
    app: express.Application
    nodesPool: NodesPool
    abortControllerPool: AbortControllerPool
    cachePool: CachePool
    telemetry: Telemetry
    rateLimiterManager: RateLimiterManager
    AppDataSource: DataSource = getDataSource()
    sseStreamer: SSEStreamer
    identityManager: IdentityManager
    metricsProvider: IMetricsProvider
    queueManager: QueueManager
    redisSubscriber: RedisEventSubscriber
    usageCacheManager: UsageCacheManager
    sessionStore: any

    constructor() {
        this.app = express()
    }

    async initDatabase() {
        // Initialize database
        try {
            await this.AppDataSource.initialize()
            logger.info('📦 [server]: Data Source initialized successfully')

            await ensurePostgresUuidExtension(this.AppDataSource)

            // Run Migrations Scripts
            await this.AppDataSource.runMigrations({ transaction: 'each' })
            logger.info('🔄 [server]: Database migrations completed successfully')

            await runIdentityBootstrap()

            // Initialize Identity Manager
            this.identityManager = await IdentityManager.getInstance()
            logger.info('🔐 [server]: Identity Manager initialized successfully')

            // Initialize nodes pool
            this.nodesPool = new NodesPool()
            await this.nodesPool.initialize()
            logger.info('🔧 [server]: Nodes pool initialized successfully')

            // Initialize abort controllers pool
            this.abortControllerPool = new AbortControllerPool()
            logger.info('⏹️ [server]: Abort controllers pool initialized successfully')

            // Initialize encryption key
            await getEncryptionKey()
            logger.info('🔑 [server]: Encryption key initialized successfully')

            // Initialize auth secrets (env → AWS Secrets Manager → filesystem)
            await initAuthSecrets()
            logger.info('🔐 [server]: Auth initialized successfully')

            // Initialize Rate Limit
            this.rateLimiterManager = RateLimiterManager.getInstance()
            await this.rateLimiterManager.initializeRateLimiters(await getDataSource().getRepository(ChatFlow).find())
            logger.info('🚦 [server]: Rate limiters initialized successfully')

            // Initialize cache pool
            this.cachePool = new CachePool()
            logger.info('💾 [server]: Cache pool initialized successfully')

            // Initialize usage cache manager
            this.usageCacheManager = await UsageCacheManager.getInstance()
            logger.info('📊 [server]: Usage cache manager initialized successfully')

            // Initialize telemetry
            this.telemetry = new Telemetry()
            logger.info('📈 [server]: Telemetry initialized successfully')

            // Initialize SSE Streamer
            this.sseStreamer = new SSEStreamer()
            this.sseStreamer.startHeartbeat()
            logger.info('🌊 [server]: SSE Streamer initialized successfully')

            // Init Queues
            if (process.env.MODE === MODE.QUEUE) {
                this.queueManager = QueueManager.getInstance()
                const serverAdapter = new ExpressAdapter()
                serverAdapter.setBasePath('/admin/queues')
                this.queueManager.setupAllQueues({
                    componentNodes: this.nodesPool.componentNodes,
                    telemetry: this.telemetry,
                    cachePool: this.cachePool,
                    appDataSource: this.AppDataSource,
                    abortControllerPool: this.abortControllerPool,
                    usageCacheManager: this.usageCacheManager,
                    identityManager: this.identityManager,
                    serverAdapter
                })
                logger.info('✅ [Queue]: All queues setup successfully')

                this.redisSubscriber = new RedisEventSubscriber(this.sseStreamer)
                await this.redisSubscriber.connect()
                this.redisSubscriber.startPeriodicCleanup()
                logger.info('🔗 [server]: Redis event subscriber connected successfully')
            }

            await initWebhookListenerRegistry(this.sseStreamer, this.redisSubscriber)
            logger.info('📡 [server]: Webhook listener registry initialized successfully')

            // Init ScheduleBeat (works in both queue and non-queue mode)
            await ScheduleBeat.getInstance().init()
            logger.info('⏰ [server]: ScheduleBeat initialized successfully')

            logger.info('🎉 [server]: All initialization steps completed successfully!')
        } catch (error) {
            logger.error('❌ [server]: Error during Data Source initialization:', error)
            // Rethrow. Previously this was logged and swallowed, so start() carried on to
            // config(), which dereferenced the identityManager this block never got to assign
            // and died with `Cannot read properties of undefined (reading 'initializeSSO')`.
            // The real cause was still in the log, several lines up, under a fatal-looking
            // TypeError that had nothing to do with it — and that is the log an operator reads
            // at 3am during a failed upgrade.
            //
            // Swallowing is also worse than it looks: any failure late in this sequence left a
            // half-initialized server that went on to listen and serve requests.
            throw error
        }
    }

    async config() {
        // Limit is needed to allow sending/receiving base64 encoded string
        const flowise_file_size_limit = process.env.FLOWISE_FILE_SIZE_LIMIT || '50mb'

        // Preserve raw bytes before JSON parsing for webhook HMAC signature verification
        const captureRawBody = (req: Request, _res: Response, buf: Buffer) => {
            ;(req as any).rawBody = buf
        }
        this.app.use(express.json({ limit: flowise_file_size_limit, verify: captureRawBody }))
        this.app.use(express.urlencoded({ limit: flowise_file_size_limit, extended: true, verify: captureRawBody }))

        // Enhanced trust proxy settings for load balancer
        let trustProxy: string | boolean | number | undefined = process.env.TRUST_PROXY
        if (typeof trustProxy === 'undefined' || trustProxy.trim() === '' || trustProxy === 'true') {
            // Default to trust all proxies
            trustProxy = true
        } else if (trustProxy === 'false') {
            // Disable trust proxy
            trustProxy = false
        } else if (!isNaN(Number(trustProxy))) {
            // Number: Trust specific number of proxies
            trustProxy = Number(trustProxy)
        }

        this.app.set('trust proxy', trustProxy)

        // Allow access from specified domains
        validateCorsConfig()
        this.app.use(cors(getCorsOptions()))

        // Parse cookies
        this.app.use(cookieParser())

        // Allow embedding from specified domains.
        const iframeSecurityHeaders = getIframeSecurityHeaders()
        this.app.use((req, res, next) => {
            for (const [headerName, headerValue] of Object.entries(iframeSecurityHeaders)) {
                res.setHeader(headerName, headerValue)
            }
            next()
        })

        // Switch off the default 'X-Powered-By: Express' header
        this.app.disable('x-powered-by')

        // Add the expressRequestLogger middleware to log all requests
        this.app.use(expressRequestLogger)

        // Add the sanitizeMiddleware to guard against XSS
        this.app.use(sanitizeMiddleware)

        const denylistURLs = process.env.DENYLIST_URLS ? process.env.DENYLIST_URLS.split(',') : []
        const whitelistURLs = WHITELIST_URLS.filter((url) => !denylistURLs.includes(url))
        const URL_CASE_INSENSITIVE_REGEX: RegExp = /\/api\/v1\//i
        const URL_CASE_SENSITIVE_REGEX: RegExp = /\/api\/v1\//

        await initializeJwtCookieMiddleware(this.app, this.identityManager)

        this.app.use(async (req, res, next) => {
            // Step 1: Check if the req path contains /api/v1 regardless of case
            if (URL_CASE_INSENSITIVE_REGEX.test(req.path)) {
                // Step 2: Check if the req path is casesensitive
                if (URL_CASE_SENSITIVE_REGEX.test(req.path)) {
                    // Step 3: Check if the req path is in the whitelist
                    const isWhitelisted = whitelistURLs.some((url) => req.path.startsWith(url))
                    if (isWhitelisted) {
                        next()
                    } else if (req.headers['x-request-from'] === 'internal') {
                        verifyToken(req, res, next)
                    } else {
                        const isAPIKeyBlacklistedURLS = API_KEY_BLACKLIST_URLS.some((url) => req.path.startsWith(url))
                        if (isAPIKeyBlacklistedURLS) {
                            return res.status(401).json({ error: 'Unauthorized Access' })
                        }

                        // Only check license validity for non-open-source platforms
                        if (this.identityManager.getPlatformType() !== Platform.OPEN_SOURCE) {
                            if (!this.identityManager.isLicenseValid()) {
                                return res.status(401).json({ error: 'Unauthorized Access' })
                            }
                        }

                        const { isValid, apiKey } = await validateAPIKey(req)
                        if (!isValid || !apiKey) {
                            return res.status(401).json({ error: 'Unauthorized Access' })
                        }

                        // Find workspace
                        const workspace = await this.AppDataSource.getRepository(Workspace).findOne({
                            where: { id: apiKey.workspaceId }
                        })
                        if (!workspace) {
                            return res.status(401).json({ error: 'Unauthorized Access' })
                        }

                        // Find organization
                        const activeOrganizationId = workspace.organizationId as string
                        const org = await this.AppDataSource.getRepository(Organization).findOne({
                            where: { id: activeOrganizationId }
                        })
                        if (!org) {
                            return res.status(401).json({ error: 'Unauthorized Access' })
                        }
                        const subscriptionId = org.subscriptionId as string
                        const customerId = org.customerId as string
                        const features = await this.identityManager.getFeaturesByPlan(subscriptionId)
                        const productId = await this.identityManager.getProductIdFromSubscription(subscriptionId)
                        // @ts-ignore
                        req.user = {
                            permissions: apiKey.permissions,
                            features,
                            activeOrganizationId: activeOrganizationId,
                            activeOrganizationSubscriptionId: subscriptionId,
                            activeOrganizationCustomerId: customerId,
                            activeOrganizationProductId: productId,
                            isOrganizationAdmin: false,
                            activeWorkspaceId: workspace.id,
                            activeWorkspace: workspace.name
                        }
                        next()
                    }
                } else {
                    return res.status(401).json({ error: 'Unauthorized Access' })
                }
            } else {
                // If the req path does not contain /api/v1, then allow the request to pass through, example: /assets, /canvas
                next()
            }
        })

        // this is for SSO and must be after the JWT cookie middleware
        await this.identityManager.initializeSSO(this.app)

        if (process.env.ENABLE_METRICS === 'true') {
            switch (process.env.METRICS_PROVIDER) {
                // default to prometheus
                case 'prometheus':
                case undefined:
                    this.metricsProvider = new Prometheus(this.app)
                    break
                case 'open_telemetry':
                    this.metricsProvider = new OpenTelemetry(this.app)
                    break
                // add more cases for other metrics providers here
            }
            if (this.metricsProvider) {
                await this.metricsProvider.initializeCounters()
                logger.info(`📊 [server]: Metrics Provider [${this.metricsProvider.getName()}] has been initialized!`)
            } else {
                logger.error(
                    "❌ [server]: Metrics collection is enabled, but failed to initialize provider (valid values are 'prometheus' or 'open_telemetry'."
                )
            }
        }

        this.app.use('/api/v1', flowiseApiV1Router)

        // ----------------------------------------
        // Configure number of proxies in Host Environment
        // ----------------------------------------
        this.app.get('/api/v1/ip', (request, response) => {
            response.send({
                ip: request.ip,
                msg: 'Check returned IP address in the response. If it matches your current IP address ( which you can get by going to http://ip.nfriedly.com/ or https://api.ipify.org/ ), then the number of proxies is correct and the rate limiter should now work correctly. If not, increase the number of proxies by 1 and restart Cloud-Hosted Flowise until the IP address matches your own. Visit https://docs.flowiseai.com/configuration/rate-limit#cloud-hosted-rate-limit-setup-guide for more information.'
            })
        })

        if (process.env.MODE === MODE.QUEUE && process.env.ENABLE_BULLMQ_DASHBOARD === 'true' && !this.identityManager.isCloud()) {
            // Initialize admin queues rate limiter
            const id = 'bullmq_admin_dashboard'
            await this.rateLimiterManager.addRateLimiter(
                id,
                60,
                100,
                process.env.ADMIN_RATE_LIMIT_MESSAGE || 'Too many requests to admin dashboard, please try again later.'
            )

            const rateLimiter = this.rateLimiterManager.getRateLimiterById(id)
            this.app.use('/admin/queues', rateLimiter, verifyTokenForBullMQDashboard, this.queueManager.getBullBoardRouter())
        }

        // ----------------------------------------
        // Serve UI static
        // ----------------------------------------

        const packagePath = getNodeModulesPackagePath('flowise-ui')
        const uiBuildPath = path.join(packagePath, 'build')
        const uiHtmlPath = path.join(packagePath, 'build', 'index.html')

        this.app.use('/', express.static(uiBuildPath))

        // All other requests not handled will return React app
        this.app.use((req: Request, res: Response) => {
            res.sendFile(uiHtmlPath)
        })

        // Error handling
        this.app.use(errorHandlerMiddleware)
    }

    async stopApp() {
        try {
            this.sseStreamer.stopHeartbeat()
            const removePromises: any[] = []
            removePromises.push(this.telemetry.flush())
            if (this.queueManager) {
                removePromises.push(this.redisSubscriber.disconnect())
            }
            await Promise.all(removePromises)
        } catch (e) {
            logger.error(`❌[server]: Flowise Server shut down error: ${e}`)
        }
    }
}

let serverApp: App | undefined

export async function start(): Promise<void> {
    serverApp = new App()

    const host = process.env.HOST
    const port = parseInt(process.env.PORT || '', 10) || 3000
    const server = http.createServer(serverApp.app)

    await serverApp.initDatabase()
    await serverApp.config()

    server.listen(port, host, () => {
        logger.info(`⚡️ [server]: Flowise Server is listening at ${host ? 'http://' + host : ''}:${port}`)
    })
}

export function getInstance(): App | undefined {
    return serverApp
}
