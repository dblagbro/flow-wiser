/**
 * Synthetic Flowise databases for the migration-tool tests, and the glue that lets those tests run
 * the REAL identity migrations against them.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────────────────────
 * Every `CREATE TABLE` below was copied out of a real production Flowise 3.1.4 database with
 * `SELECT sql FROM sqlite_master`. Nothing here was written from the sources that create those
 * tables. That matters twice over: it keeps the fixtures honest — a hand-written approximation
 * tests the approximation, not the thing — and it is how the old schema was discovered at all.
 *
 * The reference database is the one described in the requirements: 57 applied migrations, 1 user,
 * 1 organization, 1 workspace, 3 stock roles, 25 chatflows, 3 credentials.
 *
 * ── Why `node:sqlite` and not TypeORM ────────────────────────────────────────────────────────
 * The tool takes its database handle structurally (see `migration-tool/db.ts`), so a test can hand
 * it a plain SQLite connection. That is the point: a migration tool whose tests cannot construct a
 * database is a migration tool that is only ever tested against production.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Database } from '../../../src/database/migration-tool/db'

/**
 * `node:sqlite` is a Node 22.5+ builtin, but its type declarations only ship in `@types/node`
 * 22.5 or later — and this workspace pins no `@types/node` at all, taking whatever version arrives
 * transitively. Importing it normally would make the test suite's compilation depend on a version
 * nobody controls. So the handle is required at run time and typed here, against the two methods
 * these fixtures actually use.
 */
interface SqliteStatement {
    all(...params: unknown[]): unknown[]
}
interface SqliteHandle {
    prepare(sql: string): SqliteStatement
    close(): void
}
type SqliteModule = { DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => SqliteHandle }
const { DatabaseSync } = require('node:sqlite') as SqliteModule

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The old schema, verbatim from a real 3.1.4 database
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The uuid default every identity table carries in the outgoing schema. */
const UUID_DEFAULT = `(lower(substr(hex(randomblob(16)), 1, 8) || '-' || substr(hex(randomblob(16)), 9, 4) || '-' || substr('1' || substr(hex(randomblob(16)), 9, 3), 1, 4) || '-' || substr('8' || substr(hex(randomblob(16)), 13, 3), 1, 4) || '-' || substr(hex(randomblob(16)), 17, 12)))`

export const LEGACY_IDENTITY_DDL: readonly string[] = [
    `CREATE TABLE "user" (
        "id" uuid default ${UUID_DEFAULT} primary key,
        "name" varchar(100) not null,
        "email" varchar(255) not null unique,
        "credential" text null,
        "tempToken" text null,
        "tokenExpiry" timestamp null,
        "status" varchar(20) default 'unverified' not null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "createdBy" uuid not null,
        "updatedBy" uuid not null
    )`,
    `CREATE TABLE "organization" (
        "id" uuid default ${UUID_DEFAULT} primary key,
        "name" varchar(100) default 'Default Organization' not null,
        "customerId" varchar(100) null,
        "subscriptionId" varchar(100) null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "createdBy" uuid not null,
        "updatedBy" uuid not null
    )`,
    `CREATE TABLE "organization_user" (
        "organizationId" uuid not null,
        "userId" uuid not null,
        "roleId" uuid not null,
        "status" varchar(20) default 'active' not null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "createdBy" uuid not null,
        "updatedBy" uuid not null,
        constraint "pk_organization_user" primary key ("organizationId", "userId")
    )`,
    `CREATE TABLE "workspace" (
        "id" uuid default ${UUID_DEFAULT} primary key,
        "name" varchar(100) not null,
        "description" text null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "organizationId" uuid not null,
        "createdBy" uuid not null,
        "updatedBy" uuid not null
    )`,
    `CREATE TABLE "workspace_user" (
        "workspaceId" uuid not null,
        "userId" uuid not null,
        "roleId" uuid not null,
        "status" varchar(20) default 'invited' not null,
        "lastLogin" timestamp null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "createdBy" uuid not null,
        "updatedBy" uuid not null,
        constraint "pk_workspace_user" primary key ("workspaceId", "userId")
    )`,
    `CREATE TABLE "role" (
        "id" uuid default ${UUID_DEFAULT} primary key,
        "organizationId" uuid null,
        "name" varchar(100) not null,
        "description" text null,
        "permissions" text not null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "createdBy" uuid null,
        "updatedBy" uuid null
    )`,
    `CREATE TABLE "login_method" (
        "id" uuid default ${UUID_DEFAULT} primary key,
        "organizationId" uuid null,
        "name" varchar(100) not null,
        "config" text not null,
        "status" varchar(20) default 'enable' not null,
        "createdDate" timestamp default current_timestamp not null,
        "updatedDate" timestamp default current_timestamp not null,
        "createdBy" uuid null,
        "updatedBy" uuid null
    )`,
    `CREATE TABLE "login_activity" (
        "id" varchar PRIMARY KEY NOT NULL,
        "username" varchar NOT NULL,
        "activity_code" integer NOT NULL,
        "message" varchar NOT NULL,
        "attemptedDateTime" datetime NOT NULL DEFAULT (datetime('now')), login_mode varchar)`,
    `CREATE TABLE "workspace_shared" (
        "id" varchar PRIMARY KEY NOT NULL,
        "workspaceId" varchar NOT NULL,
        "sharedItemId" varchar NOT NULL,
        "itemType" varchar NOT NULL,
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')))`
]

