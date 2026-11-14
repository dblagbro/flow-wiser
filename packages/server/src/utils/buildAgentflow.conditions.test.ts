/**
 * Condition branching — which nodes are skipped after a decision node (upstream #6532).
 *
 * One condition output can be wired to several nodes. `determineNodesToIgnore` used `edges.find`,
 * so when that output was not taken only the FIRST node wired to it was skipped and the others ran
 * anyway — work from a branch the condition had rejected.
 */
import { determineNodesToIgnore } from './buildAgentflow'

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

const decisionNode = (name = 'conditionAgentflow') => ({ id: 'cond_0', data: { name } } as never)
const edge = (outputIndex: number, target: string) =>
    ({
        id: `e-${outputIndex}-${target}`,
        source: 'cond_0',
        sourceHandle: `cond_0-output-${outputIndex}`,
        target,
        targetHandle: `${target}-input`
    } as never)
const conditions = (...fulfilled: (boolean | undefined)[]) => ({
    output: { conditions: fulfilled.map((isFulfilled) => (isFulfilled === undefined ? {} : { isFulfilled })) }
})

describe('determineNodesToIgnore', () => {
    it('skips EVERY node wired to an output that was not taken', async () => {
        const edges = [edge(0, 'a1'), edge(0, 'a2'), edge(0, 'a3'), edge(1, 'b1')]
        const ignored = await determineNodesToIgnore(decisionNode(), conditions(false, true), edges, 'cond_0')
        expect(ignored.sort()).toEqual(['a1', 'a2', 'a3'])
    })

    it('skips nothing on the output that was taken, however many nodes it feeds', async () => {
        const edges = [edge(0, 'a1'), edge(0, 'a2'), edge(1, 'b1'), edge(1, 'b2')]
        const ignored = await determineNodesToIgnore(decisionNode(), conditions(true, false), edges, 'cond_0')
        expect(ignored.sort()).toEqual(['b1', 'b2'])
    })

    it('treats a condition with no isFulfilled as not taken', async () => {
        const edges = [edge(0, 'a1'), edge(1, 'b1'), edge(1, 'b2')]
        const ignored = await determineNodesToIgnore(decisionNode(), conditions(true, undefined), edges, 'cond_0')
        expect(ignored.sort()).toEqual(['b1', 'b2'])
    })

    it('falls back to the last condition when none was fulfilled, so one branch always runs', async () => {
        const edges = [edge(0, 'a1'), edge(0, 'a2'), edge(1, 'else1'), edge(1, 'else2')]
        const ignored = await determineNodesToIgnore(decisionNode(), conditions(false, false), edges, 'cond_0')
        expect(ignored.sort()).toEqual(['a1', 'a2'])
    })

    it('ignores edges from other nodes that happen to share an output index', async () => {
        const other = { id: 'x', source: 'cond_1', sourceHandle: 'cond_1-output-0', target: 'other', targetHandle: 'other-input' } as never
        const ignored = await determineNodesToIgnore(decisionNode(), conditions(false, true), [edge(0, 'a1'), other], 'cond_0')
        expect(ignored).toEqual(['a1'])
    })

    it.each(['conditionAgentAgentflow', 'humanInputAgentflow'])('applies to %s as well', async (name) => {
        const ignored = await determineNodesToIgnore(decisionNode(name), conditions(false, true), [edge(0, 'a1'), edge(0, 'a2')], 'cond_0')
        expect(ignored.sort()).toEqual(['a1', 'a2'])
    })

    it('skips nothing for a node that is not a decision node', async () => {
        const ignored = await determineNodesToIgnore(decisionNode('llmAgentflow'), conditions(false, true), [edge(0, 'a1')], 'cond_0')
        expect(ignored).toEqual([])
    })
})
