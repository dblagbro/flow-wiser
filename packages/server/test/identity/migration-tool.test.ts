/**
 * End-to-end verification of the identity migration tool against two REAL synthetic databases —
 * REQUIREMENTS-MIGRATION.md §9 acceptance, points 1 through 5.
 *
 * These are not unit tests with mocked queries. Each one builds an actual SQLite database from DDL
 * copied out of a production Flowise 3.1.4 instance, runs the SHIPPING identity migrations against
 * it, then runs the tool and inspects what is in the file afterwards. A migration tool tested
 * against a mock of a database proves only that the mock agrees with the tool.
 *
 * §9's acceptance list, and where each point is checked:
 *   1. pre-3.0 upgrades and preserves every flow, credential and message  → "pre-3.0"
 *   2. 3.1.x carries its user across, able to log in, forced to change    → "3.1.x", "the password"
 *   3. non-user counts and hashes identical on BOTH paths                 → both blocks
 *   4. --dry-run predicts both outcomes without writing                   → "dry run"
 *   5. a deliberately failed upgrade restores cleanly from the backup     → "failure and rollback"
 */
import bcrypt from 'bcryptjs'
import * as fs from 'fs'
import { verify } from '../../src/identity/crypto/passwords'
import { captureFingerprint, compareFingerprints, recaptureFingerprint } from '../../src/database/migration-tool/fingerprint'
import { detect, Era } from '../../src/database/migration-tool/detect'
import { listTables } from '../../src/database/migration-tool/db'
import { migrate, MigrationAbort } from '../../src/database/migration-tool/migrate'
import { mapLegacyRole } from '../../src/database/migration-tool/roleMapping'
import { restoreSqliteBackup } from '../../src/database/migration-tool/rollback'
import {
    cleanup,
    createLegacy31Database,
    createPre30Database,
    Legacy31Fixture,
    openTestDatabase,
    Pre30Fixture,
    TestDatabase
} from './support/sqliteFixtures'

jest.setTimeout(120_000)

/** The password the fixture's bcrypt hash is produced from. Must satisfy the §F-11 policy floor. */
const PASSWORD = 'Correct-Horse-9!'

/**
 * The six §3 role names with a stub grant list.
 *
 * Injected rather than imported: `BootstrapService.systemRolePermissions` is the production default,
 * but importing that module pulls `utils/logger` in, which constructs winston transports and creates
 * a log directory as a side effect of being loaded, and depends on `flowise-components`. The grant
 * CONTENTS are that module's business and are tested with it; what this suite is proving is that
 * the migration resolves the right ROLE for each account.
 */
const stubRolePermissions = (name: string): string[] => [`stub:${name}`]

/** Fingerprint EVERY table, identity ones included — used to prove a dry run wrote nothing at all. */
const fingerprintEverything = async (db: TestDatabase) => captureFingerprint(db, { tables: await listTables(db) })

const rowsOf = (db: TestDatabase, sql: string, params: unknown[] = []) => db.all(sql, params)
const oneOf = (db: TestDatabase, sql: string, params: unknown[] = []) => db.all(sql, params)[0]
const countOf = (db: TestDatabase, table: string): number => Number(db.all(`SELECT COUNT(*) AS c FROM "${table}"`)[0].c)

