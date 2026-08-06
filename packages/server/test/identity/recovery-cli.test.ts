/**
 * SQLite-backed end-to-end tests for the recovery CLI (REQUIREMENTS-MIGRATION.md §7).
 *
 * These are PERMANENT, not scaffolding. §7's requirement — "Every identity operation must be
 * performable without a working UI and without a working login" — is a claim about behaviour against
 * a real database, and it cannot be demonstrated with mocks: a mocked repository would happily
 * report that a password was reset without a single row changing. So every test below runs the
 * actual migration chain into a real SQLite file, calls the real operation, and reads the result back
 * out of the database.
 *
 * The one thing the tests deliberately do NOT exercise through oclif is argument parsing. The
 * recovery OPERATIONS are exported as plain functions precisely so they can be driven directly here;
 * the oclif classes are thin wrappers whose only extra responsibility is prompting, and the prompt is
 * tested on its own at the bottom of this file.
 *
 * ── Running them ─────────────────────────────────────────────────────────────────────────────
 * `packages/server/jest.config.js` sets `roots: ['<rootDir>/src']` and maps `typeorm` to a decorator
 * mock, so `pnpm test` picks up neither this file nor the existing `totp-rfc6238.test.ts` next to it
 * — and could not use a real TypeORM if it did. Until that config grows a second project, run them
 * explicitly from `packages/server`:
 *
 *     npx jest --silent --rootDir . --roots test/identity --testRegex 'recovery-cli\.test\.ts$' \
 *       --moduleNameMapper '{"^uuid$":"<rootDir>/node_modules/uuid/dist/index.js",\
 *                            "^flowise-components$":"<rootDir>/__mocks__/flowise-components.ts"}' \
 *       --transform '{"^.+\\.tsx?$":["ts-jest",{"diagnostics":false}]}'
 *
 * The three overrides, and why each is needed rather than nice to have:
 *   - `uuid` v10 ships ESM only; the repo's own config already redirects it to the CJS build.
 *   - `flowise-components` is stubbed (`__mocks__/flowise-components.ts`) because `utils/logger`
 *     imports it at module load, which drags `jsdom` — and an ESM dependency Jest cannot parse —
 *     into a database test that has no use for a DOM.
 *   - `diagnostics: false` because `src/identity/services/AuditService.ts:248` currently has a
 *     pre-existing type error (`seqNo` is typed `string` but the SQLite driver returns a number)
 *     that is owned by the identity layer, not by this work. Type-correctness of the commands
 *     themselves is enforced separately by `tsc --noEmit`, which reports zero errors under
 *     `src/commands/`.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PassThrough } from 'stream'
import { DataSource, IsNull } from 'typeorm'
import { Assistant } from '../../src/database/entities/Assistant'
import { ChatFlow } from '../../src/database/entities/ChatFlow'
import { Credential } from '../../src/database/entities/Credential'
import {
    AuditEvent,
    LoginMethod,
    LoginMethodProvider,
    LoginMethodStatus,
    MemberStatus,
    MfaFactor,
    MfaFactorStatus,
    MfaFactorType,
    MfaRecoveryCode,
    Organization,
    OrganizationUser,
    Role,
    Session,
    SessionRevokeReason,
    Token,
    User,
    Workspace,
    WorkspaceUser
} from '../../src/database/entities/identity'
import { AuthFailureReason } from '../../src/database/entities/identity/AuditEvent'
import { sqliteMigrations } from '../../src/database/migrations/sqlite'
import { AuditService } from '../../src/identity/services/AuditService'
import { AuthService } from '../../src/identity/services/AuthService'
import { SessionService } from '../../src/identity/services/SessionService'
import { createAdminAccount } from '../../src/commands/admin/create'
import { listAdminAccounts } from '../../src/commands/admin/list'
import { resetAdminPassword } from '../../src/commands/admin/reset-password'
import { unlockAdminAccount } from '../../src/commands/admin/unlock'
import { runDoctor } from '../../src/commands/doctor'
import { disableMfaForAccount } from '../../src/commands/mfa/disable'
import { revokeAllSessions } from '../../src/commands/session/revoke-all'
import { disableSso } from '../../src/commands/sso/disable'
import { RecoveryActor, RecoveryAuditAction, lockoutStateFor, readSecret } from '../../src/commands/recovery-base'

jest.setTimeout(120000)

const STRONG_PASSWORD = 'Rec0very!Break-Glass'
const REPLACEMENT_PASSWORD = 'An0ther!Str0ng-One'

const ACTOR: RecoveryActor = { osUser: 'test-operator', hostname: 'test-host', pid: 4242 }

let directory: string
let dataSource: DataSource
let audit: AuditService

/** Everything the recovery CLI opens a connection over, plus the tables `doctor` inspects. */
const ENTITIES = [
    User,
    Organization,
    OrganizationUser,
    Workspace,
    WorkspaceUser,
    Role,
    LoginMethod,
    Session,
    Token,
    MfaFactor,
    MfaRecoveryCode,
    AuditEvent,
    ChatFlow,
    Credential,
    Assistant
]

