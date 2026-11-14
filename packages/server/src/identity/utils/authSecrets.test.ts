/**
 * Boot-time secret check (`initAuthSecrets`) and the environment pepper provider.
 *
 * `initAuthSecrets` is the one place the server decides whether it has the two secrets it cannot
 * run without, and it is where a vault key source would attach (ADR-0006). It had no test of its
 * own. These pin what it does today: both secrets are fatal, the refusal is logged once and
 * rethrown, and neither secret's value reaches a log line.
 *
 * Every secret here is generated at run time.
 */
import { randomBytes } from 'node:crypto'
import logger from '../../utils/logger'
import { buildVaultKeyring, KeyringError, getKeyring, resetKeyring } from '../crypto/keyring'
import { PUBLISHED_EXAMPLE_SECRETS } from '../crypto/passwords'
import {
    defaultSessionPepperProvider,
    EnvSessionPepperProvider,
    installSessionPepperProvider,
    SessionService,
    VaultSessionPepperProvider
} from '../services/SessionService'
import * as bootSecrets from '../vault/bootSecrets'
import { initAuthSecrets } from './authSecrets'

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

const log = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock }
const logged = (): string =>
    [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map((call) => call.join(' ')).join('\n')

const SECRET_VARIABLES = /^(IDENTITY_ENCRYPTION_KEY|FLOWISE_SESSION_PEPPER|IDENTITY_KEY_SOURCE|IDENTITY_VAULT_)/

describe('boot-time secrets', () => {
    const saved = { ...process.env }
    let key: string
    let pepper: string

    beforeEach(() => {
        jest.clearAllMocks()
        process.env = { ...saved }
        for (const name of Object.keys(process.env)) if (SECRET_VARIABLES.test(name)) delete process.env[name]
        key = randomBytes(32).toString('base64')
        pepper = randomBytes(32).toString('base64')
        process.env.IDENTITY_ENCRYPTION_KEY = key
        process.env.FLOWISE_SESSION_PEPPER = pepper
        resetKeyring()
    })
    afterAll(() => {
        process.env = { ...saved }
        resetKeyring()
    })

    describe('initAuthSecrets', () => {
        it('succeeds with both secrets and logs fingerprints, never values', async () => {
            await expect(initAuthSecrets()).resolves.toBeUndefined()
            const output = logged()
            expect(output).toMatch(/encryption keyring active=v1 keys=\[v1:env:[0-9a-f]{16}\]/)
            expect(output).toMatch(/session pepper active=v1 keyId=session-pepper/)
            expect(output).not.toContain(key)
            expect(output).not.toContain(pepper)
            expect(output).not.toContain(Buffer.from(key, 'base64').toString('hex'))
            expect(log.error).not.toHaveBeenCalled()
        })

        it('refuses to start without an encryption key', async () => {
            delete process.env.IDENTITY_ENCRYPTION_KEY
            await expect(initAuthSecrets()).rejects.toBeInstanceOf(KeyringError)
            expect(log.error).toHaveBeenCalledTimes(1)
            expect(log.error.mock.calls[0][0]).toMatch(/encryption keyring rejected — no encryption key configured/)
        })

        it('refuses a published example key, without echoing it', async () => {
            process.env.IDENTITY_ENCRYPTION_KEY = PUBLISHED_EXAMPLE_SECRETS[0]
            await expect(initAuthSecrets()).rejects.toThrow(/published example value/)
            expect(logged().replace(/a published example value/g, '')).not.toContain(PUBLISHED_EXAMPLE_SECRETS[0])
        })

        it('refuses to start without a session pepper — fatal, not a warning', async () => {
            delete process.env.FLOWISE_SESSION_PEPPER
            await expect(initAuthSecrets()).rejects.toThrow(/FLOWISE_SESSION_PEPPER is not set/)
            expect(log.error).toHaveBeenCalledTimes(1)
            expect(log.error.mock.calls[0][0]).toMatch(/session pepper unavailable — refusing to start/)
        })

        it('refuses an empty session pepper', async () => {
            process.env.FLOWISE_SESSION_PEPPER = ''
            await expect(initAuthSecrets()).rejects.toThrow(/FLOWISE_SESSION_PEPPER is not set/)
        })

        it('checks the keyring first, so a missing key is the error reported when both are missing', async () => {
            delete process.env.IDENTITY_ENCRYPTION_KEY
            delete process.env.FLOWISE_SESSION_PEPPER
            await expect(initAuthSecrets()).rejects.toBeInstanceOf(KeyringError)
        })

        it('re-reads the environment on every call instead of trusting a cached keyring', async () => {
            await initAuthSecrets()
            const before = getKeyring().getActive().fingerprint
            process.env.IDENTITY_ENCRYPTION_KEY = randomBytes(32).toString('base64')
            await initAuthSecrets()
            expect(getKeyring().getActive().fingerprint).not.toBe(before)

            delete process.env.IDENTITY_ENCRYPTION_KEY
            await expect(initAuthSecrets()).rejects.toBeInstanceOf(KeyringError)
        })

        it('never generates a secret when one is missing', async () => {
            delete process.env.IDENTITY_ENCRYPTION_KEY
            delete process.env.FLOWISE_SESSION_PEPPER
            await expect(initAuthSecrets()).rejects.toBeDefined()
            expect(process.env.IDENTITY_ENCRYPTION_KEY).toBeUndefined()
            expect(process.env.FLOWISE_SESSION_PEPPER).toBeUndefined()
        })
    })

    // ADR-0006. The vault path is optional and off by default; when on, Phase 1 is no-lockout: the
    // environment source still decides whether the server can start.
    describe('initAuthSecrets — vault key source', () => {
        const fromVault = (vaultKey: string, vaultPepper: string): bootSecrets.VaultBootResult => ({
            status: 'vault',
            keyring: buildVaultKeyring(vaultKey, process.env),
            pepperProvider: new VaultSessionPepperProvider(Buffer.from(vaultPepper, 'utf-8'), 1, 'session-pepper'),
            namespace: 'coordinator-hub/services/flow-wiser'
        })
        let resolve: jest.SpyInstance

        beforeEach(() => {
            resolve = jest.spyOn(bootSecrets, 'resolveVaultBootSecrets')
        })
        afterEach(() => {
            resolve.mockRestore()
            installSessionPepperProvider(null)
        })

        it('is off by default: no request, no vault line in the log, environment sources in effect', async () => {
            const fetchSpy = jest.spyOn(globalThis, 'fetch')
            await initAuthSecrets()
            expect(await resolve.mock.results[0].value).toEqual({ status: 'disabled' })
            expect(fetchSpy).not.toHaveBeenCalled()
            expect(logged()).not.toMatch(/vault/i)
            expect(getKeyring().getActive().source).toBe('env')
            expect(defaultSessionPepperProvider()).toBeInstanceOf(EnvSessionPepperProvider)
            fetchSpy.mockRestore()
        })

        it('installs the vault keyring and pepper for the whole process, and logs no value', async () => {
            resolve.mockResolvedValue(fromVault(key, pepper))
            await initAuthSecrets()
            expect(getKeyring().getActive().source).toBe('vault')
            expect(getKeyring().getActive().material.equals(Buffer.from(key, 'base64'))).toBe(true)
            expect(defaultSessionPepperProvider().current().secret.equals(Buffer.from(pepper, 'utf-8'))).toBe(true)
            const output = logged()
            expect(output).toMatch(/fetched from the vault \(namespace coordinator-hub\/services\/flow-wiser\)/)
            expect(output).toMatch(/encryption keyring active=v1 keys=\[v1:vault:[0-9a-f]{16}\]/)
            expect(output).not.toContain(key)
            expect(output).not.toContain(pepper)
            expect(log.error).not.toHaveBeenCalled()
        })

        it('a SessionService built afterwards uses the vault pepper without being told to', async () => {
            resolve.mockResolvedValue(fromVault(key, pepper))
            await initAuthSecrets()
            const service = new SessionService({} as never)
            expect((service as unknown as { peppers: unknown }).peppers).toBeInstanceOf(VaultSessionPepperProvider)
        })

        it('starts from the vault alone when the environment holds neither secret', async () => {
            resolve.mockResolvedValue(fromVault(key, pepper))
            delete process.env.IDENTITY_ENCRYPTION_KEY
            delete process.env.FLOWISE_SESSION_PEPPER
            await expect(initAuthSecrets()).resolves.toBeUndefined()
            expect(getKeyring().getActive().source).toBe('vault')
        })

        it.each([
            ['alarm', 'error', 'revoked'],
            ['warning', 'warn', 'no_response']
        ] as const)('a fallback (%s) is logged at %s and the server starts on the environment source', async (severity, level, code) => {
            resolve.mockResolvedValue({ status: 'fallback', severity, code, detail: 'entry x/master-key' })
            await expect(initAuthSecrets()).resolves.toBeUndefined()
            expect(log[level]).toHaveBeenCalledTimes(1)
            expect(log[level].mock.calls[0][0]).toMatch(new RegExp(`VAULT NOT USED THIS RUN — ${code}: entry x/master-key`))
            expect(getKeyring().getActive().source).toBe('env')
            expect(defaultSessionPepperProvider()).toBeInstanceOf(EnvSessionPepperProvider)
        })

        it('a fallback with no environment key still refuses to start — no-lockout is not no-key', async () => {
            resolve.mockResolvedValue({ status: 'fallback', severity: 'alarm', code: 'revoked', detail: 'namespace x' })
            delete process.env.IDENTITY_ENCRYPTION_KEY
            await expect(initAuthSecrets()).rejects.toBeInstanceOf(KeyringError)
        })

        // Ruling C50 §3: with no key of its own and no fingerprint to hold the vault's key against,
        // there is nothing to start on — and the log has to say that, not just "no key configured".
        it('refuses to start, and says why, when the vault key cannot be pinned and there is no environment key', async () => {
            resolve.mockResolvedValue({
                status: 'fallback',
                severity: 'alarm',
                code: 'fingerprint_required',
                detail: 'IDENTITY_VAULT_MASTER_KEY_FINGERPRINT must be set'
            })
            delete process.env.IDENTITY_ENCRYPTION_KEY
            await expect(initAuthSecrets()).rejects.toBeInstanceOf(KeyringError)
            const errors = log.error.mock.calls.map((call) => call[0] as string)
            expect(errors[0]).toMatch(/VAULT NOT USED THIS RUN — fingerprint_required: IDENTITY_VAULT_MASTER_KEY_FINGERPRINT must be set/)
            expect(errors[1]).toMatch(/encryption keyring rejected — no encryption key configured/)
        })

        it('strict mode: an explicit revoke is logged and refuses to start even with environment secrets', async () => {
            resolve.mockRejectedValue(new bootSecrets.VaultRevokedError('the vault answered revoked — refusing to start', 'revoked'))
            await expect(initAuthSecrets()).rejects.toBeInstanceOf(bootSecrets.VaultRevokedError)
            expect(log.error.mock.calls[0][0]).toMatch(/the vault answered revoked — refusing to start/)
            expect(() => getKeyring().getActive().source).not.toThrow()
            expect(getKeyring().getActive().source).toBe('env')
        })

        it('a later boot with the vault off drops the vault keyring and pepper', async () => {
            resolve.mockResolvedValueOnce(fromVault(key, pepper))
            await initAuthSecrets()
            expect(getKeyring().getActive().source).toBe('vault')
            resolve.mockResolvedValueOnce({ status: 'disabled' })
            await initAuthSecrets()
            expect(getKeyring().getActive().source).toBe('env')
            expect(defaultSessionPepperProvider()).toBeInstanceOf(EnvSessionPepperProvider)
        })

        // Nothing mocked: the flag on with nothing else configured must alarm and start, not hang or fail.
        it('end to end: the flag on but unconfigured alarms as misconfigured and starts on the environment', async () => {
            resolve.mockRestore()
            process.env.IDENTITY_KEY_SOURCE = 'vault'
            await expect(initAuthSecrets()).resolves.toBeUndefined()
            expect(log.error).toHaveBeenCalledTimes(1)
            expect(log.error.mock.calls[0][0]).toMatch(/VAULT NOT USED THIS RUN — vault_misconfigured: .*IDENTITY_VAULT_URL/)
            expect(getKeyring().getActive().source).toBe('env')
        })
    })

    describe('EnvSessionPepperProvider', () => {
        const provider = new EnvSessionPepperProvider()

        it('serves the current pepper as version 1 with the default key id', () => {
            const current = provider.current()
            expect(current).toMatchObject({ version: 1, keyId: 'session-pepper' })
            expect(current.secret.equals(Buffer.from(pepper, 'utf-8'))).toBe(true)
        })

        it('honours the declared id and version', () => {
            process.env.FLOWISE_SESSION_PEPPER_ID = 'pepper-2026'
            process.env.FLOWISE_SESSION_PEPPER_VERSION = '3'
            expect(provider.current()).toMatchObject({ version: 3, keyId: 'pepper-2026' })
        })

        it('keeps a retired generation verifiable after rotation', () => {
            const retired = randomBytes(32).toString('base64')
            process.env.FLOWISE_SESSION_PEPPER_VERSION = '2'
            process.env.FLOWISE_SESSION_PEPPER_V1 = retired
            expect(provider.current().version).toBe(2)
            expect(provider.forVersion(1)?.secret.equals(Buffer.from(retired, 'utf-8'))).toBe(true)
            expect(provider.forVersion(2)?.secret.equals(Buffer.from(pepper, 'utf-8'))).toBe(true)
        })

        it('returns undefined, not an invented pepper, for a generation it does not hold', () => {
            expect(provider.forVersion(7)).toBeUndefined()
        })

        it('treats a null or missing version as the current one', () => {
            expect(provider.forVersion(null)?.version).toBe(1)
            expect(provider.forVersion(undefined)?.version).toBe(1)
        })

        it('reads the environment on every call, so nothing is cached across a change', () => {
            const first = provider.current().secret
            process.env.FLOWISE_SESSION_PEPPER = randomBytes(32).toString('base64')
            expect(provider.current().secret.equals(first)).toBe(false)
        })

        it('never puts the pepper in its refusal', () => {
            delete process.env.FLOWISE_SESSION_PEPPER
            process.env.FLOWISE_SESSION_PEPPER_V1 = pepper
            process.env.FLOWISE_SESSION_PEPPER_VERSION = '2'
            expect(() => provider.current()).toThrow(/FLOWISE_SESSION_PEPPER is not set/)
            try {
                provider.current()
            } catch (error) {
                expect((error as Error).message).not.toContain(pepper)
            }
        })

        // Recorded as it is today, not as it should be (I-38). The keyring refuses short material,
        // published example values and malformed versions; the pepper path accepts all three.
        describe('current behaviour that is weaker than the keyring (I-38)', () => {
            it('accepts a one-character pepper', () => {
                process.env.FLOWISE_SESSION_PEPPER = 'x'
                expect(provider.current().secret).toHaveLength(1)
            })

            it('accepts a published example value as the pepper', () => {
                process.env.FLOWISE_SESSION_PEPPER = PUBLISHED_EXAMPLE_SECRETS[0]
                expect(provider.current().secret.toString('utf-8')).toBe(PUBLISHED_EXAMPLE_SECRETS[0])
            })

            it.each([
                ['2abc', 2],
                ['1.5x', 1],
                ['0', 1],
                ['-3', 1],
                ['abc', 1]
            ])('reads the malformed version %j as %i instead of refusing', (raw, version) => {
                process.env.FLOWISE_SESSION_PEPPER_VERSION = raw
                process.env[`FLOWISE_SESSION_PEPPER_V${version}`] = pepper
                expect(provider.current().version).toBe(version)
            })
        })
    })
})