describe('migration tool — era detection (§1)', () => {
    let pre30: Pre30Fixture
    let legacy: Legacy31Fixture

    beforeAll(async () => {
        pre30 = await createPre30Database()
        legacy = await createLegacy31Database({ bcryptHash: bcrypt.hashSync(PASSWORD, 10), password: PASSWORD, withMember: true })
    })
    afterAll(() => {
        cleanup(pre30)
        cleanup(legacy)
    })

    it('reads a pre-3.0 database as pre-3.0, from the schema and not from a version string', async () => {
        const report = await detect(pre30.db)
        expect(report.era).toBe(Era.PRE_3_0)
        // The ledger stops before AddAuthTables, which is what a real pre-3.0 database looks like.
        expect(report.appliedMigrationCount).toBe(27)
        expect(report.legacyIdentityMigrationsApplied).toEqual([])
        expect(report.legacyIdentityTables.filter((entry) => entry.present)).toEqual([])
        // Its data is still there and still discovered.
        expect(report.nonUserTables.find((entry) => entry.table === 'chat_flow')?.rows).toBe(7)
        expect(report.nonUserTables.find((entry) => entry.table === 'chat_message')?.rows).toBe(40)
        // Nothing is workspace-scoped yet — workspaceId does not exist at this point in history.
        expect(report.workspaceScopedTables).toEqual([])
    })

    it('reads a 3.1.x database as 3.0+, with the reference ledger of 57 and all nine old tables', async () => {
        const report = await detect(legacy.db)
        expect(report.era).toBe(Era.LEGACY_IDENTITY)
        expect(report.appliedMigrationCount).toBe(57)
        expect(report.legacyIdentityMigrationsApplied).toHaveLength(11)
        expect(report.legacyIdentityTables.filter((entry) => entry.present).map((entry) => entry.table)).toEqual([
            'user',
            'organization',
            'organization_user',
            'workspace',
            'workspace_user',
            'role',
            'login_method',
            'login_activity',
            'workspace_shared'
        ])
        expect(report.legacyIdentityTables.find((entry) => entry.table === 'user')?.rows).toBe(2)
        expect(report.legacyIdentityTables.find((entry) => entry.table === 'role')?.rows).toBe(3)
        expect(report.nonUserTables.find((entry) => entry.table === 'chat_flow')?.rows).toBe(25)
        expect(report.nonUserTables.find((entry) => entry.table === 'credential')?.rows).toBe(3)
        expect(report.workspaceScopedTables.sort()).toEqual(['apikey', 'chat_flow', 'credential', 'document_store'])
        expect(report.tenantStampedTables).toEqual([])
    })

    it('reports a ledger that disagrees with the schema instead of trusting it', async () => {
        // A record with no table — what `migration:revert` or a schema-only restore leaves behind.
        pre30.db.all(`INSERT INTO "migrations" ("timestamp", "name") VALUES (?, ?)`, [1720230151482, 'AddAuthTables1720230151482'])
        const report = await detect(pre30.db)
        expect(report.era).toBe(Era.PRE_3_0)
        expect(report.warnings.join('\n')).toContain('but none of the tables they create exist')
        pre30.db.all(`DELETE FROM "migrations" WHERE "name" = ?`, ['AddAuthTables1720230151482'])
    })
})

describe('migration tool — dry run is the default and writes nothing (§8.2, §9.4)', () => {
    let legacy: Legacy31Fixture
    beforeAll(async () => {
        legacy = await createLegacy31Database({ bcryptHash: bcrypt.hashSync(PASSWORD, 10), password: PASSWORD, withMember: true })
    })
    afterAll(() => cleanup(legacy))

    it('changes not one byte of any table, identity tables included', async () => {
        const before = await fingerprintEverything(legacy.db)
        const result = await migrate(legacy.db, { rolePermissions: stubRolePermissions as any })
        expect(result.dryRun).toBe(true)
        const after = await recaptureFingerprint(legacy.db, before)
        expect(compareFingerprints(before, after).identical).toBe(true)
        expect(countOf(legacy.db, 'identity_user')).toBe(0)
        expect(countOf(legacy.db, 'identity_audit_event')).toBe(0)
    })

    it('predicts exactly what the applied run then does', async () => {
        const preview = await migrate(legacy.db, { rolePermissions: stubRolePermissions as any })
        const applied = await migrate(legacy.db, {
            dryRun: false,
            allowUnsafeNoBackup: true,
            rolePermissions: stubRolePermissions as any
        })

        expect(preview.plan.users.map((user) => [user.email, user.credential, user.mustChangePassword])).toEqual(
            applied.plan.users.map((user) => [user.email, user.credential, user.mustChangePassword])
        )
        expect(preview.plan.workspaceMembers.map((member) => [member.userId, member.target])).toEqual(
            applied.plan.workspaceMembers.map((member) => [member.userId, member.target])
        )
        expect(preview.plan.tenantStamps.map((stamp) => [stamp.table, stamp.rowsToStamp])).toEqual(
            applied.plan.tenantStamps.map((stamp) => [stamp.table, stamp.rowsToStamp])
        )
        // The prediction is legible, not just structurally equal.
        expect(preview.report).toContain('DRY RUN — nothing was written')
        expect(preview.report).toContain('-> super-admin')
        expect(applied.written['identity_user']).toBe(preview.plan.users.length)
    })
})

