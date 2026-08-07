import fs from 'fs'
import path from 'path'
import git from 'isomorphic-git'
import logger from '../utils/logger'
import { normaliseFlowData, normaliseJson } from './normalise'

/**
 * Versioning — the git-backed version store (REQUIREMENTS-VERSIONING.md).
 *
 * NET-NEW CAPABILITY. Upstream Flowise never had it, and it touches no commercially licensed path,
 * so it carries no licensing entanglement whatsoever — see the requirements header.
 *
 * ── Why git rather than a versions table ─────────────────────────────────────────────────────
 *
 * `flowData` averages 331 KB and peaks at 5.9 MB. A row per save of the largest flow is roughly
 * 590 MB per hundred edits. Git's delta compression makes that about an order of magnitude
 * smaller, and — more importantly — history, point-in-time read, diff and restore stop being code
 * we have to get right and become operations that already work.
 *
 * `isomorphic-git` (MIT, pure JavaScript) rather than shelling out to `git` or using a native
 * binding. Two reasons, both learned here: the runtime image is Alpine and has no git binary, and
 * native builds are a live failure mode in this project — `better-sqlite3` under node-gyp is what
 * makes Node 24 unusable for the whole monorepo.
 *
 * ── Restore is non-destructive by construction ───────────────────────────────────────────────
 *
 *     v1 → v2 → v3 → v4          on v4, it is wrong
 *                   ↘ v5         restore v2 → commit v5 whose content EQUALS v2
 *
 * History is never rewritten. v3 and v4 remain reachable for ever, so the line you moved away from
 * is still there tomorrow. That is inherent to append-only commits, not behaviour hand-built here —
 * which is the point of choosing git.
 *
 * ── Failure policy: versioning must never break saving ───────────────────────────────────────
 *
 * Capture is best-effort and every entry point swallows its own errors after logging. A corrupt
 * version repository, a full disk or a permissions problem must not stop a user saving their work.
 * Losing a version is recoverable — the next save captures the current state. Losing the save
 * itself is not. READ paths do the opposite and surface errors, because a silent empty history
 * would be indistinguishable from "this flow has never been edited".
 */

export interface FlowVersionAuthor {
    name: string
    email: string
}

export interface FlowVersionMeta {
    name?: string | null
    type?: string | null
    deployed?: boolean | null
    category?: string | null
    workspaceId?: string | null
    organizationId?: string | null
}

export interface FlowVersionEntry {
    /** Full commit sha. The `ref` accepted by every read operation. */
    oid: string
    /** First 8 characters — what a UI shows. */
    shortOid: string
    message: string
    author: FlowVersionAuthor
    /** ISO-8601, the real edit time rather than the commit-write time. */
    timestamp: string
    /** Named checkpoints pointing at this commit (§6). */
    tags: string[]
}

const AUTHOR_FALLBACK: FlowVersionAuthor = { name: 'Flow-Wiser', email: 'versioning@flow-wiser.local' }

/** `flows/<id>.json` and `meta/<id>.json` — §"Layout". */
const flowPath = (chatflowId: string): string => `flows/${chatflowId}.json`
const metaPath = (chatflowId: string): string => `meta/${chatflowId}.json`

export class VersionStore {
    private readonly dir: string
    private initialised = false

    constructor(options: { dir?: string } = {}) {
        this.dir = options.dir ?? VersionStore.defaultDir()
    }

    /**
     * `<data-dir>/versions`, following the same resolution the rest of the server uses for its
     * writable state, so a bind-mounted data directory carries the history with it. An operator who
     * backs up their data directory gets the version history in that backup without being told to.
     */
    static defaultDir(): string {
        const base =
            process.env.FLOWISE_VERSIONS_PATH ||
            path.join(process.env.DATABASE_PATH || path.join(process.env.HOME || process.cwd(), '.flowise'), 'versions')
        return base
    }

    /** Create the repository on first use. Safe to call repeatedly. */
    private async ensureRepo(): Promise<void> {
        if (this.initialised) return
        await fs.promises.mkdir(path.join(this.dir, 'flows'), { recursive: true })
        await fs.promises.mkdir(path.join(this.dir, 'meta'), { recursive: true })
        if (!fs.existsSync(path.join(this.dir, '.git'))) {
            await git.init({ fs, dir: this.dir, defaultBranch: 'main' })
            logger.info(`🗂️ [versioning]: initialised the flow version store at ${this.dir}`)
        }
        this.initialised = true
    }