/** Resource tables as they exist BEFORE the workspace migrations — no `workspaceId` anywhere. */
export const PRE_3_0_RESOURCE_DDL: readonly string[] = [
    `CREATE TABLE "chat_flow" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "flowData" text NOT NULL,
        "deployed" boolean,
        "isPublic" boolean,
        "apikeyid" varchar,
        "chatbotConfig" text,
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')),
        "apiConfig" TEXT,
        "analytic" TEXT,
        "category" TEXT,
        "speechToText" TEXT,
        "type" VARCHAR(20) NOT NULL DEFAULT 'CHATFLOW')`,
    `CREATE TABLE "credential" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "credentialName" varchar NOT NULL,
        "encryptedData" text NOT NULL,
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE "chat_message" ("id" varchar PRIMARY KEY NOT NULL, "role" varchar NOT NULL, "chatflowid" varchar NOT NULL, "content" text NOT NULL, "sourceDocuments" text, "usedTools" text, "fileAnnotations" text, "fileUploads" text, "createdDate" datetime NOT NULL DEFAULT (datetime('now')), "chatType" VARCHAR NOT NULL DEFAULT 'INTERNAL', "chatId" VARCHAR NOT NULL, "memoryType" VARCHAR, "sessionId" VARCHAR, "leadEmail" TEXT, "agentReasoning" TEXT, "action" TEXT, "artifacts" TEXT, "followUpPrompts" TEXT, "executionId" varchar, "reasonContent" TEXT)`
]

