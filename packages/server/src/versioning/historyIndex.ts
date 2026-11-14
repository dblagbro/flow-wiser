import fs from 'fs'
import path from 'path'
import git from 'isomorphic-git'

/**
 * Which commits changed which flow — a derived, rebuildable index over the version repository.
 *
 * ── Why this exists (I-08) ───────────────────────────────────────────────────────────────────
 *
 * Every flow shares one repository, so "the history of this flow" used to be answered by walking
 * the whole commit log and asking, commit by commit, whether this one file changed. The cost of a
 * history request therefore grew with every save of every OTHER flow: measured at about one
 * millisecond per commit in the repository, per request, for ever.
 *
 * This index pays that cost once per commit instead of once per commit per request. It records, for
 * each flow, the commits in which `flows/<id>.json` differs from the parent commit — added,
 * modified or removed. A history request then reads the commits it will return and nothing else.
 *
 * ── It is a cache, and the repository stays the only source of truth ─────────────────────────
 *
 * Nothing here is written on the save path. The index is brought up to date when history is asked
 * for, by scanning only the commits made since the last scan. It lives inside `.git/`, so it is
 * never committed, never appears in a diff, and travels with the data directory in a backup.
 *
 * It can be deleted at any time. It is discarded and rebuilt when the commit it was scanned up to
 * is no longer an ancestor of HEAD — a restored backup, a repository an operator has rewritten.
 * A scan interrupted half way leaves entries behind without advancing the marker; the next scan
 * appends them again, and reads drop the repeats.
 *
 * The caller treats any failure here as "no index" and walks the log as before.
 */

const INDEX_DIRECTORY = 'flow-history'
const MARKER_FILE = 'SCANNED'
const FLOWS_DIRECTORY = 'flows'
const OID = /^[0-9a-f]{40}$/

/**
 * Flow ids become file names here. Anything outside this alphabet is simply not indexed — the
 * caller falls back to the walk for it — so no id can name a path outside the index directory.
 */
const INDEXABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export class FlowHistoryIndex {
    private pending: Promise<void> = Promise.resolve()

    constructor(private readonly dir: string) {}

    private get root(): string {
        return path.join(this.dir, '.git', INDEX_DIRECTORY)
    }

    static isIndexable(chatflowId: string): boolean {
        return INDEXABLE_ID.test(chatflowId)
    }

    /**
     * Commits that changed this flow's file, newest first. `null` when the id cannot be indexed.
     *
     * @throws when the repository or the index cannot be read; the caller falls back to the walk.
     */
    async commitsFor(chatflowId: string): Promise<string[] | null> {
        if (!FlowHistoryIndex.isIndexable(chatflowId)) return null
        await this.sync()

        let text: string
        try {
            text = await fs.promises.readFile(path.join(this.root, FLOWS_DIRECTORY, chatflowId), 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw error
        }

        const seen = new Set<string>()
        for (const line of text.split('\n')) {
            if (line === '') continue
            if (!OID.test(line)) throw new Error('the flow history index holds something that is not a commit id')
            seen.add(line)
        }
        return [...seen].reverse()
    }

    /** Throw the index away. The next request rebuilds it from the repository. */
    async discard(): Promise<void> {
        await fs.promises.rm(this.root, { recursive: true, force: true })
    }

    /** Scans run one at a time: two at once would each append the same commits. */
    private sync(): Promise<void> {
        const run = this.pending.then(() => this.scan())
        this.pending = run.catch(() => undefined)
        return run
    }

    private async readMarker(): Promise<string | null> {
        try {
            const marker = (await fs.promises.readFile(path.join(this.root, MARKER_FILE), 'utf8')).trim()
            return OID.test(marker) ? marker : null
        } catch {
            return null
        }
    }

    private async scan(): Promise<void> {
        const head = await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' })
        const marker = await this.readMarker()
        if (marker === head) return

        const cache = {}
        // The unscanned commits, newest first, following first parents back to the marker.
        const unscanned: string[] = []
        let reachedMarker = false
        let cursor: string | undefined = head
        while (cursor) {
            if (cursor === marker) {
                reachedMarker = true
                break
            }
            unscanned.push(cursor)
            const { commit }: { commit: { parent: string[] } } = await git.readCommit({ fs, dir: this.dir, oid: cursor, cache })
            cursor = commit.parent[0]
        }

        // No marker, or a marker that is not in this history: whatever is on disk describes some
        // other repository state, so none of it can be kept.
        if (!reachedMarker) await this.discard()

        let previous = reachedMarker && marker ? await this.flowFiles(marker, cache) : EMPTY_TREE
        const additions = new Map<string, string[]>()
        for (const oid of unscanned.reverse()) {
            const current = await this.flowFiles(oid, cache)
            if (current.oid !== previous.oid) {
                for (const id of changedIds(previous.files, current.files)) {
                    const list = additions.get(id)
                    if (list) list.push(oid)
                    else additions.set(id, [oid])
                }
            }
            previous = current
        }

        await fs.promises.mkdir(path.join(this.root, FLOWS_DIRECTORY), { recursive: true })
        for (const [id, oids] of additions) {
            await fs.promises.appendFile(path.join(this.root, FLOWS_DIRECTORY, id), oids.join('\n') + '\n', 'utf8')
        }
        // The marker moves last, and by rename, so a scan that dies leaves the old marker in place.
        const temporary = path.join(this.root, `${MARKER_FILE}.tmp`)
        await fs.promises.writeFile(temporary, head + '\n', 'utf8')
        await fs.promises.rename(temporary, path.join(this.root, MARKER_FILE))
    }

    /** The `flows/` tree of a commit: its own oid, and each indexable flow id with its blob oid. */
    private async flowFiles(oid: string, cache: object): Promise<FlowTree> {
        let result
        try {
            result = await git.readTree({ fs, dir: this.dir, oid, filepath: FLOWS_DIRECTORY, cache })
        } catch (error) {
            if ((error as { code?: string }).code === 'NotFoundError') return EMPTY_TREE
            throw error
        }
        const files = new Map<string, string>()
        for (const entry of result.tree) {
            if (entry.type !== 'blob' || !entry.path.endsWith('.json')) continue
            const id = entry.path.slice(0, -'.json'.length)
            if (INDEXABLE_ID.test(id)) files.set(id, entry.oid)
        }
        return { oid: result.oid, files }
    }
}

interface FlowTree {
    oid: string
    files: Map<string, string>
}

const EMPTY_TREE: FlowTree = { oid: '', files: new Map() }

const changedIds = (before: Map<string, string>, after: Map<string, string>): string[] => {
    const changed: string[] = []
    for (const [id, oid] of after) if (before.get(id) !== oid) changed.push(id)
    for (const id of before.keys()) if (!after.has(id)) changed.push(id)
    return changed
}
