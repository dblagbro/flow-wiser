/**
 * An OpenAI embedding requested as base64 must still reach the vector store as numbers.
 *
 * The OpenAI SDK decodes base64 embeddings only when it chose that format itself. When the node's
 * "Encoding Format" is set to base64, the SDK hands back the raw base64 string and LangChain passes
 * it straight through — so the vector store received a string where it expected an array of
 * numbers and failed ("e.every is not a function" from Chroma).
 *
 * Both OpenAI embedding nodes carry the same decode step, so both are tested here.
 */

/** A stand-in for LangChain's class: returns what the real one returns for each format. */
class FakeOpenAIEmbeddings {
    encodingFormat?: string
    constructor(fields: { encodingFormat?: string }) {
        this.encodingFormat = fields.encodingFormat
    }
    async embedDocuments(texts: string[]): Promise<unknown[]> {
        return texts.map((text) => (this.encodingFormat === 'base64' ? encode(vectorFor(text)) : vectorFor(text)))
    }
    async embedQuery(text: string): Promise<unknown> {
        return this.encodingFormat === 'base64' ? encode(vectorFor(text)) : vectorFor(text)
    }
}

jest.mock('@langchain/openai', () => ({ OpenAIEmbeddings: FakeOpenAIEmbeddings }))
jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => ['Embeddings'],
    getCredentialData: jest.fn(async () => ({})),
    getCredentialParam: () => 'not-a-real-key'
}))
jest.mock('../../../src/modelLoader', () => ({ MODEL_TYPE: { EMBEDDING: 'embedding' }, getModels: jest.fn() }))

/** A deterministic vector of float32-representable values; its length varies with the text. */
function vectorFor(text: string): number[] {
    return Array.from({ length: 3 + (text.length % 5) }, (_, index) => Math.fround((text.length + index) / 7))
}

/** What the API sends for base64: the little-endian float32 bytes of the vector. */
function encode(vector: number[]): string {
    return Buffer.from(new Float32Array(vector).buffer).toString('base64')
}

const nodes: [string, string][] = [
    ['OpenAI Embeddings', './OpenAIEmbedding'],
    ['OpenAI Embeddings Custom', '../OpenAIEmbeddingCustom/OpenAIEmbeddingCustom']
]

describe.each(nodes)('%s node with a base64 encoding format', (_label, modulePath) => {
    const build = async (encodingFormat?: string) => {
        const { nodeClass: Node } = require(modulePath)
        return await new Node().init({ inputs: { modelName: 'text-embedding-3-small', encodingFormat } }, '', {})
    }

    // NEGATIVE test: the original failure was a string arriving where numbers were expected.
    it('returns numbers, not a base64 string, from embedQuery', async () => {
        const model = await build('base64')
        const embedding = await model.embedQuery('hello')
        expect(Array.isArray(embedding)).toBe(true)
        expect(embedding).toEqual(vectorFor('hello'))
    })

    it('returns an array of number arrays from embedDocuments', async () => {
        const model = await build('base64')
        const texts = ['a', 'bb', 'ccc']
        const embeddings = await model.embedDocuments(texts)
        expect(embeddings).toEqual(texts.map(vectorFor))
        expect(embeddings.every((embedding: unknown[]) => embedding.every((value) => typeof value === 'number'))).toBe(true)
    })

    // Vectors of many lengths, decoded one after another. (The patch also copies the bytes before
    // reading them as float32, as a guard against a misaligned buffer. Node keeps the buffers this
    // code creates aligned, so that guard cannot be made to fail from here and is not what this
    // case proves.)
    it('decodes vectors of many different lengths', async () => {
        const model = await build('base64')
        for (let length = 1; length <= 60; length++) {
            const text = 'x'.repeat(length)
            expect(await model.embedQuery(text)).toEqual(vectorFor(text))
        }
    })

    it.each([undefined, 'float'])('leaves a %s response exactly as LangChain returned it', async (format) => {
        const model = await build(format)
        expect(await model.embedQuery('hello')).toEqual(vectorFor('hello'))
        expect(await model.embedDocuments(['a'])).toEqual([vectorFor('a')])
    })
})
