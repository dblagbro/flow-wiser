/**
 * Keyring — key material loading (REQUIREMENTS-AUTH-RBAC §1, §9).
 *
 * This module decides which key every stored credential is encrypted under, and it had no tests.
 * These pin its behaviour before anything is added to it: a new key source has to slot in without
 * moving any of the refusals asserted here.
 *
 * No key material is written into this file. Every key is generated at run time; the one "known"
 * value is read from the module's own published-example list.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getKeyring, KeyringError, KeySource, loadKeyring, MIN_KEY_MATERIAL_BYTES, resetKeyring } from './keyring'
import { PUBLISHED_EXAMPLE_SECRETS } from './passwords'

const b64Key = (): string => randomBytes(32).toString('base64')
const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv

/** The message of the KeyringError a loader throws, or a failure if it did not throw one. */
const refusal = (load: () => unknown): string => {
    try {
        load()
    } catch (error) {
        expect(error).toBeInstanceOf(KeyringError)
        return (error as Error).message
    }
    throw new Error('expected a KeyringError, but loading succeeded')
}

describe('loadKeyring — fail closed', () => {
    it('refuses to start with no key configured, and never generates one', () => {
        expect(refusal(() => loadKeyring(env({})))).toMatch(/no encryption key configured/)
        expect(refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: '   ' })))).toMatch(/no encryption key configured/)
    })

    it.each(PUBLISHED_EXAMPLE_SECRETS.map((value) => [value]))('refuses the published example value %j', (value) => {
        const message = refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: value })))
        expect(message).toMatch(/published example value/)
        // The refusal names the variable, not what it held. (Compared against the message with its
        // own fixed wording removed, since one published value is the word "example".)
        expect(message.replace('a published example value', '')).not.toContain(value)
    })

    it('refuses a published example value regardless of case and surrounding whitespace', () => {
        const value = `  ${PUBLISHED_EXAMPLE_SECRETS[0].toUpperCase()}  `
        expect(refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: value })))).toMatch(/published example value/)
    })

    it('refuses material shorter than 32 bytes instead of stretching it', () => {
        const short = randomBytes(16).toString('base64')
        const message = refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: short })))
        expect(message).toMatch(new RegExp(`at least ${MIN_KEY_MATERIAL_BYTES} are required`))
        expect(message).not.toContain(short)
    })

    // `Number.parseInt` reads '1.5x' as 1 and '2abc' as 2, so a typo in the version used to be
    // accepted as some other version — the number recorded on every row written from then on.
    it.each(['0', '-1', 'abc', '1.5x', '2abc', '1e3', ' ', '0x10', '+2'])('refuses key version %j', (version) => {
        const message = refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: b64Key(), IDENTITY_ENCRYPTION_KEY_VERSION: version })))
        expect(message).toMatch(/versions are integers ≥ 1/)
    })

    it.each(['x', '1.5', '3rd'])('refuses active version %j', (version) => {
        const vars = {
            IDENTITY_ENCRYPTION_KEY_V1: b64Key(),
            IDENTITY_ENCRYPTION_KEY_V3: b64Key(),
            IDENTITY_ENCRYPTION_KEY_ACTIVE_VERSION: version
        }
        expect(refusal(() => loadKeyring(env(vars)))).toMatch(/versions are integers ≥ 1/)
    })

    it('accepts a version with surrounding whitespace', () => {
        expect(loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: b64Key(), IDENTITY_ENCRYPTION_KEY_VERSION: ' 3 ' })).getActive().version).toBe(3)
    })

    it('refuses two different keys declared for the same version', () => {
        const message = refusal(() =>
            loadKeyring(
                env({ IDENTITY_ENCRYPTION_KEY: b64Key(), IDENTITY_ENCRYPTION_KEY_VERSION: '2', IDENTITY_ENCRYPTION_KEY_V2: b64Key() })
            )
        )
        expect(message).toMatch(/two different keys are declared for version 2/)
    })

    it('refuses an active version that has no material', () => {
        const message = refusal(() =>
            loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_V1: b64Key(), IDENTITY_ENCRYPTION_KEY_ACTIVE_VERSION: '3' }))
        )
        expect(message).toMatch(/active key version 3 has no material/)
    })

    it('refuses env and file sources together rather than merging them', () => {
        const message = refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: b64Key(), IDENTITY_ENCRYPTION_KEY_FILE: '/nonexistent' })))
        expect(message).toMatch(/configure exactly one key source/)
    })

    it('never puts key text in an error message', () => {
        const key = b64Key()
        const messages = [
            refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: key, IDENTITY_ENCRYPTION_KEY_VERSION: '0' }))),
            refusal(() =>
                loadKeyring(
                    env({ IDENTITY_ENCRYPTION_KEY: key, IDENTITY_ENCRYPTION_KEY_VERSION: '2', IDENTITY_ENCRYPTION_KEY_V2: b64Key() })
                )
            ),
            refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: key, IDENTITY_ENCRYPTION_KEY_FILE: '/x' })))
        ]
        for (const message of messages) expect(message).not.toContain(key)
    })
})