describe('migration tool — pre-3.0 (§9.1, §9.3)', () => {
    let pre30: Pre30Fixture
    beforeAll(async () => {
        pre30 = await createPre30Database()
    })
    afterAll(() => cleanup(pre30))

    it('preserves every flow, credential and message and creates no accounts', async () => {
        const before = await captureFingerprint(pre30.db)
        const result = await migrate(pre30.db, {
            dryRun: false,
            backup: { directory: `${pre30.directory}/backups` },
            rolePermissions: stubRolePermissions as any
        })

        expect(result.comparison?.identical).toBe(true)
        expect(result.comparison?.verified.find((entry) => entry.table === 'chat_flow')?.rows).toBe(7)
        expect(result.comparison?.verified.find((entry) => entry.table === 'credential')?.rows).toBe(2)
        expect(result.comparison?.verified.find((entry) => entry.table === 'chat_message')?.rows).toBe(40)

        // Independently of the tool's own report: re-hash from scratch and compare.
        const after = await recaptureFingerprint(pre30.db, before)
        expect(compareFingerprints(before, after).identical).toBe(true)

        // Nothing to carry across.
        expect(countOf(pre30.db, 'identity_user')).toBe(0)
        expect(countOf(pre30.db, 'identity_organization')).toBe(0)
        expect(result.plan.warnings.join('\n')).toContain('there are no accounts to carry across')
    })

    it('takes a verified backup before touching anything (§8.1)', async () => {
        const fixture = await createPre30Database()
        try {
            const result = await migrate(fixture.db, {
                dryRun: false,
                backup: { directory: `${fixture.directory}/backups` },
                rolePermissions: stubRolePermissions as any
            })
            expect(result.backup).not.toBeNull()
            expect(fs.existsSync(result.backup!.path)).toBe(true)
            expect(result.backup!.method).toBe('vacuum-into')
            expect(result.backup!.verification).toEqual(
                expect.arrayContaining([expect.stringContaining('integrity_check = ok'), expect.stringContaining('row counts match')])
            )
        } finally {
            cleanup(fixture)
        }
    })
})