const context = () => ({ dataSource, audit, actor: ACTOR })

/** Audit rows for one recovery action, newest first. The proof that break-glass left a trace. */
const auditRowsFor = async (action: string): Promise<AuditEvent[]> =>
    dataSource.getRepository(AuditEvent).find({ where: { action }, order: { seqNo: 'DESC' } })

beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-wiser-recovery-'))
    // Sessions cannot be issued without a pepper, and issuing one is how `admin:create` is proved to
    // have produced a WORKING account rather than merely a row.
    process.env.FLOWISE_SESSION_PEPPER = 'test-pepper-not-a-real-secret'

    dataSource = new DataSource({
        type: 'sqlite',
        database: path.join(directory, 'database.sqlite'),
        synchronize: false,
        migrationsRun: false,
        entities: ENTITIES,
        migrations: sqliteMigrations
    })
    await dataSource.initialize()
    await dataSource.runMigrations()

    audit = new AuditService({ dataSource })
})

afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy()
    fs.rmSync(directory, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('admin:create', () => {
    it('creates an account that can actually log in, with the requested role', async () => {
        const result = await createAdminAccount({
            ...context(),
            email: 'Ops@Example.COM',
            role: 'super-admin',
            password: STRONG_PASSWORD,
            name: 'Night Ops'
        })

        // The address is normalised on the way in, so `admin:reset-password --email OPS@…` finds it.
        expect(result.email).toBe('ops@example.com')
        expect(result.roleName).toBe('super-admin')

        const user = await dataSource.getRepository(User).findOneOrFail({ where: { id: result.userId } })
        expect(user.mustChangePassword).toBe(true) // MIGRATION §6
        expect(user.emailVerifiedDate).toBeTruthy()

        // The role is not just a string in the result — it is a real WorkspaceUser → Role edge.
        const assignment = await dataSource.getRepository(WorkspaceUser).findOneOrFail({ where: { userId: result.userId } })
        const role = await dataSource.getRepository(Role).findOneOrFail({ where: { id: assignment.roleId } })
        expect(role.name).toBe('super-admin')
        expect(role.isSystem).toBe(true)
        expect(JSON.parse(role.permissions).length).toBeGreaterThan(0)

        const membership = await dataSource.getRepository(OrganizationUser).findOneOrFail({ where: { userId: result.userId } })
        expect(membership.status).toBe(MemberStatus.ACTIVE)
        expect(membership.isOrgOwner).toBe(true)

        // WORKING, not merely present: the real login path accepts the password we just set.
        const login = await new AuthService({ dataSource }).login('ops@example.com', STRONG_PASSWORD)
        expect(login.ok).toBe(true)
        if (login.ok) {
            expect(login.payload.role).toBe('super-admin')
            expect(login.payload.mustChangePassword).toBe(true)
            expect(login.payload.permissions.length).toBeGreaterThan(0)
        }
    })

    it('refuses a weak password, creates nothing, and audits the refusal', async () => {
        const before = await dataSource.getRepository(User).count()

        await expect(
            createAdminAccount({ ...context(), email: 'weak@example.com', role: 'super-admin', password: 'password' })
        ).rejects.toThrow(/Password refused by policy/)

        // 'password' violates four rules at once, and the published-example denylist
        // (MIGRATION §4, "known-published password") is one of them.
        await expect(
            createAdminAccount({ ...context(), email: 'weak@example.com', role: 'super-admin', password: 'password' })
        ).rejects.toThrow(/published in this project/)

        expect(await dataSource.getRepository(User).count()).toBe(before)
        expect(await dataSource.getRepository(User).findOne({ where: { email: 'weak@example.com' } })).toBeNull()

        const failures = (await auditRowsFor(RecoveryAuditAction.ADMIN_CREATE)).filter((row) => row.outcome === 'failure')
        expect(failures[0].reason).toBe('weak_password')
    })

    it('refuses an unknown role rather than inventing one', async () => {
        await expect(
            createAdminAccount({ ...context(), email: 'typo@example.com', role: 'superadmin', password: STRONG_PASSWORD })
        ).rejects.toThrow(/Unknown role 'superadmin'/)

        expect(await dataSource.getRepository(Role).findOne({ where: { name: 'superadmin' } })).toBeNull()
        const failures = (await auditRowsFor(RecoveryAuditAction.ADMIN_CREATE)).filter((row) => row.reason === 'unknown_role')
        expect(failures.length).toBe(1)
    })

    it('accepts every one of the six roles and refuses a seventh', async () => {
        const created = await createAdminAccount({
            ...context(),
            email: 'reader@example.com',
            role: 'read-only',
            password: STRONG_PASSWORD
        })
        expect(created.roleName).toBe('read-only')
        // Not the org owner: that is reserved for super-admin (see create.ts).
        const membership = await dataSource.getRepository(OrganizationUser).findOneOrFail({ where: { userId: created.userId } })
        expect(membership.isOrgOwner).toBe(false)
    })

    it('refuses to overwrite an existing account', async () => {
        await expect(
            createAdminAccount({ ...context(), email: 'ops@example.com', role: 'super-admin', password: REPLACEMENT_PASSWORD })
        ).rejects.toThrow(/already exists/)
    })

    it('emitted a success audit row naming the role and the forced password change', async () => {
        const rows = (await auditRowsFor(RecoveryAuditAction.ADMIN_CREATE)).filter((row) => row.outcome === 'success')
        expect(rows.length).toBeGreaterThanOrEqual(1)
        const detail = JSON.parse(rows[rows.length - 1].detail as string)
        expect(detail.role).toBe('super-admin')
        // NOT `mustChangePassword`: the central redactor drops any key whose name contains
        // `password`, so the commands spell the flag in a way that survives into the trail.
        expect(detail.forcedChangeOnNextLogin).toBe(true)
        expect(detail.mustChangePassword).toBeUndefined()
        expect(detail.actor.osUser).toBe('test-operator')
        expect(rows[0].route).toBe('cli:flow-wiser')
        expect(rows[0].subjectType).toBe('system')
    })
})

describe('admin:reset-password', () => {
    it('replaces the hash, forces a change, and revokes every session', async () => {
        const user = await dataSource
            .getRepository(User)
            .findOneOrFail({ where: { email: 'ops@example.com' }, select: { id: true, credential: true } })
        const hashBefore = user.credential

        // Two more live sessions, so "revoked" is a number that could have been wrong. The login
        // in the previous test left one behind, which is exactly why the expectation is measured
        // rather than assumed.
        const sessions = new SessionService({ dataSource })
        await sessions.issue({ userId: user.id })
        await sessions.issue({ userId: user.id })
        const liveBefore = await dataSource.getRepository(Session).count({ where: { userId: user.id, revokedDate: IsNull() } })
        expect(liveBefore).toBeGreaterThanOrEqual(2)

        const result = await resetAdminPassword({ ...context(), email: 'ops@example.com', password: REPLACEMENT_PASSWORD })

        expect(result.hashChanged).toBe(true)
        expect(result.sessionsRevoked).toBe(liveBefore)

        const after = await dataSource
            .getRepository(User)
            .findOneOrFail({ where: { id: user.id }, select: { id: true, credential: true, mustChangePassword: true } })
        expect(after.credential).not.toBe(hashBefore)
        expect(after.credential).toMatch(/^\$2[aby]\$\d{2}\$/) // still bcrypt, at the current cost
        expect(after.mustChangePassword).toBe(true)

        const live = await dataSource.getRepository(Session).find({ where: { userId: user.id } })
        expect(live.every((session) => session.revokedDate !== null)).toBe(true)
        expect(live.every((session) => session.revokedReason === SessionRevokeReason.CREDENTIAL_CHANGED)).toBe(true)

        // The new password works and the old one does not.
        const auth = new AuthService({ dataSource })
        expect((await auth.login('ops@example.com', REPLACEMENT_PASSWORD)).ok).toBe(true)
        expect((await auth.login('ops@example.com', STRONG_PASSWORD)).ok).toBe(false)
    })

    it('refuses an unknown address and audits the refusal', async () => {
        await expect(resetAdminPassword({ ...context(), email: 'nobody@example.com', password: STRONG_PASSWORD })).rejects.toThrow(
            /No account with the address/
        )
        const failures = (await auditRowsFor(RecoveryAuditAction.ADMIN_RESET_PASSWORD)).filter((row) => row.outcome === 'failure')
        expect(failures[0].reason).toBe('unknown_user')
    })

    it('emitted an audit row that names neither the old nor the new hash', async () => {
        const rows = (await auditRowsFor(RecoveryAuditAction.ADMIN_RESET_PASSWORD)).filter((row) => row.outcome === 'success')
        expect(rows.length).toBe(1)
        const serialised = rows[0].detail as string
        expect(serialised).not.toMatch(/\$2[aby]\$/)
        expect(serialised).not.toContain(REPLACEMENT_PASSWORD)
        expect(JSON.parse(serialised).sessionsRevoked).toBeGreaterThanOrEqual(2)
    })
})

describe('session:revoke-all', () => {
    it('revokes every live session on the instance', async () => {
        const sessions = new SessionService({ dataSource })
        const ops = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'ops@example.com' } })
        const reader = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'reader@example.com' } })
        await sessions.issue({ userId: ops.id })
        await sessions.issue({ userId: reader.id })

        const liveBefore = await dataSource.getRepository(Session).count({ where: { revokedDate: IsNull() } })
        const result = await revokeAllSessions({ ...context() })

        expect(result.scope).toBe('instance')
        expect(result.revoked).toBe(liveBefore)
        expect(await dataSource.getRepository(Session).count({ where: { revokedDate: IsNull() } })).toBe(0)

        const rows = (await auditRowsFor(RecoveryAuditAction.SESSION_REVOKE_ALL)).filter((row) => row.outcome === 'success')
        expect(JSON.parse(rows[0].detail as string).scope).toBe('instance')
    })

    it('scopes to one account when given --email, and records `revoked` rather than `credential_changed`', async () => {
        const sessions = new SessionService({ dataSource })
        const ops = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'ops@example.com' } })
        const reader = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'reader@example.com' } })
        const opsSession = await sessions.issue({ userId: ops.id })
        const readerSession = await sessions.issue({ userId: reader.id })

        const result = await revokeAllSessions({ ...context(), email: 'ops@example.com' })
        expect(result.revoked).toBe(1)

        const revoked = await dataSource.getRepository(Session).findOneOrFail({ where: { id: opsSession.sessionId } })
        expect(revoked.revokedReason).toBe(SessionRevokeReason.REVOKED)
        const untouched = await dataSource.getRepository(Session).findOneOrFail({ where: { id: readerSession.sessionId } })
        expect(untouched.revokedDate).toBeNull()

        // Clean up so later assertions start from a known state.
        await revokeAllSessions({ ...context() })
    })
})