describe('loadKeyring — environment source', () => {
    it('loads one key as version 1, id "env", source env', () => {
        const key = b64Key()
        const ring = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: key }))
        const active = ring.getActive()
        expect(active).toMatchObject({ version: 1, keyId: 'env', source: KeySource.ENV })
        expect(active.material.equals(Buffer.from(key, 'base64'))).toBe(true)
        expect(ring.listVersions()).toEqual([1])
    })

    it('decodes base64 and hex to raw bytes, and takes anything else as a UTF-8 passphrase', () => {
        const raw = randomBytes(32)
        expect(
            loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: raw.toString('base64') }))
                .getActive()
                .material.equals(raw)
        ).toBe(true)
        expect(
            loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: raw.toString('hex') }))
                .getActive()
                .material.equals(raw)
        ).toBe(true)
        const passphrase = `${randomBytes(24).toString('hex')} with spaces!`
        expect(
            loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: passphrase }))
                .getActive()
                .material.toString('utf8')
        ).toBe(passphrase)
    })

    it('honours the declared id and version', () => {
        const ring = loadKeyring(
            env({ IDENTITY_ENCRYPTION_KEY: b64Key(), IDENTITY_ENCRYPTION_KEY_ID: 'kms-7', IDENTITY_ENCRYPTION_KEY_VERSION: '4' })
        )
        expect(ring.getActive()).toMatchObject({ version: 4, keyId: 'kms-7' })
    })

    it('keeps retired keys readable while writing only under the active one (rotation)', () => {
        const oldKey = b64Key()
        const newKey = b64Key()
        const ring = loadKeyring(
            env({
                IDENTITY_ENCRYPTION_KEY: newKey,
                IDENTITY_ENCRYPTION_KEY_VERSION: '2',
                IDENTITY_ENCRYPTION_KEY_V1: oldKey,
                IDENTITY_ENCRYPTION_KEY_V1_ID: 'old-id'
            })
        )
        expect(ring.listVersions()).toEqual([1, 2])
        expect(ring.getActive().version).toBe(2)
        expect(ring.getActive().material.equals(Buffer.from(newKey, 'base64'))).toBe(true)
        expect(ring.getByVersion(1)).toMatchObject({ version: 1, keyId: 'old-id' })
        expect(ring.getByVersion(1).material.equals(Buffer.from(oldKey, 'base64'))).toBe(true)
    })

    it('with only retired-style variables, the nominated version writes, else the newest', () => {
        const vars = { IDENTITY_ENCRYPTION_KEY_V1: b64Key(), IDENTITY_ENCRYPTION_KEY_V3: b64Key() }
        expect(loadKeyring(env(vars)).getActive().version).toBe(3)
        expect(loadKeyring(env({ ...vars, IDENTITY_ENCRYPTION_KEY_ACTIVE_VERSION: '1' })).getActive().version).toBe(1)
    })

    it('allows the same material declared twice for one version', () => {
        const key = b64Key()
        const ring = loadKeyring(
            env({ IDENTITY_ENCRYPTION_KEY: key, IDENTITY_ENCRYPTION_KEY_VERSION: '2', IDENTITY_ENCRYPTION_KEY_V2: key })
        )
        expect(ring.listVersions()).toEqual([2])
    })

    it('fails loudly, naming the version, for a row encrypted under a key it does not hold', () => {
        const ring = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: b64Key(), IDENTITY_ENCRYPTION_KEY_VERSION: '2' }))
        expect(refusal(() => ring.getByVersion(1))).toMatch(/no key material for version 1; retained versions are \[2\]/)
    })

    it('describes itself without any key material', () => {
        const key = b64Key()
        const ring = loadKeyring(
            env({ IDENTITY_ENCRYPTION_KEY: key, IDENTITY_ENCRYPTION_KEY_V1: b64Key(), IDENTITY_ENCRYPTION_KEY_VERSION: '2' })
        )
        const description = ring.describe()
        expect(description.activeVersion).toBe(2)
        expect(description.keys.map((k) => k.version)).toEqual([1, 2])
        for (const entry of description.keys) {
            expect(Object.keys(entry).sort()).toEqual(['fingerprint', 'keyId', 'source', 'version'])
            expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/)
        }
        const serialised = JSON.stringify(description)
        expect(serialised).not.toContain(key)
        expect(serialised).not.toContain(Buffer.from(key, 'base64').toString('hex'))
    })

    it('gives the same key the same fingerprint and different keys different ones', () => {
        const key = b64Key()
        const a = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: key })).getActive().fingerprint
        const b = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: key })).getActive().fingerprint
        const c = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY: b64Key() })).getActive().fingerprint
        expect(a).toBe(b)
        expect(a).not.toBe(c)
    })
})