/** The same tables at 3.1.x, with the `workspaceId` the workspace migrations added. */
export const RESOURCE_DDL_3_1: readonly string[] = [
    `CREATE TABLE "chat_flow" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "flowData" text NOT NULL,
        "deployed" boolean,
        "isPublic" boolean,
        "apikeyid" varchar,
        "chatbotConfig" text,
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')),
        "apiConfig" TEXT,
        "analytic" TEXT,
        "category" TEXT,
        "speechToText" TEXT,
        "type" VARCHAR(20) NOT NULL DEFAULT 'CHATFLOW',
        "workspaceId" TEXT,
        "followUpPrompts" TEXT, "textToSpeech" TEXT, "mcpServerConfig" TEXT, "webhookSecret" TEXT, "webhookSecretConfigured" BOOLEAN DEFAULT FALSE)`,
    `CREATE TABLE "credential" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "credentialName" varchar NOT NULL,
        "encryptedData" text NOT NULL,
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')),
        "workspaceId" TEXT)`,
    `CREATE TABLE "chat_message" ("id" varchar PRIMARY KEY NOT NULL, "role" varchar NOT NULL, "chatflowid" varchar NOT NULL, "content" text NOT NULL, "sourceDocuments" text, "usedTools" text, "fileAnnotations" text, "fileUploads" text, "createdDate" datetime NOT NULL DEFAULT (datetime('now')), "chatType" VARCHAR NOT NULL DEFAULT 'INTERNAL', "chatId" VARCHAR NOT NULL, "memoryType" VARCHAR, "sessionId" VARCHAR, "leadEmail" TEXT, "agentReasoning" TEXT, "action" TEXT, "artifacts" TEXT, "followUpPrompts" TEXT, "executionId" varchar, "reasonContent" TEXT)`,
    `CREATE TABLE "apikey" (
        "id" varchar PRIMARY KEY NOT NULL,
        "apiKey" varchar NOT NULL,
        "apiSecret" varchar NOT NULL,
        "keyName" varchar NOT NULL,
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')),
        "workspaceId" varchar, "permissions" TEXT NOT NULL DEFAULT '[]')`,
    `CREATE TABLE "document_store" (
        "id" varchar PRIMARY KEY NOT NULL,
        "name" varchar NOT NULL,
        "description" varchar,
        "status" varchar NOT NULL,
        "loaders" text,
        "whereUsed" text,
        "updatedDate" datetime NOT NULL DEFAULT (datetime('now')),
        "createdDate" datetime NOT NULL DEFAULT (datetime('now')),
        "vectorStoreConfig" TEXT,
        "embeddingConfig" TEXT,
        "recordManagerConfig" TEXT,
        "workspaceId" TEXT)`
]

/**
 * The `migrations` ledger of the reference database, in order. All 57 of them.
 *
 * Read straight out of production. The eleven identity migrations are interleaved with the Apache-2.0
 * ones exactly as they are applied in real life, which is what makes the pre-3.0 fixture below a
 * genuine prefix of this list rather than a guess at one.
 */