describe('admin:unlock', () => {
    it('clears a lockout derived from the audit trail, and says how many failures it discounted', async () => {
        const reader = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'reader@example.com' } })

        // Five consecutive failures is the documented lockout threshold (AuthService).
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await audit.loginFailure({
                email: reader.email,
                userId: reader.id,
                reason: AuthFailureReason.INCORRECT_CREDENTIAL
            })
        }

        const locked = await lockoutStateFor(dataSource, reader.id)
        expect(locked.locked).toBe(true)
        expect(locked.failures).toBe(5)

        const result = await unlockAdminAccount({ ...context(), email: reader.email })
        expect(result.before.locked).toBe(true)
        expect(result.clearedLockout).toBe(true)

        const afterwards = await lockoutStateFor(dataSource, reader.id)
        expect(afterwards.locked).toBe(false)
        expect(afterwards.failures).toBe(0)

        const rows = (await auditRowsFor(RecoveryAuditAction.ADMIN_UNLOCK)).filter((row) => row.outcome === 'success')
        expect(JSON.parse(rows[0].detail as string).clearedFailures).toBe(5)
    })

    it('reactivates an inactive membership, which produces the same symptom as a lockout', async () => {
        const reader = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'reader@example.com' } })
        const membership = await dataSource.getRepository(OrganizationUser).findOneOrFail({ where: { userId: reader.id } })
        await dataSource
            .getRepository(OrganizationUser)
            .update({ organizationId: membership.organizationId, userId: reader.id }, { status: MemberStatus.INACTIVE })

        const result = await unlockAdminAccount({ ...context(), email: reader.email })
        expect(result.reactivatedMemberships).toEqual([membership.organizationId])

        const after = await dataSource.getRepository(OrganizationUser).findOneOrFail({ where: { userId: reader.id } })
        expect(after.status).toBe(MemberStatus.ACTIVE)
    })
})

