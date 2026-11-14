/**
 * The Tavily tool must hand the credential's key to the library under the name the library reads.
 *
 * It used to pass `apiKey`. `@langchain/tavily` reads `tavilyApiKey` and ignores anything else, so
 * the key saved in the credential was silently dropped and the tool fell back to whatever
 * `TAVILY_API_KEY` happened to be in the server's environment — or failed with no key at all.
 */
const constructed: Record<string, unknown>[] = []

jest.mock('@langchain/tavily', () => ({
    TavilySearch: jest.fn().mockImplementation((config: Record<string, unknown>) => {
        constructed.push(config)
        return { config }
    })
}))

jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => ['Tool'],
    getCredentialData: jest.fn(async () => ({ tavilyApiKey: 'key-from-the-credential' })),
    getCredentialParam: (name: string, data: Record<string, unknown>) => data[name]
}))

const { nodeClass: TavilyTool } = require('./TavilyAPI')

describe('Tavily tool', () => {
    beforeEach(() => {
        constructed.length = 0
    })

    it('passes the credential key as tavilyApiKey, the only name the library reads', async () => {
        await new TavilyTool().init({ credential: 'cred-1', inputs: {} }, '', {})
        expect(constructed).toHaveLength(1)
        expect(constructed[0].tavilyApiKey).toBe('key-from-the-credential')
    })

    it('does not pass the key under a name the library ignores', async () => {
        await new TavilyTool().init({ credential: 'cred-1', inputs: {} }, '', {})
        expect(constructed[0]).not.toHaveProperty('apiKey')
    })

    it('splits and trims domain lists and leaves unset options out', async () => {
        await new TavilyTool().init({ credential: 'cred-1', inputs: { includeDomains: 'a.example, b.example ', maxResults: 3 } }, '', {})
        expect(constructed[0]).toMatchObject({ includeDomains: ['a.example', 'b.example'], maxResults: 3 })
        expect(constructed[0]).not.toHaveProperty('excludeDomains')
        expect(constructed[0]).not.toHaveProperty('timeRange')
    })
})