export const REFERENCE_MIGRATIONS: readonly [number, string][] = [
    [1693835579790, 'Init1693835579790'],
    [1693920824108, 'ModifyChatFlow1693920824108'],
    [1693921865247, 'ModifyChatMessage1693921865247'],
    [1693923551694, 'ModifyCredential1693923551694'],
    [1693924207475, 'ModifyTool1693924207475'],
    [1694090982460, 'AddApiConfig1694090982460'],
    [1694432361423, 'AddAnalytic1694432361423'],
    [1694657778173, 'AddChatHistory1694657778173'],
    [1699325775451, 'AddAssistantEntity1699325775451'],
    [1699325775451, 'AddVariableEntity1699325775451'],
    [1699481607341, 'AddUsedToolsToChatMessage1699481607341'],
    [1699900910291, 'AddCategoryToChatFlow1699900910291'],
    [1700271021237, 'AddFileAnnotationsToChatMessage1700271021237'],
    [1701788586491, 'AddFileUploadsToChatMessage1701788586491'],
    [1706364937060, 'AddSpeechToText1706364937060'],
    [1707213619308, 'AddFeedback1707213619308'],
    [1709814301358, 'AddUpsertHistoryEntity1709814301358'],
    [1710832117612, 'AddLead1710832117612'],
    [1711537986113, 'AddLeadToChatMessage1711537986113'],
    [1711637331047, 'AddDocumentStore1711637331047'],
    [1714548873039, 'AddEvaluation1714548873039'],
    [1714548903384, 'AddDatasets1714548903384'],
    [1714679514451, 'AddAgentReasoningToChatMessage1714679514451'],
    [1714808591644, 'AddEvaluator1714808591644'],
    [1715861032479, 'AddVectorStoreConfigToDocStore1715861032479'],
    [1716300000000, 'AddTypeToChatFlow1716300000000'],
    [1720230151480, 'AddApiKey1720230151480'],
    [1720230151482, 'AddAuthTables1720230151482'],
    [1720230151484, 'AddWorkspace1720230151484'],
    [1721078251523, 'AddActionToChatMessage1721078251523'],
    [1725629836652, 'AddCustomTemplate1725629836652'],
    [1726156258465, 'AddArtifactsToChatMessage1726156258465'],
    [1726654922034, 'AddWorkspaceShared1726654922034'],
    [1726655750383, 'AddWorkspaceIdToCustomTemplate1726655750383'],
    [1726666294213, 'AddFollowUpPrompts1726666294213'],
    [1727798417345, 'AddOrganization1727798417345'],
    [1729130948686, 'LinkWorkspaceId1729130948686'],
    [1729133111652, 'LinkOrganizationId1729133111652'],
    [1730519457880, 'AddSSOColumns1730519457880'],
    [1733011290987, 'AddTypeToAssistant1733011290987'],
    [1733752119696, 'AddSeqNoToDatasetRow1733752119696'],
    [1734074497540, 'AddPersonalWorkspace1734074497540'],
    [1737076223692, 'RefactorEnterpriseDatabase1737076223692'],
    [1738090872625, 'AddExecutionEntity1738090872625'],
    [1743758056188, 'FixOpenSourceAssistantTable1743758056188'],
    [1744964560174, 'AddErrorToEvaluationRun1744964560174'],
    [1746862866554, 'ExecutionLinkWorkspaceId1746862866554'],
    [1754986486669, 'AddTextToSpeechToChatFlow1754986486669'],
    [1755066758601, 'ModifyChatflowType1755066758601'],
    [1759419136055, 'AddTextToSpeechToChatFlow1759419136055'],
    [1759424923093, 'AddChatFlowNameIndex1759424923093'],
    [1764759496768, 'AddReasonContentToChatMessage1764759496768'],
    [1765360298674, 'AddApiKeyPermission1765360298674'],
    [1766000000000, 'AddCustomMcpServer1766000000000'],
    [1767000000000, 'AddMcpServerConfigToChatFlow1767000000000'],
    [1772000000000, 'AddScheduleEntities1772000000000'],
    [1776240000000, 'AddWebhookSecretToChatFlow1776240000000']
]

/** The ledger of a genuine pre-3.0 database: everything applied before `AddAuthTables`. */
export const PRE_3_0_MIGRATIONS = REFERENCE_MIGRATIONS.filter(([timestamp]) => timestamp < 1720230151482)

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Database adapter and the fake QueryRunner
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TestDatabase extends Database {
    handle: SqliteHandle
    close(): void
    /** Raw helper for assertions. */
    all(sql: string, params?: unknown[]): Record<string, unknown>[]
}

/**
 * Wrap a `node:sqlite` handle as the tool's {@link Database}.
 *
 * `transaction` issues real BEGIN/COMMIT/ROLLBACK. There is exactly one connection, so the
 * transaction genuinely contains the work — which is what the abort-and-roll-back test depends on.
 */
export const openTestDatabase = (file: string): TestDatabase => {
    const handle = new DatabaseSync(file)
    const run = (sql: string, params: readonly unknown[] = []): Record<string, unknown>[] => {
        // `.all()` is valid for every statement kind on node:sqlite — DDL, DML and PRAGMA all
        // return `[]` rather than throwing — so one path covers everything the tool issues.
        // Booleans are converted because SQLite has no boolean type and the binder rejects them.
        const bound = params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : (value as any)))
        return handle.prepare(sql).all(...bound) as Record<string, unknown>[]
    }
    const base = {
        engine: 'sqlite' as const,
        filePath: file,
        query: async (sql: string, params?: readonly unknown[]) => run(sql, params ?? [])
    }
    return {
        ...base,
        handle,
        all: (sql: string, params: unknown[] = []) => run(sql, params),
        close: () => handle.close(),
        transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
            run('BEGIN')
            try {
                const value = await fn(base)
                run('COMMIT')
                return value
            } catch (error) {
                try {
                    run('ROLLBACK')
                } catch {
                    /* the original error is the one that matters */
                }
                throw error
            }
        }
    }
}