describe('mfa:disable', () => {
    it('removes every factor, burns the unused recovery codes, and keeps the history in the trail', async () => {
        const reader = await dataSource.getRepository(User).findOneOrFail({ where: { email: 'reader@example.com' } })

        await dataSource.getRepository(MfaFactor).save(
            dataSource.getRepository(MfaFactor).create({
                userId: reader.id,
                type: MfaFactorType.TOTP,
                label: 'Phone that fell in the canal',
                secret: 'not-a-real-seed',
                status: MfaFactorStatus.CONFIRMED,
                confirmedDate: new Date()
            })
        )
        const batchId = '11111111-2222-3333-4444-555555555555'
        for (let index = 0; index < 3; index += 1) {
            await dataSource
                .getRepository(MfaRecoveryCode)
                .save(dataSource.getRepository(MfaRecoveryCode).create({ userId: reader.id, batchId, codeHash: `hash-${index}` }))
        }

        const result = await disableMfaForAccount({ ...context(), email: reader.email })

        expect(result.factorsRemoved).toBe(1)
        expect(result.confirmedFactorsRemoved).toBe(1)
        expect(result.recoveryCodesBurned).toBe(3)

        expect(await dataSource.getRepository(MfaFactor).count({ where: { userId: reader.id } })).toBe(0)
        const codes = await dataSource.getRepository(MfaRecoveryCode).find({ where: { userId: reader.id } })
        expect(codes.every((code) => code.consumedDate !== null)).toBe(true)

        const rows = (await auditRowsFor(RecoveryAuditAction.MFA_DISABLE)).filter((row) => row.outcome === 'success')
        const detail = JSON.parse(rows[0].detail as string)
        expect(detail.unusedCodesBurned).toBe(3)
        expect(detail.factors[0].label).toBe('Phone that fell in the canal')
        expect(detail.factors[0].confirmedAt).toBeTruthy()
        // The seed is never recorded (§9).
        expect(rows[0].detail as string).not.toContain('not-a-real-seed')
    })
})

