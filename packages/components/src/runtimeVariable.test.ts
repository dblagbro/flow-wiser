import { resolveRuntimeVariable } from './utils'

/**
 * N6 (assessment retest 2026-08-07) — runtime variables resolved ARBITRARY `process.env` by a
 * user-chosen name, and the result is injected into code nodes and prompt templates. Gated only on
 * `variables:create`, which `org-admin` and `user` both hold — so any authoring user could read the
 * token-signing secret and forge tokens for any tenant.
 */
describe('resolveRuntimeVariable', () => {
    const saved = { ...process.env }
    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => {})
        delete process.env.FLOWISE_VAR_ALLOW_UNPREFIXED
    })
    afterEach(() => {
        process.env = { ...saved }
        jest.restoreAllMocks()
    })

    it('reads a deliberately exported prefixed variable', () => {
        process.env.FLOWISE_VAR_GREETING = 'hello'
        expect(resolveRuntimeVariable('GREETING')).toBe('hello')
    })

    it('REFUSES to read a host secret by its real name', () => {
        process.env.JWT_AUTH_TOKEN_SECRET = 'super-secret-signing-key'
        expect(resolveRuntimeVariable('JWT_AUTH_TOKEN_SECRET')).toBe('')
    })

    it.each(['IDENTITY_ENCRYPTION_KEY', 'FLOWISE_SECRETKEY_OVERWRITE', 'E2B_APIKEY', 'FLOWISE_SESSION_PEPPER'])(
        'refuses %s — the exact exfiltration the finding described',
        (secret) => {
            process.env[secret] = 'the-actual-secret'
            expect(resolveRuntimeVariable(secret)).toBe('')
        }
    )

    it('returns empty for an unknown name rather than throwing', () => {
        // A missing runtime variable has always resolved to ''; a flow referencing one must not
        // start failing differently because of this change.
        expect(resolveRuntimeVariable('NOT_SET_ANYWHERE')).toBe('')
    })

    it('prefers the prefixed value when both exist', () => {
        process.env.PATH_TO_THING = 'unprefixed'
        process.env.FLOWISE_VAR_PATH_TO_THING = 'prefixed'
        expect(resolveRuntimeVariable('PATH_TO_THING')).toBe('prefixed')
    })

    describe('the escape hatch', () => {
        it('restores the old behaviour only when set to exactly "true", and warns', () => {
            process.env.FLOWISE_VAR_ALLOW_UNPREFIXED = 'true'
            process.env.JWT_AUTH_TOKEN_SECRET = 'leaked'
            expect(resolveRuntimeVariable('JWT_AUTH_TOKEN_SECRET')).toBe('leaked')
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('multi-user'))
        })

        it('is not enabled by a truthy-looking value', () => {
            process.env.FLOWISE_VAR_ALLOW_UNPREFIXED = '1'
            process.env.JWT_AUTH_TOKEN_SECRET = 'leaked'
            expect(resolveRuntimeVariable('JWT_AUTH_TOKEN_SECRET')).toBe('')
        })
    })
})