/**
 * Enough of TypeORM's `QueryRunner` for the identity migration classes to run against a plain
 * SQLite handle.
 *
 * The migration files import `MigrationInterface` and `QueryRunner` as TYPES only, so TypeScript
 * elides both imports and the compiled modules require nothing from typeorm at run time. That is
 * what makes this possible — and it means the fixtures are built by the SHIPPING DDL, not by a copy
 * of it that can drift.
 */
export const fakeQueryRunner = (db: TestDatabase): any => ({
    query: async (sql: string, params?: unknown[]) => db.all(sql, params ?? []),
    getTable: async (name: string) => {
        const found = db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name])
        if (found.length === 0) return undefined
        return { columns: db.all(`PRAGMA table_info("${name}")`).map((row) => ({ name: String(row.name) })) }
    }
})

/** Run the four shipping identity migrations, in order, against `db`. */
export const applyIdentityMigrations = async (db: TestDatabase): Promise<void> => {
    const runner = fakeQueryRunner(db)
    const modules = [
        ['../../../src/database/migrations/sqlite/1780000000000-AddIdentityTables', 'AddIdentityTables1780000000000'],
        ['../../../src/database/migrations/sqlite/1780000000001-AddIdentitySessionTables', 'AddIdentitySessionTables1780000000001'],
        ['../../../src/database/migrations/sqlite/1780000000002-AddIdentityMfaAuditTables', 'AddIdentityMfaAuditTables1780000000002'],
        [
            '../../../src/database/migrations/sqlite/1780000000010-AddMustChangePasswordToIdentityUser',
            'AddMustChangePasswordToIdentityUser1780000000010'
        ]
    ] as const
    for (const [modulePath, exportName] of modules) {
        const loaded = require(modulePath)
        await new loaded[exportName]().up(runner)
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const makeTempDirectory = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `flow-wiser-${label}-`))

const seedMigrations = (db: TestDatabase, ledger: readonly (readonly [number, string])[]): void => {
    db.all(
        `CREATE TABLE "migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "timestamp" bigint NOT NULL, "name" varchar NOT NULL)`
    )
    for (const [timestamp, name] of ledger) db.all(`INSERT INTO "migrations" ("timestamp", "name") VALUES (?, ?)`, [timestamp, name])
}

/** Deterministic filler, so a fixture is byte-identical between runs and a hash comparison means something. */
const flowData = (index: number): string =>
    JSON.stringify({
        nodes: [{ id: `node_${index}`, data: { label: `Node ${index}`, inputs: { model: 'gpt-4', temperature: 0.7 } } }],
        edges: []
    })

/** Opaque bytes standing in for a real credential's ciphertext. The tool must never read or rewrite it. */
const ciphertext = (index: number): string => Buffer.from(`U2FsdGVkX1+ciphertext-${index}-`.repeat(4)).toString('base64')

export interface Pre30Fixture {
    directory: string
    file: string
    db: TestDatabase
}

/**
 * Fixture (a): a pre-3.0 database. `chat_flow` + `credential` + `chat_message`, no identity tables
 * at all, and a migrations ledger that stops before `AddAuthTables`.
 */