describe('migration tool — 3.1.x carries the account across (§5, §6, §9.2, §9.3)', () => {
    let legacy: Legacy31Fixture
    let before: Awaited<ReturnType<typeof captureFingerprint>>
    let applied: Awaited<ReturnType<typeof migrate>>

    beforeAll(async () => {
        legacy = await createLegacy31Database({ bcryptHash: bcrypt.hashSync(PASSWORD, 10), password: PASSWORD, withMember: true })
        before = await captureFingerprint(legacy.db)
        applied = await migrate(legacy.db, {
            dryRun: false,
            backup: { directory: `${legacy.directory}/backups` },
            rolePermissions: stubRolePermissions as any
        })
    })
    afterAll(() => cleanup(legacy))

    it('leaves non-user data byte-identical (§2)', async () => {
        expect(applied.comparison?.identical).toBe(true)
        const after = await recaptureFingerprint(legacy.db, before)
        const comparison = compareFingerprints(before, after)
        expect(comparison.mismatches).toEqual([])
        expect(comparison.verified.find((entry) => entry.table === 'chat_flow')).toEqual({
            table: 'chat_flow',
            rows: 25,
            hash: before.tables.find((entry) => entry.table === 'chat_flow')!.hash
        })
        expect(comparison.verified.find((entry) => entry.table === 'credential')?.rows).toBe(3)
        expect(comparison.verified.find((entry) => entry.table === 'chat_message')?.rows).toBe(120)
    })

    it('does not re-encrypt a single credential (§2)', () => {
        const credentials = rowsOf(legacy.db, `SELECT "id", "encryptedData" FROM "credential" ORDER BY "id"`)
        expect(credentials).toHaveLength(3)
        for (const credential of credentials) {
            expect(String(credential.encryptedData)).toMatch(/^[A-Za-z0-9+/=]+$/)
            expect(String(credential.encryptedData)).toBe(
                Buffer.from(`U2FsdGVkX1+ciphertext-${String(credential.id).split('-')[1]}-`.repeat(4)).toString('base64')
            )
        }
    })

    it('carries the bcrypt hash across verbatim, so THE ORIGINAL PASSWORD STILL VERIFIES (§5)', async () => {
        const user = oneOf(legacy.db, `SELECT * FROM "identity_user" WHERE "email" = ?`, [legacy.email])
        expect(user).toBeDefined()
        expect(user.credential).toBe(legacy.bcryptHash)

        // The load-bearing assertion of the whole migration: the operator is not locked out.
        await expect(verify(PASSWORD, user.credential)).resolves.toBe(true)
        await expect(verify('not-the-password', user.credential)).resolves.toBe(false)
    })

    it('forces a password change on the migrated password account, and only on it (§6)', () => {
        const owner = oneOf(legacy.db, `SELECT * FROM "identity_user" WHERE "email" = ?`, [legacy.email])
        expect(Number(owner.mustChangePassword)).toBe(1)
        expect(Number(owner.isSSO)).toBe(0)

        // The second account has no local password, so §6 explicitly does NOT flag it: "forcing a
        // local password change on an SSO-only account is meaningless".
        const member = oneOf(legacy.db, `SELECT * FROM "identity_user" WHERE "email" = ?`, ['member@example.org'])
        expect(member.credential).toBeNull()
        expect(Number(member.mustChangePassword)).toBe(0)
    })

    it('preserves identifiers, so every workspaceId already on chat_flow still resolves', () => {
        expect(oneOf(legacy.db, `SELECT "id" FROM "identity_user" WHERE "email" = ?`, [legacy.email]).id).toBe(legacy.userId)
        expect(oneOf(legacy.db, `SELECT "id" FROM "identity_workspace"`).id).toBe(legacy.workspaceId)
        expect(oneOf(legacy.db, `SELECT "id" FROM "identity_organization"`).id).toBe(legacy.organizationId)
        const orphans = oneOf(
            legacy.db,
            `SELECT COUNT(*) AS c FROM "chat_flow" f WHERE NOT EXISTS (SELECT 1 FROM "identity_workspace" w WHERE w."id" = f."workspaceId")`
        )
        expect(Number(orphans.c)).toBe(0)
    })

    it('maps the org owner to super-admin and the member by its grants (§3, §5)', () => {
        const assignments = rowsOf(
            legacy.db,
            `SELECT wu."userId" AS "userId", r."name" AS "role" FROM "identity_workspace_user" wu JOIN "identity_role" r ON r."id" = wu."roleId"`
        )
        const byUser = new Map(assignments.map((row) => [String(row.userId), String(row.role)]))
        expect(byUser.get(legacy.userId)).toBe('super-admin')
        // The second account holds `personal workspace`, whose 71 grants are overwhelmingly writes.
        expect(byUser.get('9d1f5c22-7e41-4a55-9d31-3f2b6c9a0e17')).toBe('user')

        const ownership = oneOf(legacy.db, `SELECT * FROM "identity_organization_user" WHERE "userId" = ?`, [legacy.userId])
        expect(Number(ownership.isOrgOwner)).toBe(1)
        expect(ownership.lastLogin).toBe('2026-08-06 17:21:17.507')
    })

    it('seeds all six §3 roles as system roles, once per organization', () => {
        const roles = rowsOf(legacy.db, `SELECT "name", "isSystem", "organizationId" FROM "identity_role" ORDER BY "name"`)
        expect(roles.map((role) => role.name)).toEqual(['admin', 'org-admin', 'read-only', 'super-admin', 'super-user', 'user'])
        for (const role of roles) {
            expect(Number(role.isSystem)).toBe(1)
            expect(role.organizationId).toBe(legacy.organizationId)
        }
    })

    it('stamps organizationId onto every tenant-scoped row and verifies it against the workspace (§3a)', () => {
        expect(applied.tenantKeyInconsistencies).toEqual([])
        for (const table of ['chat_flow', 'credential', 'apikey', 'document_store']) {
            const disagreeing = oneOf(
                legacy.db,
                `SELECT COUNT(*) AS c FROM "${table}" t JOIN "identity_workspace" w ON w."id" = t."workspaceId" ` +
                    `WHERE t."organizationId" IS NULL OR t."organizationId" <> w."organizationId"`
            )
            expect({ table, disagreeing: Number(disagreeing.c) }).toEqual({ table, disagreeing: 0 })
        }
        expect(
            Number(oneOf(legacy.db, `SELECT COUNT(*) AS c FROM "chat_flow" WHERE "organizationId" = ?`, [legacy.organizationId]).c)
        ).toBe(25)
        // §3a: "A composite index (organizationId, workspaceId) on each."
        const index = oneOf(legacy.db, `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = ?`, ['IDX_chat_flow_org_ws'])
        expect(String(index.sql)).toContain('"organizationId", "workspaceId"')
    })

    it('writes the role mapping to the audit trail and prints it in the report (§5)', () => {
        const events = rowsOf(legacy.db, `SELECT * FROM "identity_audit_event" WHERE "action" = ?`, ['identity.migration.role.map'])
        expect(events).toHaveLength(2)
        const owner = events.find((event) => String(event.targetId).includes(legacy.userId))!
        expect(String(owner.message)).toContain('to "super-admin"')
        expect(JSON.parse(String(owner.detail))).toMatchObject({ legacyRoleName: 'owner', rule: 'org-owner', target: 'super-admin' })
        expect(applied.report).toContain('rule=org-owner')
        expect(String(events[0].subjectType)).toBe('system')
    })

    it('does not drop the old tables (§8.4)', () => {
        expect(countOf(legacy.db, 'user')).toBe(2)
        expect(countOf(legacy.db, 'organization')).toBe(1)
        expect(countOf(legacy.db, 'workspace')).toBe(1)
        expect(countOf(legacy.db, 'role')).toBe(3)
        expect(countOf(legacy.db, 'workspace_user')).toBe(2)
    })

    it('is idempotent — a second run writes nothing new', async () => {
        const before2 = await fingerprintEverything(legacy.db)
        const second = await migrate(legacy.db, {
            dryRun: false,
            allowUnsafeNoBackup: true,
            rolePermissions: stubRolePermissions as any
        })
        const after2 = await recaptureFingerprint(legacy.db, before2)
        const comparison = compareFingerprints(before2, after2)
        // The audit trail legitimately gains the run's own start/complete records; nothing else moves.
        expect(comparison.mismatches.map((mismatch) => mismatch.table)).toEqual(['identity_audit_event'])
        expect(second.written['identity_user']).toBeUndefined()
        expect(second.written['identity_role']).toBeUndefined()
        expect(countOf(legacy.db, 'identity_user')).toBe(2)
        expect(countOf(legacy.db, 'identity_role')).toBe(6)
    })
})