describe('sso:disable', () => {
    it('disables every provider, leaves the configuration intact, and reports who can still log in', async () => {
        const organization = await dataSource.getRepository(Organization).findOneOrFail({ where: {}, order: { createdDate: 'ASC' } })
        const saved = await dataSource.getRepository(LoginMethod).save(
            dataSource.getRepository(LoginMethod).create({
                organizationId: organization.id,
                name: LoginMethodProvider.AZURE,
                status: LoginMethodStatus.ENABLE,
                config: '{"clientId":"abc"}',
                clientSecret: 'encrypted-secret-blob'
            })
        )

        const result = await disableSso({ ...context() })

        expect(result.disabled.map((method) => method.provider)).toEqual([LoginMethodProvider.AZURE])
        expect(result.accountsWithLocalPassword).toBeGreaterThan(0)

        const after = await dataSource
            .getRepository(LoginMethod)
            .findOneOrFail({ where: { id: saved.id }, select: { id: true, status: true, config: true, clientSecret: true } })
        expect(after.status).toBe(LoginMethodStatus.DISABLE)
        // The whole point: re-enabling must not require re-entering an OAuth client secret at 03:00.
        expect(after.config).toBe('{"clientId":"abc"}')
        expect(after.clientSecret).toBe('encrypted-secret-blob')

        const rows = (await auditRowsFor(RecoveryAuditAction.SSO_DISABLE)).filter((row) => row.outcome === 'success')
        expect(rows[0].detail as string).not.toContain('encrypted-secret-blob')
    })

    it('refuses an unknown provider', async () => {
        await expect(disableSso({ ...context(), provider: 'okta' })).rejects.toThrow(/Unknown SSO provider/)
    })
})

describe('admin:list', () => {
    it('reports the state that explains why an account can or cannot log in, and audits the read', async () => {
        const rows = await listAdminAccounts({ ...context() })
        const ops = rows.find((row) => row.email === 'ops@example.com')

        expect(ops).toBeDefined()
        expect(ops?.hasPassword).toBe(true)
        expect(ops?.mustChangePassword).toBe(true)
        expect(ops?.assignments[0].roleName).toBe('super-admin')
        expect(ops?.memberships[0].isOrgOwner).toBe(true)
        expect(ops?.lockout.locked).toBe(false)

        const audited = await auditRowsFor(RecoveryAuditAction.ADMIN_LIST)
        expect(audited.length).toBeGreaterThanOrEqual(1)
        // The count, never the addresses — the audit table must not become a second copy of the user list.
        expect(audited[0].detail as string).not.toContain('ops@example.com')
        expect(JSON.parse(audited[0].detail as string).accounts).toBe(rows.length)
    })

    it('marks an account with no workspace as unable to log in', async () => {
        const stranded = await dataSource
            .getRepository(User)
            .save(dataSource.getRepository(User).create({ email: 'stranded@example.com', credential: null }))

        const rows = await listAdminAccounts({ ...context() })
        const row = rows.find((entry) => entry.email === 'stranded@example.com')
        expect(row?.assignments).toEqual([])
        expect(row?.hasPassword).toBe(false)

        await dataSource.getRepository(User).delete({ id: stranded.id })
    })
})

