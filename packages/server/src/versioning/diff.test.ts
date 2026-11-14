/**
 * Versioning — diff tests (I-03).
 *
 * Covers the line diff, the size guard's wholesale-replacement fallback, word-level segments on long
 * same-key lines, the prompt-focused filter and the unified-text rendering.
 */
import { diffText, diffWords, filterToPromptChanges, toUnifiedText } from './diff'
import { normaliseFlowData } from './normalise'

const lines = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n') + '\n'

describe('diffText', () => {
    it('reports byte-identical inputs as identical, with no hunks', () => {
        expect(diffText('a\nb\n', 'a\nb\n')).toEqual({ hunks: [], added: 0, removed: 0, identical: true })
    })

    it('reports a one-line edit as exactly one removal and one addition, with correct line numbers', () => {
        const result = diffText('a\nb\nc\n', 'a\nB\nc\n')
        expect(result.identical).toBe(false)
        expect(result.added).toBe(1)
        expect(result.removed).toBe(1)
        expect(result.hunks).toHaveLength(1)
        const changed = result.hunks[0].lines.filter((l) => l.op !== 'context')
        expect(changed).toEqual([
            { op: 'remove', oldLine: 2, newLine: null, text: 'b' },
            { op: 'add', oldLine: null, newLine: 2, text: 'B' }
        ])
    })

    it('handles pure insertion and pure deletion, including from/to empty', () => {
        expect(diffText('', 'a\nb\n')).toMatchObject({ added: 2, removed: 0, identical: false })
        expect(diffText('a\nb\n', '')).toMatchObject({ added: 0, removed: 2, identical: false })
        expect(diffText('a\nc\n', 'a\nb\nc\n')).toMatchObject({ added: 1, removed: 0 })
    })

    it('limits context and splits distant changes into separate hunks', () => {
        const before = lines(40, 'L')
        const after = before.replace('L5\n', 'X5\n').replace('L30\n', 'X30\n')
        const result = diffText(before, after, 2)
        expect(result.hunks).toHaveLength(2)
        expect(result.hunks[0].lines).toHaveLength(6) // 2 context + remove + add + 2 context
        expect(result.hunks[0].oldStart).toBe(4)
        expect(diffText(before, after, 0).hunks.every((h) => h.lines.every((l) => l.op !== 'context'))).toBe(true)
    })

    it('applying the diff to the old text reproduces the new text', () => {
        const before = normaliseFlowData(
            JSON.stringify({
                nodes: [
                    { id: 'a', v: 1 },
                    { id: 'b', v: 2 }
                ],
                edges: [],
                name: 'x'
            })
        )
        const after = normaliseFlowData(
            JSON.stringify({
                nodes: [
                    { id: 'a', v: 9 },
                    { id: 'c', v: 3 }
                ],
                edges: [1],
                name: 'x'
            })
        )
        const all = diffText(before, after, Number.MAX_SAFE_INTEGER)
        const rebuilt = all.hunks.flatMap((h) => h.lines.filter((l) => l.op !== 'remove').map((l) => l.text)).join('\n') + '\n'
        expect(rebuilt).toBe(after)
    })

    it('falls back to a wholesale replacement past the size guard instead of allocating the table', () => {
        const before = lines(2100, 'old-')
        const after = lines(2100, 'new-')
        const result = diffText(before, after, 0)
        expect(result.removed).toBe(2100)
        expect(result.added).toBe(2100)
    })

    it('attaches word-level segments to a long remove/add pair on the same key', () => {
        const filler = 'word '.repeat(40)
        const before = `{\n  "systemMessagePrompt": "${filler}alpha beta"\n}\n`
        const after = `{\n  "systemMessagePrompt": "${filler}alpha gamma"\n}\n`
        const [removed, added] = diffText(before, after).hunks[0].lines.filter((l) => l.op !== 'context')
        expect(removed.segments).toBeDefined()
        expect(added.segments).toBeDefined()
        expect(removed.segments!.map((s) => s.text).join('')).toBe(removed.text)
        expect(added.segments!.map((s) => s.text).join('')).toBe(added.text)
        expect(removed.segments!.some((s) => s.op === 'remove' && s.text.includes('beta'))).toBe(true)
        expect(added.segments!.some((s) => s.op === 'add' && s.text.includes('gamma'))).toBe(true)
    })

    it('does not attach segments to short lines or to pairs on different keys', () => {
        const short = diffText('{\n  "a": "x"\n}\n', '{\n  "a": "y"\n}\n').hunks[0].lines
        expect(short.every((l) => l.segments === undefined)).toBe(true)
        const filler = 'word '.repeat(40)
        const other = diffText(`{\n  "a": "${filler}"\n}\n`, `{\n  "b": "${filler}"\n}\n`).hunks[0].lines
        expect(other.every((l) => l.segments === undefined)).toBe(true)
    })
})

describe('diffWords', () => {
    it('reassembles to both inputs exactly, preserving whitespace', () => {
        const a = 'the  quick brown\\nfox'
        const b = 'the  slow brown\\nfox jumps'
        const segments = diffWords(a, b)!
        expect(
            segments
                .filter((s) => s.op !== 'add')
                .map((s) => s.text)
                .join('')
        ).toBe(a)
        expect(
            segments
                .filter((s) => s.op !== 'remove')
                .map((s) => s.text)
                .join('')
        ).toBe(b)
    })

    it('declines (undefined) past the token guard so the caller keeps the plain line diff', () => {
        expect(diffWords('a '.repeat(2500), 'b')).toBeUndefined()
    })
})

describe('filterToPromptChanges', () => {
    const before = normaliseFlowData(JSON.stringify({ modelName: 'm1', systemMessagePrompt: 'be brief', temperature: 0.1 }))

    it('keeps only changes inside prompt/template fields', () => {
        const after = normaliseFlowData(JSON.stringify({ modelName: 'm2', systemMessagePrompt: 'be thorough', temperature: 0.9 }))
        const full = diffText(before, after)
        expect(full.added).toBe(3)
        const filtered = filterToPromptChanges(full)
        expect(filtered.added).toBe(1)
        expect(filtered.removed).toBe(1)
        expect(filtered.identical).toBe(false)
        expect(filtered.hunks.flatMap((h) => h.lines).every((l) => l.text.includes('systemMessagePrompt'))).toBe(true)
    })

    it('reports identical when no prompt field changed', () => {
        const after = normaliseFlowData(JSON.stringify({ modelName: 'm2', systemMessagePrompt: 'be brief', temperature: 0.1 }))
        expect(filterToPromptChanges(diffText(before, after))).toMatchObject({ hunks: [], added: 0, removed: 0, identical: true })
    })
})

describe('toUnifiedText', () => {
    it('is empty for identical inputs', () => {
        expect(toUnifiedText(diffText('a\n', 'a\n'))).toBe('')
    })

    it('renders headers, hunk ranges and prefixed lines', () => {
        expect(toUnifiedText(diffText('a\nb\nc\n', 'a\nB\nc\n'), 'old', 'new')).toBe(
            ['--- old', '+++ new', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n')
        )
    })
})