describe('migration tool — §5 hashes that cannot be verified', () => {
    it('migrates an account with an unrecognisable hash DISABLED rather than leaving it unverifiable', async () => {
        const fixture = await createLegacy31Database({
            bcryptHash: bcrypt.hashSync(PASSWORD, 10),
            password: PASSWORD,
            withMember: true,
            memberCredential: 'sha1$deadbeef$0123456789abcdef'
        })
        try {
            const result = await migrate(fixture.db, {
                dryRun: false,
                allowUnsafeNoBackup: true,
                rolePermissions: stubRolePermissions as any
            })
            const planned = result.plan.users.find((user) => user.email === 'member@example.org')!
            expect(planned.credential).toBe('unrecognised-disabled')
            expect(planned.disabled).toBe(true)
            expect(planned.mustChangePassword).toBe(false)

            // The junk hash is NOT carried: an account must never be left holding a credential
            // nothing can verify.
            const row = oneOf(fixture.db, `SELECT * FROM "identity_user" WHERE "email" = ?`, ['member@example.org'])
            expect(row.credential).toBeNull()
            // Disabled at the membership, which is where status lives (§F-1).
            const membership = oneOf(fixture.db, `SELECT * FROM "identity_organization_user" WHERE "userId" = ?`, [row.id])
            expect(membership.status).toBe('inactive')
            expect(result.warnings.join('\n')).toContain('flowise admin:reset-password --email member@example.org')

            const disabledEvents = rowsOf(fixture.db, `SELECT * FROM "identity_audit_event" WHERE "action" = ?`, [
                'identity.migration.user.disabled'
            ])
            expect(disabledEvents).toHaveLength(1)
            expect(String(disabledEvents[0].outcome)).toBe('failure')
        } finally {
            cleanup(fixture)
        }
    })

    it('carries an argon2id hash but disables the account, because this build cannot verify it', async () => {
        const fixture = await createLegacy31Database({
            bcryptHash: bcrypt.hashSync(PASSWORD, 10),
            password: PASSWORD,
            withMember: true,
            memberCredential: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2g'
        })
        try {
            const result = await migrate(fixture.db, {
                dryRun: false,
                allowUnsafeNoBackup: true,
                rolePermissions: stubRolePermissions as any
            })
            const planned = result.plan.users.find((user) => user.email === 'member@example.org')!
            expect(planned.credential).toBe('carried-unverifiable-disabled')
            expect(planned.credentialAlgorithm).toBe('argon2id')
            expect(planned.disabled).toBe(true)
            const row = oneOf(fixture.db, `SELECT * FROM "identity_user" WHERE "email" = ?`, ['member@example.org'])
            expect(String(row.credential).startsWith('$argon2id$')).toBe(true)
            expect(Number(row.mustChangePassword)).toBe(0)
        } finally {
            cleanup(fixture)
        }
    })
})

