/**
 * Versioning — normalisation tests (I-03).
 *
 * `normaliseFlowData` is what makes "no commit when nothing changed" and line-level diffs possible,
 * so its two guarantees — indented and key-ordered — are asserted directly, along with the two
 * deliberate non-behaviours: invalid JSON is kept verbatim, and embedded JSON strings are not rewritten.
 */
import { isPromptField, normaliseFlowData, normaliseJson } from './normalise'

describe('normaliseFlowData', () => {
    it('returns an empty string for null, undefined and empty input', () => {
        expect(normaliseFlowData(null)).toBe('')
        expect(normaliseFlowData(undefined)).toBe('')
        expect(normaliseFlowData('')).toBe('')
    })

    it('emits indented, newline-terminated JSON', () => {
        expect(normaliseFlowData('{"a":1}')).toBe('{\n  "a": 1\n}\n')
    })

    it('is independent of key insertion order, at every depth', () => {
        const one = normaliseFlowData('{"b":{"y":1,"x":2},"a":[{"k2":1,"k1":2}]}')
        const two = normaliseFlowData('{"a":[{"k1":2,"k2":1}],"b":{"x":2,"y":1}}')
        expect(one).toBe(two)
    })

    it('preserves array order, which is meaningful', () => {
        expect(normaliseFlowData('{"n":[3,1,2]}')).not.toBe(normaliseFlowData('{"n":[1,2,3]}'))
        expect(JSON.parse(normaliseFlowData('{"n":[3,1,2]}')).n).toEqual([3, 1, 2])
    })

    it('is idempotent', () => {
        const once = normaliseFlowData('{"z":1,"a":{"c":[1,{"b":2,"a":1}]}}')
        expect(normaliseFlowData(once)).toBe(once)
    })

    it('stores invalid JSON verbatim rather than rejecting it', () => {
        const broken = '{"nodes": [ this is not json'
        expect(normaliseFlowData(broken)).toBe(broken)
    })

    it('does not parse or re-serialise JSON embedded in a string value', () => {
        const embedded = '{"b":1,   "a":2}'
        const out = normaliseFlowData(JSON.stringify({ inputs: { config: embedded } }))
        expect(JSON.parse(out).inputs.config).toBe(embedded)
    })

    it('round-trips to the same data (restore reads this file back)', () => {
        const data = { nodes: [{ id: 'n1', data: { prompt: 'line one\nline two', n: 1.5, t: true, z: null } }], edges: [] }
        expect(JSON.parse(normaliseFlowData(JSON.stringify(data)))).toEqual(data)
    })
})

describe('normaliseJson', () => {
    it('sorts keys so the metadata sidecar diffs cleanly', () => {
        expect(normaliseJson({ b: 1, a: 2 })).toBe(normaliseJson({ a: 2, b: 1 }))
        expect(normaliseJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n')
    })
})

describe('isPromptField', () => {
    it.each(['systemMessagePrompt', 'chatPromptTemplate', 'humanMessage', 'SYSTEMMESSAGE', 'promptValues', 'instructions'])(
        'matches %s',
        (name) => expect(isPromptField(name)).toBe(true)
    )

    it.each(['modelName', 'temperature', 'id', 'position'])('does not match %s', (name) => expect(isPromptField(name)).toBe(false))
})