    /**
     * Commit the current state of one flow.
     *
     * Returns the new commit sha, or null when nothing changed — the caller records the sha on its
     * audit event (`AuditRecordInput.versionCommitId`), so a version and the audit entry that
     * explains who made it are cross-referenced.
     *
     * The no-change check is why normalisation matters: without sorted keys, a save that altered
     * nothing still produces different bytes, and history fills with empty versions that make the
     * real ones hard to find.
     */
    async captureFlow(input: {
        chatflowId: string
        flowData?: string | null
        meta?: FlowVersionMeta
        author?: Partial<FlowVersionAuthor>
        message?: string
        /** Real edit time. Defaults to now. */
        when?: Date
    }): Promise<string | null> {
        await this.ensureRepo()

        const flowFile = flowPath(input.chatflowId)
        const metaFile = metaPath(input.chatflowId)
        const nextFlow = normaliseFlowData(input.flowData)
        const nextMeta = normaliseJson(input.meta ?? {})

        const flowUnchanged = (await this.readWorkingFile(flowFile)) === nextFlow
        const metaUnchanged = (await this.readWorkingFile(metaFile)) === nextMeta
        if (flowUnchanged && metaUnchanged) return null

        await fs.promises.writeFile(path.join(this.dir, flowFile), nextFlow, 'utf8')
        await fs.promises.writeFile(path.join(this.dir, metaFile), nextMeta, 'utf8')
        await git.add({ fs, dir: this.dir, filepath: flowFile })
        await git.add({ fs, dir: this.dir, filepath: metaFile })

        const author = {
            name: input.author?.name || AUTHOR_FALLBACK.name,
            email: input.author?.email || AUTHOR_FALLBACK.email,
            timestamp: Math.floor((input.when ?? new Date()).getTime() / 1000),
            timezoneOffset: 0
        }

        return await git.commit({
            fs,
            dir: this.dir,
            message: input.message || `Update ${input.meta?.name || input.chatflowId}`,
            author,
            committer: author
        })
    }

    /** Record a deletion as a commit, so the flow's history ends explicitly rather than just stopping. */
    async captureDeletion(input: { chatflowId: string; name?: string | null; author?: Partial<FlowVersionAuthor> }): Promise<string | null> {
        await this.ensureRepo()
        const flowFile = flowPath(input.chatflowId)
        if (!fs.existsSync(path.join(this.dir, flowFile))) return null

        for (const filepath of [flowFile, metaPath(input.chatflowId)]) {
            const absolute = path.join(this.dir, filepath)
            if (!fs.existsSync(absolute)) continue
            await fs.promises.rm(absolute)
            await git.remove({ fs, dir: this.dir, filepath })
        }

        const author = {
            name: input.author?.name || AUTHOR_FALLBACK.name,
            email: input.author?.email || AUTHOR_FALLBACK.email,
            timestamp: Math.floor(Date.now() / 1000),
            timezoneOffset: 0
        }
        return await git.commit({
            fs,
            dir: this.dir,
            message: `Delete ${input.name || input.chatflowId}`,
            author,
            committer: author
        })
    }

    /** History for one flow, newest first (§2). */
    async history(chatflowId: string, limit = 100): Promise<FlowVersionEntry[]> {
        await this.ensureRepo()
        if (!(await this.hasCommits())) return []

        const commits = await git.log({ fs, dir: this.dir, filepath: flowPath(chatflowId), depth: limit, force: true })
        const tagsByOid = await this.tagsByOid()

        return commits.map((entry) => ({
            oid: entry.oid,
            shortOid: entry.oid.slice(0, 8),
            message: entry.commit.message.trim(),
            author: { name: entry.commit.author.name, email: entry.commit.author.email },
            timestamp: new Date(entry.commit.author.timestamp * 1000).toISOString(),
            tags: tagsByOid.get(entry.oid) ?? []
        }))
    }

    /** One flow as it stood at a given commit (§3). Null when the file did not exist there. */
    async readAt(chatflowId: string, ref: string): Promise<string | null> {
        await this.ensureRepo()
        try {
            const { blob } = await git.readBlob({ fs, dir: this.dir, oid: await this.resolve(ref), filepath: flowPath(chatflowId) })
            return Buffer.from(blob).toString('utf8')
        } catch {
            return null
        }
    }

    /** The commit in effect at a point in time (§3, "show this flow as of <date>"). */
    async resolveAsOf(chatflowId: string, when: Date): Promise<FlowVersionEntry | null> {
        const entries = await this.history(chatflowId, 1000)
        const target = when.getTime()
        return entries.find((entry) => new Date(entry.timestamp).getTime() <= target) ?? null
    }