export const createPre30Database = async (): Promise<Pre30Fixture> => {
    const directory = makeTempDirectory('pre30')
    const file = path.join(directory, 'database.sqlite')
    const db = openTestDatabase(file)

    for (const ddl of PRE_3_0_RESOURCE_DDL) db.all(ddl)
    seedMigrations(db, PRE_3_0_MIGRATIONS)

    for (let index = 0; index < 7; index++) {
        db.all(
            `INSERT INTO "chat_flow" ("id", "name", "flowData", "deployed", "isPublic", "createdDate", "updatedDate", "type") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [`flow-${index}`, `Flow ${index}`, flowData(index), index % 2, 0, '2024-01-01 00:00:00', '2024-02-01 00:00:00', 'CHATFLOW']
        )
    }
    for (let index = 0; index < 2; index++) {
        db.all(
            `INSERT INTO "credential" ("id", "name", "credentialName", "encryptedData", "createdDate", "updatedDate") VALUES (?, ?, ?, ?, ?, ?)`,
            [`cred-${index}`, `Credential ${index}`, 'openAIApi', ciphertext(index), '2024-01-01 00:00:00', '2024-01-01 00:00:00']
        )
    }
    for (let index = 0; index < 40; index++) {
        db.all(
            `INSERT INTO "chat_message" ("id", "role", "chatflowid", "content", "createdDate", "chatType", "chatId") VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                `msg-${index}`,
                index % 2 === 0 ? 'userMessage' : 'apiMessage',
                `flow-${index % 7}`,
                `message body ${index}`,
                '2024-03-01 00:00:00',
                'INTERNAL',
                `chat-${index % 5}`
            ]
        )
    }

    await applyIdentityMigrations(db)
    return { directory, file, db }
}

export interface Legacy31Fixture extends Pre30Fixture {
    userId: string
    organizationId: string
    workspaceId: string
    ownerRoleId: string
    memberRoleId: string
    personalWorkspaceRoleId: string
    email: string
    password: string
    bcryptHash: string
}

export interface Legacy31Options {
    /** The real bcrypt hash to store on the user. Produced by the test with bcryptjs. */
    bcryptHash: string
    password: string
    /** Add a second account holding the stock `member` role, for the role-mapping assertions. */
    withMember?: boolean
    /** Store an unrecognisable string as the second account's hash, to exercise the §5 disabled path. */
    memberCredential?: string | null
}

/**
 * Fixture (b): a 3.1.x database mirroring the reference production one — 1 user, 1 organization,
 * 1 workspace, the 3 stock roles with their real permission lists, 25 chatflows, 3 credentials, and
 * all 57 migrations recorded.
 *
 * The role rows carry the exact permission strings the reference database holds, including the
 * `owner` role's two coarse grants `["organization","workspace"]` — which is what the §5 role
 * mapping keys on.
 */
