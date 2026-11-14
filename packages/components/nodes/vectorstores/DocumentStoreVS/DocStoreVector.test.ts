/**
 * The Document Store vector node must be connectable wherever a vector store retriever is accepted.
 *
 * Eight node inputs across the library ask for a `VectorStoreRetriever`. Every other vector store
 * node offers one from its Retriever output; this node offered only `BaseRetriever`, so the canvas
 * refused the connection.
 */
jest.mock('../../../src/utils', () => ({
    getBaseClasses: () => [],
    getCredentialData: jest.fn(),
    getCredentialParam: jest.fn()
}))

const { nodeClass: DocStoreVector } = require('./DocStoreVector')

describe('Document Store (Vector) node', () => {
    const node = new DocStoreVector()
    const output = (name: string) => node.outputs.find((entry: { name: string }) => entry.name === name)

    it('offers its Retriever output as a VectorStoreRetriever as well as a BaseRetriever', () => {
        expect(output('retriever').baseClasses).toEqual(expect.arrayContaining(['VectorStoreRetriever', 'BaseRetriever']))
    })

    it('declares the same retriever base classes on the node as the other vector stores do', () => {
        expect(node.baseClasses).toEqual([node.type, 'VectorStoreRetriever', 'BaseRetriever'])
    })

    it('leaves the Vector Store output as it was', () => {
        expect(output('vectorStore').baseClasses).toEqual(['VectorStore'])
    })

    it('keeps its name and type, which saved flows refer to', () => {
        expect(node.name).toBe('documentStoreVS')
        expect(node.type).toBe('DocumentStoreVS')
    })
})