    /**
     * Name a version (§6). Tags are per-commit, so a checkpoint survives everything committed after it.
     *
     * ── The label is NOT the ref ─────────────────────────────────────────────────────────────
     *
     * A git ref name becomes a path under `.git/refs/`, so passing a user-supplied label straight
     * through is an arbitrary file write. A label of `../../../../usr/src/flowise/PWNED` created
     * exactly that file, outside the data directory, for anyone holding `chatflows:update`. The
     * content is only a 40-character oid, but creating or truncating arbitrary paths as the server
     * user is more than enough to do damage.
     *
     * It is also simply invalid: the requirements' own example, `before RAG prompt rewrite`, has
     * spaces. isomorphic-git accepted it and round-tripped it happily, so the API looked fine —
     * while real git reported `ignoring ref with broken name` and `git fsck` errored. A checkpoint
     * invisible to `git gc` and to any operator using git directly is not a checkpoint.
     *
     * So the ref is a SLUG derived from the label, and the human label is preserved in the
     * annotated tag's own message. Slugging is done by allowing a known-safe alphabet rather than
     * by stripping known-bad sequences: a denylist has to anticipate every traversal spelling, and
     * an allowlist cannot be wrong about a character it has never seen.
     */
    async tag(ref: string, label: string): Promise<{ oid: string; slug: string; label: string }> {
        await this.ensureRepo()

        const trimmed = String(label ?? '').trim()
        if (trimmed.length === 0) throw new Error('A checkpoint label cannot be empty')
        if (trimmed.length > 200) throw new Error('A checkpoint label cannot exceed 200 characters')

        const slug = trimmed
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80)
        // Everything the label contained was punctuation, or it collapsed to nothing.
        if (slug.length === 0) throw new Error('A checkpoint label must contain at least one letter or digit')

        const oid = await this.resolve(ref)
        // Annotated, so the human label travels with the tag object rather than living only in a
        // sidecar we would then have to keep in step.
        await git.annotatedTag({
            fs,
            dir: this.dir,
            ref: slug,
            object: oid,
            message: trimmed,
            tagger: { name: AUTHOR_FALLBACK.name, email: AUTHOR_FALLBACK.email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 }
        })
        return { oid, slug, label: trimmed }
    }

    /** Every checkpoint, with the human label recovered from the annotated tag's message. */
    async listTags(): Promise<{ label: string; slug: string; oid: string }[]> {
        await this.ensureRepo()
        const slugs = await git.listTags({ fs, dir: this.dir })
        const out: { label: string; slug: string; oid: string }[] = []
        for (const slug of slugs) {
            try {
                const pointer = await git.resolveRef({ fs, dir: this.dir, ref: slug })
                // An annotated tag resolves to a tag OBJECT that in turn names the commit; a
                // lightweight tag (anything created before this change) resolves straight to it.
                let oid = pointer
                let label = slug
                try {
                    const tagObject = await git.readTag({ fs, dir: this.dir, oid: pointer })
                    oid = tagObject.tag.object
                    label = (tagObject.tag.message || slug).trim()
                } catch {
                    /* lightweight tag — the slug is all we have */
                }
                out.push({ label, slug, oid })
            } catch {
                // A ref with a name real git rejects (created before this change) cannot be
                // resolved. Skipped rather than thrown: one malformed legacy tag must not make
                // every history request fail.
                logger.warn(`⚠️ [versioning]: skipping checkpoint with an unreadable ref name: ${slug}`)
            }
        }
        return out
    }

    /** Accept a sha, a short sha, a tag name, or `HEAD`. */
    async resolve(ref: string): Promise<string> {
        await this.ensureRepo()
        try {
            return await git.resolveRef({ fs, dir: this.dir, ref })
        } catch {
            return await git.expandOid({ fs, dir: this.dir, oid: ref })
        }
    }

    private async hasCommits(): Promise<boolean> {
        try {
            await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' })
            return true
        } catch {
            return false
        }
    }

    private async tagsByOid(): Promise<Map<string, string[]>> {
        const map = new Map<string, string[]>()
        for (const { label, oid } of await this.listTags()) {
            map.set(oid, [...(map.get(oid) ?? []), label])
        }
        return map
    }

    /** Resolve a checkpoint slug to the commit it names, so a tag is usable wherever a ref is. */
    async resolveTag(slug: string): Promise<string | null> {
        const found = (await this.listTags()).find((tag) => tag.slug === slug || tag.label === slug)
        return found?.oid ?? null
    }

    private async readWorkingFile(filepath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(path.join(this.dir, filepath), 'utf8')
        } catch {
            return null
        }
    }
}

/**
 * One process-wide store. Constructing it is cheap, but `ensureRepo` does filesystem work, and two
 * concurrent saves each initialising their own would race on `git.init`.
 */
let shared: VersionStore | undefined
export const getVersionStore = (): VersionStore => {
    if (!shared) shared = new VersionStore()
    return shared
}