describe('doctor', () => {
    const ORPHAN_FLOW_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
    const HEALTHY_FLOW_ID = 'aaaaaaaa-0000-4000-8000-000000000002'
    const MISSING_CREDENTIAL_ID = 'bbbbbbbb-0000-4000-8000-0000000000ff'
    const OTHER_ORGANIZATION_ID = 'cccccccc-0000-4000-8000-000000000009'

    beforeAll(async () => {
        // MIGRATION §3a's denormalisation ("organizationId written directly onto every tenant-scoped
        // resource row") has no migration yet, so the column is added here to stand in for it. This
        // is exactly the shape doctor has to police once that migration lands — and the check below
        // also proves doctor reports the column's ABSENCE rather than silently passing.
        const runner = dataSource.createQueryRunner()
        await runner.query('ALTER TABLE "chat_flow" ADD COLUMN "organizationId" varchar')
        // `chat_flow` still declares FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id"), and
        // the `workspace` table no longer exists after the Apache-2.0 cut-over. SQLite enforces
        // foreign keys at INSERT time, so every write to chat_flow fails with
        // `no such table: main.workspace` on a fresh Flow-Wiser database. That is a real defect in
        // the schema cut-over, NOT in the recovery CLI — and `doctor` now reports it as
        // 'Schema — foreign keys'. It is suppressed here only so the fixture can be built.
        await runner.query('PRAGMA foreign_keys = OFF')
        await runner.release()

        const workspace = await dataSource.getRepository(Workspace).findOneOrFail({ where: {}, order: { createdDate: 'ASC' } })

        // Inserted with raw SQL, not through the entity: the `Credential` ENTITY declares a
        // non-nullable `workspaceId`, but the Apache-2.0 migration chain never creates that column —
        // it was added by the commercially-licensed migrations the cut-over unregistered. So on a
        // fresh Flow-Wiser database the entity and the table disagree, and only the table is real.
        // (`doctor` reports exactly this, which is the point of the assertions below.)
        const REAL_CREDENTIAL_ID = 'dddddddd-0000-4000-8000-00000000000a'
        await dataSource.query(
            'INSERT INTO "credential" ("id", "name", "credentialName", "encryptedData", "createdDate", "updatedDate") ' +
                "VALUES (?, 'openai', 'openAIApi', 'x', datetime('now'), datetime('now'))",
            [REAL_CREDENTIAL_ID]
        )

        // A healthy flow: correct tenant key, and every credential it names exists.
        await dataSource.getRepository(ChatFlow).save(
            dataSource.getRepository(ChatFlow).create({
                id: HEALTHY_FLOW_ID,
                name: 'Healthy flow',
                workspaceId: workspace.id,
                flowData: JSON.stringify({
                    nodes: [{ id: 'n1', data: { credential: REAL_CREDENTIAL_ID, inputs: {} } }]
                })
            })
        )
        await dataSource.query('UPDATE "chat_flow" SET "organizationId" = ? WHERE "id" = ?', [workspace.organizationId, HEALTHY_FLOW_ID])

        // A DELIBERATELY BROKEN flow: its tenant key names an organization its workspace does not
        // belong to, and it references a credential that was deleted out from under it — the two
        // defects the requirement names, in one row.
        await dataSource.getRepository(ChatFlow).save(
            dataSource.getRepository(ChatFlow).create({
                id: ORPHAN_FLOW_ID,
                name: 'Support chatbot',
                workspaceId: workspace.id,
                flowData: JSON.stringify({
                    nodes: [
                        { id: 'n1', data: { credential: MISSING_CREDENTIAL_ID, inputs: {} } },
                        { id: 'n2', data: { inputs: { FLOWISE_CREDENTIAL_ID: MISSING_CREDENTIAL_ID } } },
                        { id: 'n3', data: { inputs: { model: { FLOWISE_CREDENTIAL_ID: MISSING_CREDENTIAL_ID } } } }
                    ]
                }),
                // A fourth reference, in the provider-config shape rather than the node shape.
                speechToText: JSON.stringify({ openAIWhisper: { credentialId: MISSING_CREDENTIAL_ID, status: true } })
            })
        )
        await dataSource.query('UPDATE "chat_flow" SET "organizationId" = ? WHERE "id" = ?', [OTHER_ORGANIZATION_ID, ORPHAN_FLOW_ID])
    })

    it('detects the deliberately orphaned tenant key and names the row', async () => {
        const report = await runDoctor({ ...context(), target: 'test' })
        const check = report.checks.find((entry) => entry.name === 'Tenancy — denormalised tenant keys')

        expect(check?.status).toBe('fail')
        expect(check?.summary).toMatch(/1 row\(s\) carry a tenant key that disagrees/)
        expect(check?.details.join('\n')).toContain(ORPHAN_FLOW_ID)
        expect(check?.details.join('\n')).toContain(OTHER_ORGANIZATION_ID)
        // The healthy flow is not flagged.
        expect(check?.details.join('\n')).not.toContain(HEALTHY_FLOW_ID)
        // And the tables that carry NO tenant key at all are reported, not silently passed —
        // "no column, no mismatches, therefore healthy" is the false clean bill of health a
        // diagnostic must never give. On a fresh Flow-Wiser database nine of the ten tenant-scoped
        // tables have lost their workspaceId with the commercial migrations, and doctor says so.
        expect(check?.details.join('\n')).toContain('tables without a workspaceId column')
        expect(check?.details.join('\n')).toContain('credential')
    })

    it('detects the deliberately broken credential reference, and counts every shape of it', async () => {
        const report = await runDoctor({ ...context(), target: 'test' })
        const check = report.checks.find((entry) => entry.name === 'Flows — credential references')

        expect(check?.status).toBe('fail')
        // Four references in one flow: node.credential, inputs.FLOWISE_CREDENTIAL_ID, a nested
        // config object, and the speechToText provider blob.
        expect(check?.summary).toMatch(/1 deleted credential\(s\) are still referenced: 4 reference\(s\) across 1 flow\(s\)/)
        expect(check?.details.join('\n')).toContain(MISSING_CREDENTIAL_ID)
        expect(check?.details.join('\n')).toContain('Support chatbot')
    })

    it('reports the schema fingerprint, the identity tables and the population', async () => {
        const report = await runDoctor({ ...context(), target: 'test' })
        const byName = new Map(report.checks.map((check) => [check.name, check]))

        const migrations = byName.get('Schema — applied migrations')
        expect(migrations?.status).toBe('ok')
        expect(migrations?.summary).toMatch(/migration\(s\) applied, including \d+ identity one\(s\)/)

        expect(byName.get('Schema — identity tables')?.status).toBe('ok')

        // The dangling `chat_flow -> workspace` foreign key left behind by the cut-over: every
        // INSERT into chat_flow fails at run time while every SELECT succeeds.
        const foreignKeys = byName.get('Schema — foreign keys')
        expect(foreignKeys?.status).toBe('fail')
        expect(foreignKeys?.details.join('\n')).toContain('chat_flow')
        expect(foreignKeys?.details.join('\n')).toContain('workspace (table does not exist)')

        // WARN, not OK: the accounts above were created by `admin:create`, which seeds only the
        // roles it is asked for. doctor noticing that three of the six §3 roles are absent is the
        // check doing its job.
        const population = byName.get('Identity — population')
        expect(population?.status).toBe('warn')
        expect(population?.summary).toMatch(/of the six system roles are not seeded/)
        expect(population?.details.join('\n')).toMatch(/users\s+\d+/)
        expect(population?.details.join('\n')).toMatch(/Missing roles: .*super-user/)

        expect(byName.get('Identity — who can log in')?.status).toBe('ok')
        expect(byName.get('Identity — password state and MFA exemptions')?.details.join('\n')).toMatch(
            /accounts with mustChangePassword\s+\d/
        )
    })

    it('reports MFA-exempt accounts as a standing risk (MIGRATION §4)', async () => {
        const report = await runDoctor({
            ...context(),
            target: 'test',
            env: { ...process.env, IDENTITY_BOOTSTRAP_EMAILS: 'ops@example.com' }
        })
        const check = report.checks.find((entry) => entry.name === 'Identity — password state and MFA exemptions')
        expect(check?.status).toBe('warn')
        expect(check?.summary).toMatch(/1 account\(s\) are permanently exempt from MFA enforcement/)
        expect(check?.details.join('\n')).toContain('mfa-exempt: ops@example.com')
    })

    it('exits with failures counted, and audits the run', async () => {
        const report = await runDoctor({ ...context(), target: 'test' })
        expect(report.failures).toBeGreaterThanOrEqual(3)

        const rows = await auditRowsFor(RecoveryAuditAction.DOCTOR)
        expect(rows.length).toBeGreaterThanOrEqual(1)
        const detail = JSON.parse(rows[0].detail as string)
        expect(detail.failures).toBeGreaterThanOrEqual(3)
        expect(detail.checks.map((check: { name: string }) => check.name)).toContain('Tenancy — denormalised tenant keys')
    })
})

