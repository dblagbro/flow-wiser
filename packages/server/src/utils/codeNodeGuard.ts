import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'

/**
 * Refuse to publish a flow that can execute code (security assessment 2026-08-07, recommendation 2).
 *
 * ── The escalation this closes ───────────────────────────────────────────────────────────────
 *
 * Two findings compose into unauthenticated host compromise:
 *
 *   FINDING 2  `/api/v1/prediction/<id>` executed keyless flows with no authentication
 *   FINDING 0  a code node could `require('fs')` — proven arbitrary read of the credential
 *              database and write to the mounted NAS
 *
 * Both are fixed directly (`validateKey.ts`, `components/src/utils.ts`). This is the third leg:
 * even with those fixes, `isPublic` is a deliberate grant of unauthenticated execution, and a
 * public flow containing a code node means unauthenticated code execution by design. The assessment
 * named it as the single worst escalation path, and it is the cheapest one to remove.
 *
 * ── Why a hard refusal rather than a warning ─────────────────────────────────────────────────
 *
 * "Public" and "runs arbitrary code" are individually reasonable and catastrophic together. The
 * combination is never what someone means to build, so refusing costs a legitimate user nothing
 * and costs an attacker the whole chain. A warning would be read once and clicked past.
 *
 * ── Detection is deliberately broad ──────────────────────────────────────────────────────────
 *
 * Matching is on node NAME substrings rather than an exact list of the six known node types. An
 * exact list silently stops protecting the moment a seventh code node is added — and a missed node
 * type here is not a cosmetic gap, it is the whole vulnerability. A false positive costs an
 * operator one confused moment; a false negative costs them the host.
 */

/** Substrings that identify a node able to execute user-supplied code. Matched case-insensitively. */
export const CODE_EXECUTION_NODE_MARKERS = [
    'customfunction',
    'customtool',
    'custommcp',
    'customdocumentloader',
    'codeinterpreter',
    'pythoninterpreter',
    'executeflow',
    'ifelsefunction',
    'loopfunction',
    'conditionfunction',
    'jsonfunction'
]

/** Field names whose values carry executable code, used as a secondary signal. */
const CODE_FIELD_MARKERS = ['javascriptfunction', 'pythonfunction', 'code', 'functionname']

export interface CodeNodeScan {
    found: boolean
    /** Node labels/names that matched, for an error message an operator can act on. */
    nodes: string[]
}

/**
 * Scan a `flowData` document for code-execution nodes.
 *
 * Unparseable `flowData` returns `found: false` rather than throwing. This helper's job is to block
 * a publish, not to validate the document — a flow that will not parse cannot be executed either,
 * and turning a malformed-flow save into a confusing security error would be its own bug.
 */
export const scanForCodeExecutionNodes = (flowData: string | null | undefined): CodeNodeScan => {
    if (!flowData) return { found: false, nodes: [] }

    let parsed: { nodes?: unknown }
    try {
        parsed = JSON.parse(flowData)
    } catch {
        return { found: false, nodes: [] }
    }
    if (!Array.isArray(parsed?.nodes)) return { found: false, nodes: [] }

    const hits: string[] = []
    for (const node of parsed.nodes as Record<string, any>[]) {
        const data = (node?.data ?? {}) as Record<string, any>
        const identity = [data.name, data.type, data.category, node?.type].filter((v) => typeof v === 'string').join(' ').toLowerCase()

        let matched = CODE_EXECUTION_NODE_MARKERS.some((marker) => identity.includes(marker))

        // Secondary signal: a node carrying a non-empty code-bearing input, whatever it calls
        // itself. This is what catches a node type that did not exist when this list was written.
        if (!matched && data.inputs && typeof data.inputs === 'object') {
            matched = Object.entries(data.inputs as Record<string, unknown>).some(
                ([key, value]) =>
                    CODE_FIELD_MARKERS.some((marker) => key.toLowerCase().includes(marker)) &&
                    typeof value === 'string' &&
                    value.trim().length > 0
            )
        }

        if (matched) hits.push(data.label || data.name || node?.id || 'unnamed node')
    }

    return { found: hits.length > 0, nodes: [...new Set(hits)] }
}

/**
 * Throw if a flow being marked public contains a code-execution node.
 *
 * Called on the create and update paths. A no-op unless `isPublic` is actually being set, so
 * existing private flows with code nodes are untouched — the risk is the combination, not the node.
 */
export const assertPublicFlowHasNoCodeNode = (isPublic: unknown, flowData: string | null | undefined): void => {
    if (isPublic !== true && isPublic !== 'true' && isPublic !== 1) return

    const scan = scanForCodeExecutionNodes(flowData)
    if (!scan.found) return

    throw new InternalFlowiseError(
        StatusCodes.BAD_REQUEST,
        `This flow cannot be made public because it contains node(s) that execute code: ${scan.nodes.join(', ')}. ` +
            'A public flow is executable without authentication, so publishing it would let anyone run that code on this server. ' +
            'Remove the code node, or keep the flow private and call it with an API key.'
    )
}
