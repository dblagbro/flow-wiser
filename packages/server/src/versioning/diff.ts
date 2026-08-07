import { isPromptField } from './normalise'

/**
 * Versioning — line diff, and the prompt-focused view (REQUIREMENTS-VERSIONING.md §4, §7).
 *
 * Implemented here rather than pulled in as a dependency. The whole job is a line-level diff over
 * two strings we control the shape of — `normalise.ts` guarantees indented, key-sorted, newline
 * terminated output — and that is a well-understood algorithm in under a hundred lines. Adding a
 * package to the server's dependency surface for it would be a poor trade in a project whose
 * headline property is that every file in it is Apache 2.0 and auditable.
 *
 * Myers-style LCS over lines, computed on the middle section after common prefix and suffix are
 * stripped. Stripping matters at this scale: two versions of a 331 KB flow that differ in one
 * prompt share nearly every line, so the quadratic table is built over a handful of lines rather
 * than tens of thousands.
 */

export type DiffOp = 'context' | 'add' | 'remove'

export interface DiffLine {
    op: DiffOp
    /** 1-based line number in the OLD text; null for an added line. */
    oldLine: number | null
    /** 1-based line number in the NEW text; null for a removed line. */
    newLine: number | null
    text: string
    /**
     * Word-level segments, present only on a remove/add PAIR that changed the same JSON key.
     *
     * ── Why this exists ──────────────────────────────────────────────────────────────────────
     *
     * The requirements promise "editing one system prompt produces a diff of exactly the changed
     * lines". `JSON.stringify` escapes newlines INSIDE string values, so an 11,649-character
     * multi-line prompt is one single line of normalised JSON. Editing two sentences therefore
     * produced one enormous removed line and one enormous added line — technically a correct diff,
     * and useless for the question actually being asked, which is *which words changed*.
     *
     * Emitting real newlines inside the string was the obvious alternative and is wrong: it makes
     * the file invalid JSON, and restore reads that file straight back into `flowData`.
     *
     * So the line stays intact and carries a word-level breakdown alongside it. The renderer can
     * highlight the changed words in place; anything that ignores the field still sees a correct
     * line diff.
     */
    segments?: WordSegment[]
}

export interface WordSegment {
    op: DiffOp
    text: string
}

export interface DiffHunk {
    oldStart: number
    newStart: number
    lines: DiffLine[]
}

export interface DiffResult {
    hunks: DiffHunk[]
    added: number
    removed: number
    /** True when the two inputs are byte-identical. */
    identical: boolean
}

const splitLines = (text: string): string[] => (text.length === 0 ? [] : text.replace(/\n$/, '').split('\n'))

/**
 * Longest common subsequence over the reduced middle section.
 *
 * Guarded by size: a pathological pair (two flows sharing almost no lines, each tens of thousands
 * of lines long) would otherwise allocate a table with hundreds of millions of cells and take the
 * process down. Past the guard the two sides are reported as a wholesale replacement, which is both
 * honest and what a human would conclude anyway.
 */
const MAX_LCS_CELLS = 4_000_000

const lcsTable = (a: string[], b: string[]): number[][] | null => {
    if (a.length * b.length > MAX_LCS_CELLS) return null
    const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
        }
    }
    return table
}

/**
 * Word-level diff of two single lines, for the long-string case described on `DiffLine.segments`.
 *
 * Splits on whitespace boundaries while KEEPING the separators, so reassembling the segments
 * reproduces the input exactly and a renderer can show the original spacing. Escaped newlines
 * (`\n` as two characters, which is how a multi-line prompt appears here) are treated as their own
 * token, so a paragraph inserted mid-prompt reads as an insertion rather than as a change to the
 * words on either side of it.
 */
const WORD_SPLIT = /(\\n|\s+)/
const MAX_WORD_TOKENS = 4000

export const diffWords = (oldLine: string, newLine: string): WordSegment[] | undefined => {
    const a = oldLine.split(WORD_SPLIT).filter((t) => t.length > 0)
    const b = newLine.split(WORD_SPLIT).filter((t) => t.length > 0)
    // Beyond this the quadratic table costs more than the result is worth; the caller keeps the
    // plain line diff, which is still correct.
    if (a.length > MAX_WORD_TOKENS || b.length > MAX_WORD_TOKENS) return undefined

    const table = lcsTable(a, b)
    if (table === null) return undefined

    const segments: WordSegment[] = []
    const push = (op: DiffOp, text: string) => {
        const last = segments[segments.length - 1]
        if (last && last.op === op) last.text += text
        else segments.push({ op, text })
    }

    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('context', a[i])
            i++
            j++
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            push('remove', a[i++])
        } else {
            push('add', b[j++])
        }
    }
    while (i < a.length) push('remove', a[i++])
    while (j < b.length) push('add', b[j++])

    return segments
}

/**
 * Attach word-level segments to remove/add pairs that changed the same JSON key.
 *
 * Only pairs are considered. A removed line with no matching added line is a deletion, not an
 * edit, and inventing a word diff against an unrelated neighbour would be actively misleading.
 */
const LONG_LINE_THRESHOLD = 120

const attachWordSegments = (hunks: DiffHunk[]): void => {
    const keyOf = (text: string): string | null => {
        const match = /^\s*"([^"]+)"\s*:/.exec(text)
        return match ? match[1] : null
    }

    for (const hunk of hunks) {
        for (let i = 0; i < hunk.lines.length - 1; i++) {
            const removed = hunk.lines[i]
            const added = hunk.lines[i + 1]
            if (removed.op !== 'remove' || added.op !== 'add') continue
            const key = keyOf(removed.text)
            if (!key || key !== keyOf(added.text)) continue
            if (removed.text.length < LONG_LINE_THRESHOLD && added.text.length < LONG_LINE_THRESHOLD) continue

            const segments = diffWords(removed.text, added.text)
            if (!segments) continue
            removed.segments = segments.filter((seg) => seg.op !== 'add')
            added.segments = segments.filter((seg) => seg.op !== 'remove')
        }
    }
}