describe('the audit trail', () => {
    it('carries a row for every one of the eight recovery commands', async () => {
        // sso:disable and doctor were exercised above; this asserts the whole set in one place so a
        // new command cannot be added without an audit write (§7).
        const actions = [
            RecoveryAuditAction.ADMIN_CREATE,
            RecoveryAuditAction.ADMIN_RESET_PASSWORD,
            RecoveryAuditAction.ADMIN_LIST,
            RecoveryAuditAction.ADMIN_UNLOCK,
            RecoveryAuditAction.MFA_DISABLE,
            RecoveryAuditAction.SSO_DISABLE,
            RecoveryAuditAction.SESSION_REVOKE_ALL,
            RecoveryAuditAction.DOCTOR
        ]

        for (const action of actions) {
            const rows = await auditRowsFor(action)
            expect(rows.length).toBeGreaterThanOrEqual(1)
            expect(rows[0].subjectType).toBe('system')
            expect(rows[0].subjectLabel).toBe('recovery-cli')
            expect(rows[0].route).toBe('cli:flow-wiser')
            expect(JSON.parse(rows[0].detail as string).actor).toEqual(ACTOR)
        }
    })

    it('never contains a password, and the trail is append-only', async () => {
        const everything = await dataSource.getRepository(AuditEvent).find()
        const serialised = JSON.stringify(everything)
        expect(serialised).not.toContain(STRONG_PASSWORD)
        expect(serialised).not.toContain(REPLACEMENT_PASSWORD)
        // seqNo is a total order, which is what makes a missing row detectable.
        const sequence = everything.map((event) => Number(event.seqNo)).sort((a, b) => a - b)
        expect(sequence[sequence.length - 1] - sequence[0] + 1).toBe(sequence.length)
    })
})