describe('migration tool — failure and rollback (§8, §9.5)', () => {
    it('rolls the whole migration back when a step throws, and restores cleanly from the backup', async () => {
        const fixture = await createLegacy31Database({ bcryptHash: bcrypt.hashSync(PASSWORD, 10), password: PASSWORD, withMember: true })
        const backupDirectory = `${fixture.directory}/backups`
        try {
            const before = await fingerprintEverything(fixture.db)

            // Fail part-way THROUGH THE TRANSACTION. `rolePermissions` is called once per role while
            // planning (which reads only) and once per role again while applying, so the SECOND
            // request for a given name is the one inside the transaction. Blowing up on the second
            // sight of `read-only` — the last of the six — means the organization row, five role
            // rows, and every audit record written so far are all live in the transaction when the
            // throw happens. Anything less would be testing that nothing had started yet.
            const seen = new Map<string, number>()
            const explode = (name: string): string[] => {
                const times = (seen.get(name) ?? 0) + 1
                seen.set(name, times)
                if (name === 'read-only' && times === 2) throw new Error('deliberate failure: simulated crash mid-migration')
                return [`stub:${name}`]
            }

            await expect(
                migrate(fixture.db, { dryRun: false, backup: { directory: backupDirectory }, rolePermissions: explode as any })
            ).rejects.toThrow('deliberate failure')

            // 1. The transaction unwound: not one row survives (§8.3).
            const after = await recaptureFingerprint(fixture.db, before)
            expect(compareFingerprints(before, after).identical).toBe(true)
            expect(countOf(fixture.db, 'identity_role')).toBe(0)
            expect(countOf(fixture.db, 'identity_organization')).toBe(0)
            expect(countOf(fixture.db, 'identity_audit_event')).toBe(0)

            // 2. And the backup it took beforehand is a working database in its own right (§8.1, §8.5).
            const backups = fs.readdirSync(backupDirectory)
            expect(backups).toHaveLength(1)
            const backupPath = `${backupDirectory}/${backups[0]}`

            // Damage the live database the way a half-successful upgrade might, then restore.
            fixture.db.all(`DELETE FROM "chat_flow"`)
            fixture.db.all(`DELETE FROM "credential"`)
            expect(countOf(fixture.db, 'chat_flow')).toBe(0)
            fixture.db.close()

            const restore = restoreSqliteBackup({ backupPath, targetPath: fixture.file })
            expect(restore.checks).toEqual(expect.arrayContaining([expect.stringContaining('matches the backup byte for byte')]))
            expect(restore.safetyCopyPath).not.toBeNull()

            const restored = openTestDatabase(fixture.file)
            try {
                expect(countOf(restored, 'chat_flow')).toBe(25)
                expect(countOf(restored, 'credential')).toBe(3)
                const afterRestore = await recaptureFingerprint(restored, before)
                expect(compareFingerprints(before, afterRestore).identical).toBe(true)
            } finally {
                restored.close()
            }
        } finally {
            cleanup(fixture)
        }
    })

    it('refuses to restore a backup whose bytes changed since it was verified (§8.1)', async () => {
        const fixture = await createPre30Database()
        const backupDirectory = `${fixture.directory}/backups`
        try {
            const result = await migrate(fixture.db, {
                dryRun: false,
                backup: { directory: backupDirectory },
                rolePermissions: stubRolePermissions as any
            })
            fixture.db.close()
            expect(() =>
                restoreSqliteBackup({
                    backupPath: result.backup!.path,
                    targetPath: fixture.file,
                    expectedSha256: 'f'.repeat(64)
                })
            ).toThrow('no longer matches the hash recorded when it was verified')
        } finally {
            cleanup(fixture)
        }
    })

    it('aborts before writing anything when the backup cannot be taken (§8.1)', async () => {
        const fixture = await createPre30Database()
        try {
            // A directory that cannot be created: the path passes through an existing FILE.
            const impossible = `${fixture.file}/not-a-directory/backups`
            await expect(
                migrate(fixture.db, { dryRun: false, backup: { directory: impossible }, rolePermissions: stubRolePermissions as any })
            ).rejects.toThrow()
            expect(countOf(fixture.db, 'identity_user')).toBe(0)
            expect(countOf(fixture.db, 'identity_audit_event')).toBe(0)
        } finally {
            cleanup(fixture)
        }
    })

    it('aborts and rolls back if non-user data changes during the migration (§2)', async () => {
        const fixture = await createLegacy31Database({ bcryptHash: bcrypt.hashSync(PASSWORD, 10), password: PASSWORD })
        try {
            const before = await fingerprintEverything(fixture.db)
            // Sabotage: a rolePermissions provider that also mutates protected data. This is what a
            // real §2 violation would look like from the check's point of view — a write nobody
            // declared, discovered by the hash and not by the person who made it.
            // The tamper must land INSIDE the transaction, after the BEFORE fingerprint was taken —
            // otherwise the check would simply record the tampered value as the baseline. The second
            // request for a role name is the applying pass; see the note in the test above.
            const seen = new Map<string, number>()
            const saboteur = (name: string): string[] => {
                const times = (seen.get(name) ?? 0) + 1
                seen.set(name, times)
                if (times === 2) fixture.db.all(`UPDATE "chat_flow" SET "name" = 'tampered' WHERE "id" = 'flow-0'`)
                return [`stub:${name}`]
            }
            await expect(
                migrate(fixture.db, { dryRun: false, allowUnsafeNoBackup: true, rolePermissions: saboteur as any })
            ).rejects.toThrow(MigrationAbort)

            const after = await recaptureFingerprint(fixture.db, before)
            expect(compareFingerprints(before, after).identical).toBe(true)
            expect(oneOf(fixture.db, `SELECT "name" FROM "chat_flow" WHERE "id" = 'flow-0'`).name).toBe('Flow 0')
        } finally {
            cleanup(fixture)
        }
    })
})

