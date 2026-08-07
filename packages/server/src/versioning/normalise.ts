/**
 * Versioning — deterministic serialisation of `flowData`.
 *
 * REQUIREMENTS-VERSIONING.md §"Normalisation": "This single choice is what makes prompt-level
 * versioning real."
 *
 * Flowise stores `flowData` MINIFIED — one enormous line, averaging 331 KB and peaking at 5.9 MB.
 * Committing that verbatim gives a history where every version differs from the last by "line 1
 * changed", which answers "did something change?" and nothing else. Real prompts in this codebase
 * run to 11,649 characters in a single node; the whole point is to see WHICH words moved.
 *
 * Two properties are required, and only both together are sufficient:
 *
 *  1. **Indented** — so the output is line-oriented and a textual diff has lines to align.
 *  2. **Key-ordered** — so a save that changes nothing produces a byte-identical file. Object key
 *     order in JSON round-trips is incidental: it follows insertion order, which follows whatever
 *     the editor last touched. Without sorting, moving a node in the canvas can reorder keys
 *     throughout and light up the diff with changes nobody made. That noise is not cosmetic — it
 *     destroys the signal the feature exists to provide, and it defeats the "no commit when nothing
 *     changed" check, filling history with empty versions.
 *
 * Embedded JSON strings are deliberately NOT parsed and re-serialised. A node's `inputs` can carry
 * JSON as a string value; rewriting it would change the stored flow's bytes on restore, breaking
 * acceptance criterion 5 ("restored flow is byte-identical to the version selected"). The version
 * store is a mirror, never an editor.
 */

/** Recursively rebuild with keys in sorted order. Arrays keep their order — it is meaningful. */
const sortKeysDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeysDeep)
    if (value === null || typeof value !== 'object') return value

    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
        sorted[key] = sortKeysDeep(source[key])
    }
    return sorted
}

/**
 * Normalise a `flowData` string for committing.
 *
 * Invalid JSON is stored verbatim rather than rejected. A flow whose `flowData` will not parse is
 * exactly the flow whose history is most worth having, and refusing to version it would mean the
 * one save an operator most needs to recover is the one silently skipped.
 */
export const normaliseFlowData = (flowData: string | null | undefined): string => {
    if (!flowData) return ''
    try {
        return JSON.stringify(sortKeysDeep(JSON.parse(flowData)), null, 2) + '\n'
    } catch {
        return flowData
    }
}

/** The same treatment for the metadata sidecar, which is small but should still diff cleanly. */
export const normaliseJson = (value: unknown): string => JSON.stringify(sortKeysDeep(value), null, 2) + '\n'

/**
 * Field names whose values are prompts or templates, for the prompt-focused diff (§7).
 *
 * Matched case-insensitively as a SUBSTRING of the field name, because the shipped nodes spell them
 * inconsistently — `systemMessagePrompt`, `chatPromptTemplate`, `humanMessagePrompt`,
 * `systemMessage`, `promptValues`. An exact-match list would silently miss whichever node names
 * its field differently next, and a missed prompt field is invisible: the filtered view would just
 * show nothing changed.
 */
export const PROMPT_FIELD_MARKERS = ['prompt', 'template', 'systemmessage', 'humanmessage', 'aimessage', 'instruction']

export const isPromptField = (fieldName: string): boolean => {
    const lowered = fieldName.toLowerCase()
    return PROMPT_FIELD_MARKERS.some((marker) => lowered.includes(marker))
}