export const diffText = (oldText: string, newText: string, contextLines = 3): DiffResult => {
    if (oldText === newText) return { hunks: [], added: 0, removed: 0, identical: true }

    const oldLines = splitLines(oldText)
    const newLines = splitLines(newText)

    // Common prefix / suffix, so the expensive part only sees what actually differs.
    let prefix = 0
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
    let suffix = 0
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix++
    }

    const midOld = oldLines.slice(prefix, oldLines.length - suffix)
    const midNew = newLines.slice(prefix, newLines.length - suffix)
    const table = lcsTable(midOld, midNew)

    const script: DiffLine[] = []
    const emit = (op: DiffOp, oldIdx: number | null, newIdx: number | null, text: string) =>
        script.push({ op, oldLine: oldIdx === null ? null : oldIdx + 1, newLine: newIdx === null ? null : newIdx + 1, text })

    for (let i = 0; i < prefix; i++) emit('context', i, i, oldLines[i])

    if (table === null) {
        // Too large to align. Report a wholesale replacement rather than risk the process.
        midOld.forEach((line, i) => emit('remove', prefix + i, null, line))
        midNew.forEach((line, i) => emit('add', null, prefix + i, line))
    } else {
        let i = 0
        let j = 0
        while (i < midOld.length && j < midNew.length) {
            if (midOld[i] === midNew[j]) {
                emit('context', prefix + i, prefix + j, midOld[i])
                i++
                j++
            } else if (table[i + 1][j] >= table[i][j + 1]) {
                emit('remove', prefix + i, null, midOld[i])
                i++
            } else {
                emit('add', null, prefix + j, midNew[j])
                j++
            }
        }
        while (i < midOld.length) emit('remove', prefix + i, null, midOld[i++])
        while (j < midNew.length) emit('add', null, prefix + j, midNew[j++])
    }

    for (let k = 0; k < suffix; k++) {
        emit('context', oldLines.length - suffix + k, newLines.length - suffix + k, oldLines[oldLines.length - suffix + k])
    }

    const grouped = groupIntoHunks(script, contextLines)
    attachWordSegments(grouped.hunks)
    return { ...grouped, identical: false }
}

/** Collapse long runs of unchanged lines, keeping `contextLines` either side of each change. */
const groupIntoHunks = (script: DiffLine[], contextLines: number): Omit<DiffResult, 'identical'> => {
    const keep = new Array<boolean>(script.length).fill(false)
    let added = 0
    let removed = 0

    script.forEach((line, index) => {
        if (line.op === 'context') return
        if (line.op === 'add') added++
        else removed++
        for (let k = Math.max(0, index - contextLines); k <= Math.min(script.length - 1, index + contextLines); k++) keep[k] = true
    })

    const hunks: DiffHunk[] = []
    let current: DiffHunk | null = null
    script.forEach((line, index) => {
        if (!keep[index]) {
            current = null
            return
        }
        if (!current) {
            current = { oldStart: line.oldLine ?? 0, newStart: line.newLine ?? 0, lines: [] }
            hunks.push(current)
        }
        current.lines.push(line)
    })

    return { hunks, added, removed }
}

/**
 * The prompt-focused view (§7): the same diff, reduced to changes inside prompt and template fields.
 *
 * Works on the normalised JSON's own shape rather than re-parsing. Because `normalise.ts` emits
 * `"fieldName": "value"` one field per line at a known indent, a changed line carries its own field
 * name — so a changed line is a prompt change when its key matches, and a continuation line of a
 * multi-line prompt string inherits the key that opened it.
 *
 * The alternative — parse both sides and walk the object graph — sounds cleaner and is worse here:
 * it loses the line numbers the diff is expressed in, and it cannot show WHERE inside an
 * 11,649-character prompt the change landed, which is the entire question being asked.
 */
export const filterToPromptChanges = (result: DiffResult): DiffResult => {
    const keyOf = (text: string): string | null => {
        const match = /^\s*"([^"]+)"\s*:/.exec(text)
        return match ? match[1] : null
    }

    const hunks: DiffHunk[] = []
    let added = 0
    let removed = 0

    for (const hunk of result.hunks) {
        // Track the most recent field name seen, so continuation lines of a multi-line prompt are
        // attributed to the field that opened them.
        let currentKey: string | null = null
        const lines = hunk.lines.filter((line) => {
            const key = keyOf(line.text)
            if (key) currentKey = key
            return currentKey !== null && isPromptField(currentKey)
        })
        if (lines.length === 0) continue
        for (const line of lines) {
            if (line.op === 'add') added++
            else if (line.op === 'remove') removed++
        }
        hunks.push({ ...hunk, lines })
    }

    return { hunks, added, removed, identical: added === 0 && removed === 0 }
}

/** Unified-diff text, for the CLI and for anything that wants to paste a diff somewhere. */
export const toUnifiedText = (result: DiffResult, oldLabel = 'a', newLabel = 'b'): string => {
    if (result.identical) return ''
    const out = [`--- ${oldLabel}`, `+++ ${newLabel}`]
    for (const hunk of result.hunks) {
        const oldCount = hunk.lines.filter((l) => l.op !== 'add').length
        const newCount = hunk.lines.filter((l) => l.op !== 'remove').length
        out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`)
        for (const line of hunk.lines) {
            out.push(`${line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' '}${line.text}`)
        }
    }
    return out.join('\n') + '\n'
}
