/**
 * A node's live `instance` must survive variable resolution intact.
 *
 * `resolveVariables` works on a deep copy of the node's data. That copy used to include the node's
 * already-built `instance` — an SDK client, a vector store, a gRPC channel. A deep copy of such an
 * object has the right prototype but was never constructed, so anything it keeps in a private field
 * is simply not there: the OpenAI client threw "Cannot read private member from an object whose
 * class did not declare it" and every chatflow using OpenAI embeddings failed with a 500.
 */
import { INodeData } from '../Interface'
import { resolveVariables } from '.'

/** Stands in for an SDK client: state in a private field, reachable only through a method. */
class LiveClient {
    #baseUrl: string
    constructor(baseUrl: string) {
        this.#baseUrl = baseUrl
    }
    buildUrl(path: string): string {
        return `${this.#baseUrl}${path}`
    }
}

const nodeData = (instance: unknown): INodeData =>
    ({
        id: 'embeddings_0',
        label: 'Embeddings',
        name: 'embeddings',
        type: 'Embeddings',
        inputs: { modelName: 'text-embedding-3-small', nested: { list: [1, 2, 3] } },
        inputParams: [{ name: 'modelName', type: 'string', label: 'Model' }],
        outputs: {},
        instance
    } as unknown as INodeData)

describe('resolveVariables and a live node instance', () => {
    // NEGATIVE test: the original failure, reproduced with a class that has a private field.
    it('returns an instance whose private state still works', async () => {
        const client = new LiveClient('https://api.example.test')
        const resolved = await resolveVariables(nodeData(client), [], 'question', [])
        expect(() => resolved.instance.buildUrl('/v1/embeddings')).not.toThrow()
        expect(resolved.instance.buildUrl('/v1/embeddings')).toBe('https://api.example.test/v1/embeddings')
    })

    it('hands back the very same instance rather than a copy', async () => {
        const client = new LiveClient('https://api.example.test')
        const resolved = await resolveVariables(nodeData(client), [], 'question', [])
        expect(resolved.instance).toBe(client)
    })

    it("still copies everything else, so the caller's node data is not modified", async () => {
        const original = nodeData(new LiveClient('https://api.example.test'))
        const resolved = await resolveVariables(original, [], 'question', [])
        expect(resolved).not.toBe(original)
        expect(resolved.inputs).not.toBe(original.inputs)
        expect(resolved.inputs).toEqual(original.inputs)
        ;(resolved.inputs as Record<string, any>).nested.list.push(4)
        expect((original.inputs as Record<string, any>).nested.list).toEqual([1, 2, 3])
    })

    it('adds no instance where there was none', async () => {
        const original = nodeData(undefined)
        delete (original as unknown as Record<string, unknown>).instance
        const resolved = await resolveVariables(original, [], 'question', [])
        expect('instance' in resolved).toBe(false)
    })

    it('keeps an instance that is explicitly null', async () => {
        const resolved = await resolveVariables(nodeData(null), [], 'question', [])
        expect(resolved.instance).toBeNull()
    })
})