export const createLegacy31Database = async (options: Legacy31Options): Promise<Legacy31Fixture> => {
    const directory = makeTempDirectory('legacy31')
    const file = path.join(directory, 'database.sqlite')
    const db = openTestDatabase(file)

    for (const ddl of LEGACY_IDENTITY_DDL) db.all(ddl)
    for (const ddl of RESOURCE_DDL_3_1) db.all(ddl)
    seedMigrations(db, REFERENCE_MIGRATIONS)

    const userId = '2a2be008-6e06-49af-9718-0de60b3b0a83'
    const memberId = '9d1f5c22-7e41-4a55-9d31-3f2b6c9a0e17'
    const organizationId = 'cfc63593-d3e0-4fa4-85d2-ff0aaf184def'
    const workspaceId = 'a554107b-4adb-4559-825d-8ca66104a486'
    const ownerRoleId = '11111111-1111-4111-8111-111111111111'
    const memberRoleId = '22222222-2222-4222-8222-222222222222'
    const personalWorkspaceRoleId = '33333333-3333-4333-8333-333333333333'
    const email = 'operator@example.org'

    // Permission lists exactly as the reference database holds them.
    const PERSONAL_WORKSPACE_GRANTS = [
        'chatflows:view',
        'chatflows:create',
        'chatflows:update',
        'chatflows:duplicate',
        'chatflows:delete',
        'chatflows:export',
        'chatflows:import',
        'chatflows:config',
        'chatflows:domains',
        'agentflows:view',
        'agentflows:create',
        'agentflows:update',
        'agentflows:duplicate',
        'agentflows:delete',
        'agentflows:export',
        'agentflows:import',
        'agentflows:config',
        'agentflows:domains',
        'tools:view',
        'tools:create',
        'tools:update',
        'tools:delete',
        'tools:export',
        'assistants:view',
        'assistants:create',
        'assistants:update',
        'assistants:delete',
        'credentials:view',
        'credentials:create',
        'credentials:update',
        'credentials:delete',
        'credentials:share',
        'variables:view',
        'variables:create',
        'variables:update',
        'variables:delete',
        'apikeys:view',
        'apikeys:create',
        'apikeys:update',
        'apikeys:delete',
        'documentStores:view',
        'documentStores:create',
        'documentStores:update',
        'documentStores:delete',
        'documentStores:add-loader',
        'documentStores:delete-loader',
        'documentStores:preview-process',
        'documentStores:upsert-config',
        'datasets:view',
        'datasets:create',
        'datasets:update',
        'datasets:delete',
        'evaluators:view',
        'evaluators:create',
        'evaluators:update',
        'evaluators:delete',
        'evaluations:view',
        'evaluations:create',
        'evaluations:update',
        'evaluations:delete',
        'evaluations:run',
        'templates:marketplace',
        'templates:custom',
        'templates:custom-delete',
        'templates:toolexport',
        'templates:flowexport',
        'templates:custom-share',
        'workspace:export',
        'workspace:import',
        'executions:view',
        'executions:delete'
    ]

    db.all(
        `INSERT INTO "role" ("id","organizationId","name","description","permissions","createdDate","updatedDate") VALUES (?,?,?,?,?,?,?)`,
        [
            ownerRoleId,
            null,
            'owner',
            'Has full control over the organization.',
            JSON.stringify(['organization', 'workspace']),
            '2024-06-01 00:00:00',
            '2024-06-01 00:00:00'
        ]
    )
    db.all(
        `INSERT INTO "role" ("id","organizationId","name","description","permissions","createdDate","updatedDate") VALUES (?,?,?,?,?,?,?)`,
        [
            memberRoleId,
            null,
            'member',
            'Has limited control over the organization.',
            JSON.stringify([]),
            '2024-06-01 00:00:00',
            '2024-06-01 00:00:00'
        ]
    )
    db.all(
        `INSERT INTO "role" ("id","organizationId","name","description","permissions","createdDate","updatedDate") VALUES (?,?,?,?,?,?,?)`,
        [
            personalWorkspaceRoleId,
            null,
            'personal workspace',
            'Has full control over the personal workspace',
            JSON.stringify(PERSONAL_WORKSPACE_GRANTS),
            '2024-06-01 00:00:00',
            '2024-06-01 00:00:00'
        ]
    )

    db.all(
        `INSERT INTO "user" ("id","name","email","credential","status","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?,?)`,
        [userId, 'Devin Blagbrough', email, options.bcryptHash, 'active', '2024-06-01 00:00:00', '2026-08-01 00:00:00', userId, userId]
    )
    db.all(`INSERT INTO "organization" ("id","name","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?)`, [
        organizationId,
        "Devin Blagbrough's Organization",
        '2024-06-01 00:00:00',
        '2024-06-01 00:00:00',
        userId,
        userId
    ])
    db.all(
        `INSERT INTO "organization_user" ("organizationId","userId","roleId","status","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?)`,
        [organizationId, userId, ownerRoleId, 'active', '2024-06-01 00:00:00', '2024-06-01 00:00:00', userId, userId]
    )
    db.all(
        `INSERT INTO "workspace" ("id","name","description","createdDate","updatedDate","organizationId","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?)`,
        [workspaceId, 'Default Workspace', null, '2024-06-01 00:00:00', '2024-06-01 00:00:00', organizationId, userId, userId]
    )
    db.all(
        `INSERT INTO "workspace_user" ("workspaceId","userId","roleId","status","lastLogin","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?,?)`,
        [
            workspaceId,
            userId,
            ownerRoleId,
            'active',
            '2026-08-06 17:21:17.507',
            '2024-06-01 00:00:00',
            '2024-06-01 00:00:00',
            userId,
            userId
        ]
    )

    if (options.withMember) {
        db.all(
            `INSERT INTO "user" ("id","name","email","credential","status","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?,?)`,
            [
                memberId,
                'Second Account',
                'member@example.org',
                options.memberCredential ?? null,
                'active',
                '2024-07-01 00:00:00',
                '2024-07-01 00:00:00',
                userId,
                userId
            ]
        )
        db.all(
            `INSERT INTO "organization_user" ("organizationId","userId","roleId","status","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?)`,
            [organizationId, memberId, memberRoleId, 'active', '2024-07-01 00:00:00', '2024-07-01 00:00:00', userId, userId]
        )
        db.all(
            `INSERT INTO "workspace_user" ("workspaceId","userId","roleId","status","lastLogin","createdDate","updatedDate","createdBy","updatedBy") VALUES (?,?,?,?,?,?,?,?,?)`,
            [workspaceId, memberId, personalWorkspaceRoleId, 'active', null, '2024-07-01 00:00:00', '2024-07-01 00:00:00', userId, userId]
        )
    }

    // 25 chatflows, 3 credentials — the reference database's counts.
    for (let index = 0; index < 25; index++) {
        db.all(
            `INSERT INTO "chat_flow" ("id","name","flowData","deployed","isPublic","createdDate","updatedDate","type","workspaceId") VALUES (?,?,?,?,?,?,?,?,?)`,
            [
                `flow-${index}`,
                `Flow ${index}`,
                flowData(index),
                index % 2,
                0,
                '2024-08-01 00:00:00',
                '2025-01-01 00:00:00',
                index % 5 === 0 ? 'AGENTFLOW' : 'CHATFLOW',
                workspaceId
            ]
        )
    }
    for (let index = 0; index < 3; index++) {
        db.all(
            `INSERT INTO "credential" ("id","name","credentialName","encryptedData","createdDate","updatedDate","workspaceId") VALUES (?,?,?,?,?,?,?)`,
            [
                `cred-${index}`,
                `Credential ${index}`,
                'openAIApi',
                ciphertext(index),
                '2024-08-01 00:00:00',
                '2024-08-01 00:00:00',
                workspaceId
            ]
        )
    }
    for (let index = 0; index < 120; index++) {
        db.all(`INSERT INTO "chat_message" ("id","role","chatflowid","content","createdDate","chatType","chatId") VALUES (?,?,?,?,?,?,?)`, [
            `msg-${index}`,
            index % 2 === 0 ? 'userMessage' : 'apiMessage',
            `flow-${index % 25}`,
            `message body ${index}`,
            '2025-02-01 00:00:00',
            'INTERNAL',
            `chat-${index % 9}`
        ])
    }
    db.all(`INSERT INTO "apikey" ("id","apiKey","apiSecret","keyName","createdDate","updatedDate","workspaceId") VALUES (?,?,?,?,?,?,?)`, [
        'key-0',
        'abc123',
        'secret123',
        'default key',
        '2024-08-01 00:00:00',
        '2024-08-01 00:00:00',
        workspaceId
    ])
    db.all(
        `INSERT INTO "document_store" ("id","name","description","status","updatedDate","createdDate","workspaceId") VALUES (?,?,?,?,?,?,?)`,
        ['store-0', 'Docs', 'a store', 'SYNC', '2024-08-01 00:00:00', '2024-08-01 00:00:00', workspaceId]
    )

    await applyIdentityMigrations(db)
    return {
        directory,
        file,
        db,
        userId,
        organizationId,
        workspaceId,
        ownerRoleId,
        memberRoleId,
        personalWorkspaceRoleId,
        email,
        password: options.password,
        bcryptHash: options.bcryptHash
    }
}

export const cleanup = (fixture: { db: TestDatabase; directory: string }): void => {
    try {
        fixture.db.close()
    } catch {
        /* already closed */
    }
    fs.rmSync(fixture.directory, { recursive: true, force: true })
}
