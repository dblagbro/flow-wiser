/**
 * Vault boot path (ADR-0006; rulings C42, C45).
 *
 * The rule under test is Phase 1 no-lockout: with the flag on, the vault is used only when it
 * serves both secrets and they are the secrets this deployment already has; in every other case the
 * result is "not this run", with a severity, and the caller carries on with the environment source.
 * The single exception — refuse to start on an explicit revoke — is opt-in and tested as such.
 *
 * The hub is replaced by an injected `fetchBundle`; the wire and client layers have their own
 * suites and a live run. Every secret here is generated at run time.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { FetchBundleInput, FetchBundleResult } from './bundleClient'
import { loadIdentityKeyFile, resolveVaultBootSecrets, VaultRevokedError } from './bootSecrets'
import { Bundle } from './wire'

const NS = 'coordinator-hub/services/flow-wiser'
const { privateKey } = generateKeyPairSync('ed25519')

describe('resolveVaultBootSecrets', () => {
    let masterKey: string
    let pepper: string
    let calls: FetchBundleInput[]

    const baseEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
        ({
            IDENTITY_KEY_SOURCE: 'vault',
            IDENTITY_VAULT_URL: 'http://127.0.0.1:18232',
            IDENTITY_VAULT_AUTHORITY: '127.0.0.1:8232',
            IDENTITY_VAULT_NAMESPACE: NS,
            IDENTITY_VAULT_IDENTITY: 'flow-wiser-reader',
            IDENTITY_VAULT_IDENTITY_KEY_FILE: '/dev/null/identity.pem',
            IDENTITY_ENCRYPTION_KEY: masterKey,
            FLOWISE_SESSION_PEPPER: pepper,
            ...extra
        } as NodeJS.ProcessEnv)

    const bundle = (overrides: Partial<Bundle> = {}): Bundle => ({
        namespace: NS,
        etag: '"e1"',
        items: [
            { path: `${NS}/master-key`, version: 7, data: { value: masterKey } },
            { path: `${NS}/session-pepper`, version: 3, data: { value: pepper } }
        ],
        tombstones: [],
        withheld: [],
        ...overrides
    })
    const serving = (result: FetchBundleResult) => ({
        loadIdentityKey: () => privateKey,
        fetchBundle: async (input: FetchBundleInput) => {
            calls.push(input)
            return result
        }
    })
    const ok = (b: Bundle = bundle()): FetchBundleResult => ({
        outcome: 'bundle',
        classification: { state: 'OK', code: 'ok', clearCache: false },
        bundle: b
    })
    const noBundle = (state: string, code: string, clearCache = false): FetchBundleResult =>
        ({ outcome: 'no_bundle', classification: { state, code, clearCache } } as FetchBundleResult)

    beforeEach(() => {
        masterKey = randomBytes(32).toString('base64')
        pepper = randomBytes(32).toString('base64')
        calls = []
    })

    describe('off by default', () => {
        it.each([undefined, '', 'env', 'ENV', 'file', 'vaults', 'true'])('does nothing when IDENTITY_KEY_SOURCE is %j', async (value) => {
            const deps = serving(ok())
            expect(await resolveVaultBootSecrets(baseEnv({ IDENTITY_KEY_SOURCE: value }), deps)).toEqual({ status: 'disabled' })
            expect(calls).toHaveLength(0)
        })

        it('does not read vault configuration or the identity key when off', async () => {
            const loadIdentityKey = jest.fn()
            const result = await resolveVaultBootSecrets({ IDENTITY_VAULT_URL: 'http://x' } as NodeJS.ProcessEnv, {
                loadIdentityKey,
                fetchBundle: jest.fn()
            })
            expect(result).toEqual({ status: 'disabled' })
            expect(loadIdentityKey).not.toHaveBeenCalled()
        })
    })

    describe('the vault serves both secrets', () => {
        it('returns a keyring and pepper provider built from the vault values', async () => {
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok()))
            expect(result.status).toBe('vault')
            if (result.status !== 'vault') return
            const active = result.keyring.getActive()
            expect(active.material.equals(Buffer.from(masterKey, 'base64'))).toBe(true)
            expect(active.source).toBe('vault')
            expect(result.pepperProvider.current().secret.equals(Buffer.from(pepper, 'utf-8'))).toBe(true)
            expect(result.namespace).toBe(NS)
        })

        it('makes one request, for the configured namespace, identity and authority', async () => {
            await resolveVaultBootSecrets(baseEnv({ IDENTITY_VAULT_TIMEOUT_MS: '2500' }), serving(ok()))
            expect(calls).toHaveLength(1)
            expect(calls[0]).toMatchObject({
                baseUrl: 'http://127.0.0.1:18232',
                authority: '127.0.0.1:8232',
                prefix: '/claudeCoordinator/api/v1/vault',
                namespace: NS,
                keyid: 'flow-wiser-reader',
                timeoutMs: 2500
            })
        })

        // C45 Q(i): the vault MIRRORS the existing key. Its storage version (7 here) must never
        // become the key version recorded on rows.
        it('takes key id and version from configuration, never from the vault version counter', async () => {
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok()))
            if (result.status !== 'vault') throw new Error('expected vault')
            expect(result.keyring.getActive()).toMatchObject({ version: 1, keyId: 'env' })
            expect(result.pepperProvider.current()).toMatchObject({ version: 1, keyId: 'session-pepper' })

            const configured = await resolveVaultBootSecrets(
                baseEnv({
                    IDENTITY_ENCRYPTION_KEY_VERSION: '4',
                    IDENTITY_ENCRYPTION_KEY_ID: 'k-main',
                    FLOWISE_SESSION_PEPPER_VERSION: '2',
                    FLOWISE_SESSION_PEPPER_ID: 'p-main'
                }),
                serving(ok())
            )
            if (configured.status !== 'vault') throw new Error('expected vault')
            expect(configured.keyring.getActive()).toMatchObject({ version: 4, keyId: 'k-main' })
            expect(configured.pepperProvider.current()).toMatchObject({ version: 2, keyId: 'p-main' })
        })

        it('keeps retired environment keys readable beside the vault key', async () => {
            const retired = randomBytes(32).toString('base64')
            const result = await resolveVaultBootSecrets(
                baseEnv({ IDENTITY_ENCRYPTION_KEY_VERSION: '2', IDENTITY_ENCRYPTION_KEY_V1: retired }),
                serving(ok())
            )
            if (result.status !== 'vault') throw new Error('expected vault')
            expect(result.keyring.listVersions()).toEqual([1, 2])
            expect(result.keyring.getByVersion(1).material.equals(Buffer.from(retired, 'base64'))).toBe(true)
            expect(result.keyring.getActive().version).toBe(2)
        })

        it('works with no environment key at all — the intended end state', async () => {
            const result = await resolveVaultBootSecrets(
                baseEnv({ IDENTITY_ENCRYPTION_KEY: undefined, FLOWISE_SESSION_PEPPER: undefined }),
                serving(ok())
            )
            expect(result.status).toBe('vault')
        })

        it('honours custom entry names', async () => {
            const b = bundle({
                items: [
                    { path: `${NS}/ocr-key`, version: 1, data: { value: masterKey } },
                    { path: `${NS}/llm-key`, version: 1, data: { value: pepper } }
                ]
            })
            const env = baseEnv({ IDENTITY_VAULT_MASTER_KEY_ENTRY: 'ocr-key', IDENTITY_VAULT_SESSION_PEPPER_ENTRY: 'llm-key' })
            expect((await resolveVaultBootSecrets(env, serving(ok(b)))).status).toBe('vault')
        })
    })

    describe('mirror, not rotate', () => {
        it('refuses a vault key that is not the configured key', async () => {
            const other = randomBytes(32).toString('base64')
            const b = bundle({
                items: [
                    { path: `${NS}/master-key`, version: 1, data: { value: other } },
                    { path: `${NS}/session-pepper`, version: 1, data: { value: pepper } }
                ]
            })
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok(b)))
            expect(result).toMatchObject({ status: 'fallback', severity: 'alarm', code: 'key_mismatch' })
            expect(JSON.stringify(result)).not.toContain(other)
            expect(JSON.stringify(result)).not.toContain(masterKey)
        })

        it('refuses a vault pepper that is not the configured pepper', async () => {
            const other = randomBytes(32).toString('base64')
            const b = bundle({
                items: [
                    { path: `${NS}/master-key`, version: 1, data: { value: masterKey } },
                    { path: `${NS}/session-pepper`, version: 1, data: { value: other } }
                ]
            })
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok(b)))
            expect(result).toMatchObject({ status: 'fallback', severity: 'alarm', code: 'pepper_mismatch' })
            expect(JSON.stringify(result)).not.toContain(other)
        })

        it('refuses vault key material the keyring would refuse from any source', async () => {
            const b = bundle({
                items: [
                    { path: `${NS}/master-key`, version: 1, data: { value: 'short-canary' } },
                    { path: `${NS}/session-pepper`, version: 1, data: { value: pepper } }
                ]
            })
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok(b)))
            expect(result).toMatchObject({ status: 'fallback', severity: 'alarm', code: 'vault_key_rejected' })
            expect(JSON.stringify(result)).not.toContain('short-canary')
        })
    })

    describe('Phase 1 no-lockout: everything else means "not this run", never a refusal', () => {
        it.each([
            ['revoked', noBundle('REVOKED', 'revoked', true), 'alarm', 'revoked'],
            ['grant_denied', noBundle('DENIED', 'grant_denied', true), 'alarm', 'grant_denied'],
            ['unreachable', noBundle('UNREACHABLE', 'no_response'), 'warning', 'no_response'],
            ['sealed', noBundle('UNREACHABLE', 'vault_sealed'), 'warning', 'vault_sealed'],
            ['a rejected request (clock, signature)', noBundle('REQUEST_REJECTED', 'clock_skew'), 'warning', 'clock_skew'],
            ['an unexpected status', noBundle('UNEXPECTED', 'http_500'), 'alarm', 'http_500'],
            ['a tombstoned namespace read', noBundle('TOMBSTONED', 'tombstone'), 'alarm', 'tombstone'],
            [
                'an untrusted bundle',
                {
                    outcome: 'untrusted_bundle',
                    classification: { state: 'OK', code: 'ok', clearCache: false },
                    reason: 'wrong_namespace'
                } as FetchBundleResult,
                'alarm',
                'untrusted_bundle'
            ],
            [
                'a 304 nobody asked for',
                {
                    outcome: 'not_modified',
                    classification: { state: 'NOT_MODIFIED', code: 'not_modified', clearCache: false }
                } as FetchBundleResult,
                'alarm',
                'unexpected_not_modified'
            ]
        ])('%s → fallback (%s)', async (_name, response, severity, code) => {
            expect(await resolveVaultBootSecrets(baseEnv(), serving(response as FetchBundleResult))).toMatchObject({
                status: 'fallback',
                severity,
                code
            })
        })

        it.each([
            [
                'the master key is tombstoned as revoked',
                { items: 'pepper', tombstones: [{ path: `${NS}/master-key`, reason: 'revoked' }] },
                'revoked'
            ],
            ['the master key is tombstoned as deleted', { items: 'pepper', tombstones: [{ path: `${NS}/master-key` }] }, 'tombstoned'],
            [
                'the master key is withheld',
                { items: 'pepper', withheld: [{ path: `${NS}/master-key`, reason: 'no_read_grant' }] },
                'withheld_no_read_grant'
            ],
            ['the master key is absent', { items: 'pepper' }, 'absent'],
            ['the pepper is absent', { items: 'master' }, 'absent'],
            ['the bundle is empty', { items: 'none' }, 'absent']
        ])('%s → fallback with an alarm, and never one secret from each source', async (_name, shape, code) => {
            const items = bundle().items.filter((item) =>
                shape.items === 'pepper'
                    ? item.path.endsWith('session-pepper')
                    : shape.items === 'master'
                    ? item.path.endsWith('master-key')
                    : false
            )
            const b = bundle({
                items,
                tombstones: (shape as { tombstones?: Bundle['tombstones'] }).tombstones ?? [],
                withheld: (shape as { withheld?: Bundle['withheld'] }).withheld ?? []
            })
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok(b)))
            expect(result).toMatchObject({ status: 'fallback', severity: 'alarm', code })
            expect(result).not.toHaveProperty('keyring')
            expect(result).not.toHaveProperty('pepperProvider')
        })

        it('names the entry and the code, and no value, in what it reports', async () => {
            const b = bundle({ items: [bundle().items[1]], tombstones: [{ path: `${NS}/master-key`, reason: 'revoked' }] })
            const result = await resolveVaultBootSecrets(baseEnv(), serving(ok(b)))
            expect(result).toMatchObject({ code: 'revoked', detail: `entry ${NS}/master-key` })
            expect(JSON.stringify(result)).not.toContain(pepper)
        })

        it.each([
            'IDENTITY_VAULT_URL',
            'IDENTITY_VAULT_AUTHORITY',
            'IDENTITY_VAULT_NAMESPACE',
            'IDENTITY_VAULT_IDENTITY',
            'IDENTITY_VAULT_IDENTITY_KEY_FILE'
        ])('a missing %s is a misconfiguration alarm, and no request is sent', async (name) => {
            const result = await resolveVaultBootSecrets(baseEnv({ [name]: undefined }), serving(ok()))
            expect(result).toMatchObject({ status: 'fallback', severity: 'alarm', code: 'vault_misconfigured' })
            expect((result as { detail: string }).detail).toContain(name)
            expect(calls).toHaveLength(0)
        })

        it('an unusable identity key is an alarm, and no request is sent', async () => {
            const deps = {
                ...serving(ok()),
                loadIdentityKey: () => {
                    throw new Error('identity key file has mode 0644; it must be 0400 or 0600')
                }
            }
            expect(await resolveVaultBootSecrets(baseEnv(), deps)).toMatchObject({
                status: 'fallback',
                severity: 'alarm',
                code: 'identity_key_unusable'
            })
            expect(calls).toHaveLength(0)
        })

        it('a request the client refuses to build is a misconfiguration alarm', async () => {
            const deps = {
                loadIdentityKey: () => privateKey,
                fetchBundle: async () => {
                    throw new Error('vault authority must be a bare host[:port], without a scheme or path')
                }
            }
            expect(await resolveVaultBootSecrets(baseEnv(), deps)).toMatchObject({
                status: 'fallback',
                severity: 'alarm',
                code: 'vault_misconfigured'
            })
        })
    })

    describe('strict mode (opt-in): an explicit revoke refuses to start', () => {
        const strict = { IDENTITY_VAULT_STRICT_REVOKE: 'true' }

        it.each([
            ['revoked', noBundle('REVOKED', 'revoked', true)],
            ['grant_denied', noBundle('DENIED', 'grant_denied', true)]
        ])('throws on %s', async (code, response) => {
            await expect(resolveVaultBootSecrets(baseEnv(strict), serving(response))).rejects.toMatchObject({
                name: 'VaultRevokedError',
                code
            })
        })

        it('throws when the master key entry is tombstoned as revoked', async () => {
            const b = bundle({ items: [bundle().items[1]], tombstones: [{ path: `${NS}/master-key`, reason: 'revoked' }] })
            await expect(resolveVaultBootSecrets(baseEnv(strict), serving(ok(b)))).rejects.toBeInstanceOf(VaultRevokedError)
        })

        it.each([
            ['unreachable', noBundle('UNREACHABLE', 'no_response')],
            ['sealed', noBundle('UNREACHABLE', 'vault_sealed')],
            ['clock skew', noBundle('REQUEST_REJECTED', 'clock_skew')],
            ['a 500', noBundle('UNEXPECTED', 'http_500')]
        ])('still falls back, without throwing, on %s', async (_name, response) => {
            expect((await resolveVaultBootSecrets(baseEnv(strict), serving(response))).status).toBe('fallback')
        })

        it.each(['false', '', '1', 'yes'])('is off for IDENTITY_VAULT_STRICT_REVOKE=%j', async (value) => {
            const result = await resolveVaultBootSecrets(
                baseEnv({ IDENTITY_VAULT_STRICT_REVOKE: value }),
                serving(noBundle('REVOKED', 'revoked', true))
            )
            expect(result).toMatchObject({ status: 'fallback', severity: 'alarm', code: 'revoked' })
        })
    })
})

describe('loadIdentityKeyFile', () => {
    let dir: string
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    const write = (name: string, contents: string, mode: number): string => {
        const file = path.join(dir, name)
        writeFileSync(file, contents)
        chmodSync(file, mode)
        return file
    }
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'fw-vault-id-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it.each([0o400, 0o600])('reads an Ed25519 key with mode %o', (mode) => {
        expect(loadIdentityKeyFile(write('id.pem', pem, mode)).asymmetricKeyType).toBe('ed25519')
    })

    it.each([0o640, 0o644, 0o604, 0o700])('refuses a key file with mode %o without reading it', (mode) => {
        expect(() => loadIdentityKeyFile(write('id.pem', pem, mode))).toThrow(/must be 0400 or 0600/)
    })

    it('refuses a key that is not Ed25519', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
        expect(() => loadIdentityKeyFile(write('rsa.pem', rsa, 0o600))).toThrow(/not an Ed25519 private key/)
    })

    it('refuses a missing file', () => {
        expect(() => loadIdentityKeyFile(path.join(dir, 'absent.pem'))).toThrow()
    })
})
