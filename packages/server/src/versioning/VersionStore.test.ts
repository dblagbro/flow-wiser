/**
 * Versioning — VersionStore tests (I-03).
 *
 * Runs the real store against a throwaway repository under the OS temp directory: real filesystem,
 * real isomorphic-git, nothing mocked except the logger (which drags in the storage provider).
 *
 * The checkpoint-label block is the NEGATIVE test for the arbitrary-file-write this subsystem once
 * had: a label was passed straight through as a git ref name, so `../../../PWNED` created a file
 * outside the data directory. It asserts on the filesystem, not just on the return value.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { VersionStore } from './VersionStore'
import { normaliseFlowData } from './normalise'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

const flow = (prompt: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ nodes: [{ id: 'n1', data: { systemMessagePrompt: prompt } }], edges: [], ...extra })

/** Every regular file under `root`, relative, excluding `.git` internals other than refs. */
const listFiles = (root: string): string[] => {
    const out: string[] = []
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else out.push(path.relative(root, full))
        }
    }
    walk(root)
    return out.sort()
}

describe('VersionStore', () => {
    let sandbox: string
    let dir: string
    let store: VersionStore

    beforeEach(async () => {
        // The store lives one level down so an escape via `..` lands inside the sandbox, where it
        // can be detected, instead of in the real temp directory.
        sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fw-versioning-'))
        dir = path.join(sandbox, 'data', 'versions')
        store = new VersionStore({ dir })
    })

    afterEach(async () => {
        await fs.promises.rm(sandbox, { recursive: true, force: true })
    })

    describe('captureFlow', () => {
        it('commits the normalised flow and metadata and returns the commit sha', async () => {
            const oid = await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { name: 'Flow One' } })
            expect(oid).toMatch(/^[0-9a-f]{40}$/)
            expect(await fs.promises.readFile(path.join(dir, 'flows', 'f1.json'), 'utf8')).toBe(normaliseFlowData(flow('v1')))
            expect(JSON.parse(await fs.promises.readFile(path.join(dir, 'meta', 'f1.json'), 'utf8'))).toEqual({ name: 'Flow One' })
        })

        it('returns null and adds no commit when nothing changed', async () => {
            await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { name: 'A' } })
            expect(await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { name: 'A' } })).toBeNull()
            expect(await store.history('f1')).toHaveLength(1)
        })

        it('treats a save that only reorders keys as no change', async () => {
            await store.captureFlow({ chatflowId: 'f1', flowData: '{"a":1,"b":{"x":1,"y":2}}', meta: { name: 'A', type: 'CHATFLOW' } })
            const again = await store.captureFlow({
                chatflowId: 'f1',
                flowData: '{"b":{"y":2,"x":1},"a":1}',
                meta: { type: 'CHATFLOW', name: 'A' }
            })
            expect(again).toBeNull()
            expect(await store.history('f1')).toHaveLength(1)
        })

        it('commits when only the metadata changed', async () => {
            await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { deployed: false } })
            expect(await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { deployed: true } })).not.toBeNull()
        })

        it('records the author, the real edit time and the message', async () => {
            const when = new Date('2026-01-02T03:04:05.000Z')
            await store.captureFlow({
                chatflowId: 'f1',
                flowData: flow('v1'),
                author: { name: 'Ada', email: 'ada@example.test' },
                message: 'Create Flow One',
                when
            })
            const [entry] = await store.history('f1')
            expect(entry.author).toEqual({ name: 'Ada', email: 'ada@example.test' })
            expect(entry.timestamp).toBe(when.toISOString())
            expect(entry.message).toBe('Create Flow One')
            expect(entry.shortOid).toBe(entry.oid.slice(0, 8))
        })

        it('falls back to a placeholder author and a default message', async () => {
            await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { name: 'Named' } })
            const [entry] = await store.history('f1')
            expect(entry.author).toEqual({ name: 'Flow-Wiser', email: 'versioning@flow-wiser.local' })
            expect(entry.message).toBe('Update Named')
        })
    })

    describe('history and point-in-time read', () => {
        it('returns an empty history before anything is captured', async () => {
            expect(await store.history('nope')).toEqual([])
        })

        it('lists versions newest first and keeps each flow separate', async () => {
            const a1 = await store.captureFlow({ chatflowId: 'a', flowData: flow('a1'), when: new Date('2026-01-01T00:00:00Z') })
            await store.captureFlow({ chatflowId: 'b', flowData: flow('b1'), when: new Date('2026-01-02T00:00:00Z') })
            const a2 = await store.captureFlow({ chatflowId: 'a', flowData: flow('a2'), when: new Date('2026-01-03T00:00:00Z') })
            expect((await store.history('a')).map((e) => e.oid)).toEqual([a2, a1])
            expect(await store.history('b')).toHaveLength(1)
        })

        // NEGATIVE test. The store is one repository shared by every flow, and a truncated walk
        // used to append the commit it stopped on — a save of a DIFFERENT flow — to the result.
        it('never returns a commit belonging to another flow, at any limit', async () => {
            const mine: string[] = []
            for (let i = 0; i < 4; i++) {
                await store.captureFlow({
                    chatflowId: 'theirs',
                    flowData: flow(`theirs-${i}`),
                    meta: { name: 'Their Private Flow' },
                    author: { name: 'Someone Else', email: 'someone.else@example.test' },
                    when: new Date(Date.UTC(2026, 0, 1 + i * 2))
                })
                mine.unshift(
                    (await store.captureFlow({
                        chatflowId: 'mine',
                        flowData: flow(`mine-${i}`),
                        when: new Date(Date.UTC(2026, 0, 2 + i * 2))
                    }))!
                )
            }

            for (const limit of [1, 2, 3, 4, 5, 100]) {
                const entries = await store.history('mine', limit)
                expect(entries.map((e) => e.oid)).toEqual(mine.slice(0, limit))
                expect(
                    entries.some((e) => e.message.includes('Their Private Flow') || e.author.email === 'someone.else@example.test')
                ).toBe(false)
            }
            expect((await store.resolveAsOf('mine', new Date(Date.UTC(2026, 0, 5))))?.oid).toBe(mine[2])
        })

        it('returns nothing for a non-positive or non-integer limit', async () => {
            await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1') })
            expect(await store.history('f1', 0)).toEqual([])
            expect(await store.history('f1', -1)).toEqual([])
            expect(await store.history('f1', Number.NaN)).toEqual([])
        })

        it('reads a flow as it stood at a full sha, a short sha and HEAD', async () => {
            const v1 = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1') }))!
            await store.captureFlow({ chatflowId: 'f1', flowData: flow('v2') })
            expect(await store.readAt('f1', v1)).toBe(normaliseFlowData(flow('v1')))
            expect(await store.readAt('f1', v1.slice(0, 8))).toBe(normaliseFlowData(flow('v1')))
            expect(await store.readAt('f1', 'HEAD')).toBe(normaliseFlowData(flow('v2')))
        })

        it('returns null for an unknown ref or a flow absent at that commit', async () => {
            const v1 = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1') }))!
            expect(await store.readAt('f1', 'deadbeef')).toBeNull()
            expect(await store.readAt('other', v1)).toBeNull()
        })

        it('resolves the version in effect at a point in time', async () => {
            const v1 = await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), when: new Date('2026-01-01T00:00:00Z') })
            const v2 = await store.captureFlow({ chatflowId: 'f1', flowData: flow('v2'), when: new Date('2026-01-10T00:00:00Z') })
            expect((await store.resolveAsOf('f1', new Date('2026-01-05T00:00:00Z')))?.oid).toBe(v1)
            expect((await store.resolveAsOf('f1', new Date('2026-02-01T00:00:00Z')))?.oid).toBe(v2)
            expect(await store.resolveAsOf('f1', new Date('2025-12-01T00:00:00Z'))).toBeNull()
        })
    })

    describe('restore round-trip', () => {
        it('restoring an old version yields its exact bytes and rewrites no history', async () => {
            // A flow as the server stores it: minified, keys in editor order, a multi-line prompt.
            const original =
                '{"nodes":[{"id":"n1","data":{"systemMessagePrompt":"line one\\nline two — ünïcode","inputs":{"json":"{\\"b\\":1, \\"a\\":2}"}}}],"edges":[]}'
            const v1 = (await store.captureFlow({ chatflowId: 'f1', flowData: original }))!
            const v2 = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v2') }))!
            const v3 = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v3') }))!

            // Restore = read v1 and save it again as a new version.
            const restored = (await store.readAt('f1', v1))!
            expect(JSON.parse(restored)).toEqual(JSON.parse(original))
            const v4 = (await store.captureFlow({ chatflowId: 'f1', flowData: restored, message: 'Restore v1' }))!

            expect(await store.readAt('f1', v4)).toBe(await store.readAt('f1', v1))
            expect((await store.history('f1')).map((e) => e.oid)).toEqual([v4, v3, v2, v1])
            expect(await store.readAt('f1', v2)).toBe(normaliseFlowData(flow('v2')))
            expect(await store.readAt('f1', v3)).toBe(normaliseFlowData(flow('v3')))
        })

        it('restoring the version already current is a no-op', async () => {
            const v1 = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1') }))!
            expect(await store.captureFlow({ chatflowId: 'f1', flowData: (await store.readAt('f1', v1))! })).toBeNull()
        })
    })

    describe('captureDeletion', () => {
        it('records the deletion as a commit and keeps earlier versions readable', async () => {
            const v1 = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { name: 'Gone' } }))!
            const deleted = await store.captureDeletion({ chatflowId: 'f1', name: 'Gone' })
            expect(deleted).toMatch(/^[0-9a-f]{40}$/)
            expect(fs.existsSync(path.join(dir, 'flows', 'f1.json'))).toBe(false)
            expect(fs.existsSync(path.join(dir, 'meta', 'f1.json'))).toBe(false)
            expect(await store.readAt('f1', 'HEAD')).toBeNull()
            expect(await store.readAt('f1', v1)).toBe(normaliseFlowData(flow('v1')))
        })

        it('returns null for a flow that was never captured', async () => {
            expect(await store.captureDeletion({ chatflowId: 'never' })).toBeNull()
        })
    })

    describe('checkpoint labels (tag)', () => {
        let head: string

        beforeEach(async () => {
            head = (await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1') }))!
        })

        it('slugs the ref and preserves the human label', async () => {
            const result = await store.tag(head, '  Before RAG prompt rewrite  ')
            expect(result).toEqual({ oid: head, slug: 'before-rag-prompt-rewrite', label: 'Before RAG prompt rewrite' })
            expect(await store.listTags()).toEqual([{ label: 'Before RAG prompt rewrite', slug: 'before-rag-prompt-rewrite', oid: head }])
            expect((await store.history('f1'))[0].tags).toEqual(['Before RAG prompt rewrite'])
            expect(await store.resolveTag('before-rag-prompt-rewrite')).toBe(head)
            expect(await store.resolveTag('Before RAG prompt rewrite')).toBe(head)
            expect(await store.resolveTag('missing')).toBeNull()
            expect(await store.readAt('f1', 'before-rag-prompt-rewrite')).toBe(normaliseFlowData(flow('v1')))
        })

        // The original exploit, and the spellings a denylist would have to anticipate.
        it.each([
            '../../../PWNED',
            '../../../../usr/src/flowise/PWNED',
            '..\\..\\..\\PWNED',
            '/etc/cron.d/pwned',
            'refs/heads/main',
            '../../HEAD',
            'a/../../../b',
            '%2e%2e%2fPWNED',
            'ok\u0000../../PWNED',
            'x\n../../PWNED'
        ])('never writes outside refs/tags for the label %j', async (label) => {
            const outsideBefore = listFiles(sandbox).filter((f) => !f.startsWith(path.join('data', 'versions', '.git')))
            const headBefore = await fs.promises.readFile(path.join(dir, '.git', 'HEAD'), 'utf8')
            const refsBefore = listFiles(path.join(dir, '.git', 'refs'))

            const { slug } = await store.tag(head, label)

            expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
            // Nothing new anywhere outside the repository's own .git directory…
            expect(listFiles(sandbox).filter((f) => !f.startsWith(path.join('data', 'versions', '.git')))).toEqual(outsideBefore)
            // …and inside it, exactly one new ref, directly under refs/tags, named by the slug.
            const newRefs = listFiles(path.join(dir, '.git', 'refs')).filter((f) => !refsBefore.includes(f))
            expect(newRefs).toEqual([path.join('tags', slug)])
            expect(await fs.promises.readFile(path.join(dir, '.git', 'HEAD'), 'utf8')).toBe(headBefore)
            expect((await store.history('f1'))[0].oid).toBe(head)
        })

        it.each(['', '   ', '../..', '///', '..\\..', '!!!'])('rejects the label %j, which has no letter or digit', async (label) => {
            const refsBefore = listFiles(path.join(dir, '.git', 'refs'))
            await expect(store.tag(head, label)).rejects.toThrow(/label/)
            expect(listFiles(path.join(dir, '.git', 'refs'))).toEqual(refsBefore)
        })

        it('rejects a label over 200 characters and caps the slug at 80', async () => {
            await expect(store.tag(head, 'a'.repeat(201))).rejects.toThrow(/200/)
            expect((await store.tag(head, 'b'.repeat(200))).slug).toHaveLength(80)
        })

        it('rejects an unknown ref without creating a tag', async () => {
            await expect(store.tag('deadbeef', 'label')).rejects.toThrow()
            expect(await store.listTags()).toEqual([])
        })
    })

    describe('defaultDir', () => {
        const saved = { ...process.env }
        afterEach(() => {
            process.env = { ...saved }
        })

        it('prefers FLOWISE_VERSIONS_PATH, then DATABASE_PATH/versions', () => {
            process.env.FLOWISE_VERSIONS_PATH = '/explicit/versions'
            expect(VersionStore.defaultDir()).toBe('/explicit/versions')
            delete process.env.FLOWISE_VERSIONS_PATH
            process.env.DATABASE_PATH = '/data'
            expect(VersionStore.defaultDir()).toBe(path.join('/data', 'versions'))
        })
    })
})