describe('role mapping rules (§3, §5)', () => {
    const role = (name: string, permissions: unknown[]) => ({
        id: 'role-id',
        name,
        permissions: JSON.stringify(permissions),
        organizationId: null
    })

    it('maps the org owner to super-admin whatever the role is called', () => {
        const decision = mapLegacyRole(role('renamed-by-the-operator', []), true)
        expect(decision.target).toBe('super-admin')
        expect(decision.rule).toBe('org-owner')
    })

    it('maps a non-owner holding the coarse organization grant to org-admin, not super-admin', () => {
        const decision = mapLegacyRole(role('owner', ['organization', 'workspace']), false)
        expect(decision.target).toBe('org-admin')
        expect(decision.rule).toBe('org-administration-grants')
    })

    it('maps identity administration to org-admin', () => {
        expect(mapLegacyRole(role('team lead', ['chatflows:view', 'users:manage']), false).target).toBe('org-admin')
    })

    it("maps write grants to user — §5's stated default", () => {
        const decision = mapLegacyRole(role('author', ['chatflows:view', 'chatflows:create', 'credentials:view']), false)
        expect(decision.target).toBe('user')
        expect(decision.rule).toBe('write-grants')
    })

    it('maps view-only grants to read-only', () => {
        const decision = mapLegacyRole(role('viewer', ['chatflows:view', 'tools:view', 'templates:marketplace']), false)
        expect(decision.target).toBe('read-only')
        expect(decision.rule).toBe('view-only-grants')
    })

    it('maps the stock `member` role (permissions = []) to read-only rather than granting it authority', () => {
        const decision = mapLegacyRole(role('member', []), false)
        expect(decision.target).toBe('read-only')
        expect(decision.rule).toBe('no-grants')
        expect(decision.reason).toContain('rather than granted authority by a migration')
        // …and §5's literal wording is one option away.
        expect(mapLegacyRole(role('member', []), false, { mapEmptyGrantsToUser: true }).target).toBe('user')
    })

    it('maps an assignment whose role was deleted to the least-privileged tier instead of dropping it', () => {
        const decision = mapLegacyRole(null, false)
        expect(decision.target).toBe('read-only')
        expect(decision.rule).toBe('unmapped-no-role')
    })

    it('treats an unparseable permissions column as no grants rather than throwing', () => {
        const decision = mapLegacyRole({ id: 'r', name: 'broken', permissions: 'not json', organizationId: null }, false)
        expect(decision.legacyGrantCount).toBe(0)
        expect(decision.target).toBe('read-only')
    })
})