describe('loadKeyring — key file source', () => {
    let dir: string
    const write = (name: string, contents: string, mode: number): string => {
        const file = path.join(dir, name)
        writeFileSync(file, contents)
        chmodSync(file, mode)
        return file
    }

    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'fw-keyring-'))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it.each([0o400, 0o600])('reads a single raw key from a file with mode %o', (mode) => {
        const key = b64Key()
        const ring = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: write('key', `${key}\n`, mode) }))
        expect(ring.getActive()).toMatchObject({ version: 1, keyId: 'file', source: KeySource.FILE })
        expect(ring.getActive().material.equals(Buffer.from(key, 'base64'))).toBe(true)
    })

    it.each([0o640, 0o644, 0o660, 0o604, 0o700])('refuses a key file with mode %o', (mode) => {
        const file = write('key', b64Key(), mode)
        const message = refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: file })))
        expect(message).toMatch(/must be 0400 or 0600/)
    })

    it('refuses a key file that does not exist, naming the path and not a key', () => {
        const missing = path.join(dir, 'absent')
        expect(refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: missing })))).toMatch(/cannot be read: ENOENT/)
    })

    it('reads a multi-key JSON file; the flagged key writes', () => {
        const [k1, k2] = [b64Key(), b64Key()]
        const file = write(
            'keys.json',
            JSON.stringify({
                keys: [
                    { version: 1, material: k1, active: true },
                    { version: 2, keyId: 'second', material: k2 }
                ]
            }),
            0o400
        )
        const ring = loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: file }))
        expect(ring.listVersions()).toEqual([1, 2])
        expect(ring.getActive().version).toBe(1)
        expect(ring.getByVersion(2)).toMatchObject({ keyId: 'second', source: KeySource.FILE })
    })

    it('with no key flagged active, the highest version writes', () => {
        const file = write(
            'keys.json',
            JSON.stringify({
                keys: [
                    { version: 1, material: b64Key() },
                    { version: 5, material: b64Key() }
                ]
            }),
            0o400
        )
        expect(loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: file })).getActive().version).toBe(5)
    })

    it('refuses a JSON key file with two keys flagged active, or with no keys', () => {
        const two = write(
            'two.json',
            JSON.stringify({
                keys: [
                    { version: 1, material: b64Key(), active: true },
                    { version: 2, material: b64Key(), active: true }
                ]
            }),
            0o400
        )
        expect(refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: two })))).toMatch(/marks 2 keys active/)
        const none = write('none.json', JSON.stringify({ keys: [] }), 0o400)
        expect(refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: none })))).toMatch(/no non-empty 'keys' array/)
    })

    it('refuses a published example value arriving through a file', () => {
        const file = write('key', PUBLISHED_EXAMPLE_SECRETS[0], 0o400)
        expect(refusal(() => loadKeyring(env({ IDENTITY_ENCRYPTION_KEY_FILE: file })))).toMatch(/published example value/)
    })
})

describe('getKeyring — process-wide cache', () => {
    const saved = { ...process.env }
    afterEach(() => {
        process.env = { ...saved }
        resetKeyring()
    })

    it('loads once and keeps serving that keyring until reset', () => {
        resetKeyring()
        const first = b64Key()
        process.env.IDENTITY_ENCRYPTION_KEY = first
        delete process.env.IDENTITY_ENCRYPTION_KEY_FILE
        const ring = getKeyring()
        process.env.IDENTITY_ENCRYPTION_KEY = b64Key()
        expect(getKeyring()).toBe(ring)
        expect(getKeyring().getActive().material.equals(Buffer.from(first, 'base64'))).toBe(true)
        resetKeyring()
        expect(getKeyring()).not.toBe(ring)
    })
})
