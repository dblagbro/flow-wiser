import { assertPublicFlowHasNoCodeNode, scanForCodeExecutionNodes } from './codeNodeGuard'

/**
 * Regression tests for the publish guard (security assessment 2026-08-07, recommendation 2).
 *
 * These exist because the versioning and sandbox work shipped with no tests at all, and the defects
 * found there — a path traversal, a fail-open auth check — were exactly the kind a test pins down
 * permanently. Every case below is either a payload from the assessment or a way the guard could
 * silently stop protecting.
 */

const flow = (nodes: unknown[]): string => JSON.stringify({ nodes, edges: [] })

describe('scanForCodeExecutionNodes', () => {
    it('finds a customFunction node by name', () => {
        const scan = scanForCodeExecutionNodes(flow([{ id: 'n1', data: { name: 'customFunction', label: 'My Function' } }]))
        expect(scan.found).toBe(true)
        expect(scan.nodes).toEqual(['My Function'])
    })

    it.each(['customTool', 'customMCP', 'customDocumentLoader', 'codeInterpreter'])('finds %s', (name) => {
        expect(scanForCodeExecutionNodes(flow([{ id: 'n', data: { name } }])).found).toBe(true)
    })

    it('is case-insensitive — node naming is not consistent across the shipped set', () => {
        expect(scanForCodeExecutionNodes(flow([{ id: 'n', data: { name: 'CustomFunction' } }])).found).toBe(true)
        expect(scanForCodeExecutionNodes(flow([{ id: 'n', data: { type: 'CUSTOMTOOL' } }])).found).toBe(true)
    })

    /**
     * The secondary signal. This is what catches a code node type that did not exist when
     * CODE_EXECUTION_NODE_MARKERS was written — the failure mode an exact allowlist guarantees.
     */
    it('finds an unknown node type carrying a non-empty code field', () => {
        const scan = scanForCodeExecutionNodes(
            flow([{ id: 'n1', data: { name: 'someFutureNode', label: 'Future', inputs: { javascriptFunction: 'return 1' } } }])
        )
        expect(scan.found).toBe(true)
    })

    it('does NOT flag an empty code field — an unconfigured node executes nothing', () => {
        expect(scanForCodeExecutionNodes(flow([{ id: 'n', data: { name: 'plain', inputs: { code: '   ' } } }])).found).toBe(false)
    })

    it('does not flag ordinary nodes', () => {
        const scan = scanForCodeExecutionNodes(
            flow([
                { id: 'n1', data: { name: 'chatOpenAI', label: 'ChatGPT' } },
                { id: 'n2', data: { name: 'pineconeStore', inputs: { topK: 4 } } }
            ])
        )
        expect(scan.found).toBe(false)
    })

    it('treats unparseable or empty flowData as "no code node" rather than throwing', () => {
        // A malformed flow cannot execute either. Turning a broken save into a security error
        // would misattribute the problem.
        expect(scanForCodeExecutionNodes('not json').found).toBe(false)
        expect(scanForCodeExecutionNodes('').found).toBe(false)
        expect(scanForCodeExecutionNodes(null).found).toBe(false)
        expect(scanForCodeExecutionNodes(JSON.stringify({ nodes: 'not-an-array' })).found).toBe(false)
    })
})

describe('assertPublicFlowHasNoCodeNode', () => {
    const codeFlow = flow([{ id: 'n1', data: { name: 'customFunction', label: 'Runs Code' } }])
    const plainFlow = flow([{ id: 'n1', data: { name: 'chatOpenAI' } }])

    it('throws when publishing a flow containing a code node', () => {
        expect(() => assertPublicFlowHasNoCodeNode(true, codeFlow)).toThrow(/cannot be made public/i)
    })

    it('names the offending node so the operator can act on it', () => {
        expect(() => assertPublicFlowHasNoCodeNode(true, codeFlow)).toThrow(/Runs Code/)
    })

    it.each([['string true', 'true'], ['numeric 1', 1]])('catches a truthy %s from a JSON body', (_label, value) => {
        // The body arrives over HTTP; isPublic is not guaranteed to be a real boolean.
        expect(() => assertPublicFlowHasNoCodeNode(value, codeFlow)).toThrow(/cannot be made public/i)
    })

    it('allows publishing a flow with no code node', () => {
        expect(() => assertPublicFlowHasNoCodeNode(true, plainFlow)).not.toThrow()
    })

    it('leaves PRIVATE flows with code nodes alone — the risk is the combination', () => {
        expect(() => assertPublicFlowHasNoCodeNode(false, codeFlow)).not.toThrow()
        expect(() => assertPublicFlowHasNoCodeNode(undefined, codeFlow)).not.toThrow()
        expect(() => assertPublicFlowHasNoCodeNode(0, codeFlow)).not.toThrow()
    })
})