describe('the password prompt', () => {
    const drive = async (typed: string): Promise<{ value: string; echoed: string }> => {
        const input = new PassThrough() as PassThrough & { isTTY?: boolean }
        const chunks: string[] = []
        const output = new PassThrough()
        output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))

        const pending = readSecret('Password: ', { input, output })
        input.write(typed)
        input.write('\n')
        const value = await pending
        return { value, echoed: chunks.join('') }
    }

    it('returns what was typed without echoing any of it', async () => {
        const { value, echoed } = await drive('S3cret-Passphrase!')
        expect(value).toBe('S3cret-Passphrase!')
        // The prompt and a newline, and nothing else. Not even a mask: the length of a passphrase is
        // a meaningful fraction of its entropy.
        expect(echoed).toBe('Password: \n')
        expect(echoed).not.toContain('S3cret')
        expect(echoed).not.toContain('*')
    })

    it('honours backspace, so an invisible typo is correctable', async () => {
        const { value } = await drive('Secretx\u007f')
        expect(value).toBe('Secret')
    })

    it('treats ^C as a cancellation and never as an empty password', async () => {
        const input = new PassThrough() as PassThrough & { isTTY?: boolean }
        const pending = readSecret('Password: ', { input, output: new PassThrough() })
        input.write('\u0003')
        await expect(pending).rejects.toThrow(/Cancelled/)
    })

    it('swallows a whole ANSI escape sequence rather than typing it into the password', async () => {
        // What an up-arrow actually sends in raw mode. Without the state machine in `readSecret`,
        // `[` and `A` would silently become part of the password.
        const { value } = await drive('ab\u001b[Acd')
        expect(value).toBe('abcd')
    })

    it('honours ^U as kill-line', async () => {
        const { value } = await drive('wrong-entirely\u0015Right1!')
        expect(value).toBe('Right1!')
    })
})
