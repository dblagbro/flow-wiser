/**
 * Flow history index (I-08).
 *
 * The index is a cache over the version repository, so the tests hold it to two things: it must
 * answer exactly what walking the log answers, and it must not walk the log to do it. Everything
 * else here is about the cache being wrong, missing or half-written — in which case history must
 * still come back right.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import git from 'isomorphic-git'
import logger from '../utils/logger'
import { FlowHistoryIndex } from './historyIndex'
import { VersionStore } from './VersionStore'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

// Every commit is real file I/O; a loaded machine must not turn that into a failure.
jest.setTimeout(60_000)

const flow = (text: string): string => JSON.stringify({ nodes: [{ id: 'n1', data: { text } }], edges: [] })

describe('flow history index', () => {
    let sandbox: string
    let dir: string
    let store: VersionStore
    let tick: number

    const indexRoot = () => path.join(dir, '.git', 'flow-history')
    const save = async (chatflowId: string, text: string, meta: Record<string, unknown> = {}) =>
        (await store.captureFlow({ chatflowId, flowData: flow(text), meta, when: new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) }))!
    /** What the log walk says, asked of git directly — the answer the index has to reproduce. */
    const walked = async (chatflowId: string, limit: number): Promise<string[]> =>
        (await git.log({ fs, dir, filepath: `flows/${chatflowId}.json`, depth: limit, force: true })).slice(0, limit).map((e) => e.oid)
    const oids = async (chatflowId: string, limit = 100): Promise<string[]> => (await store.history(chatflowId, limit)).map((e) => e.oid)

    beforeEach(async () => {
        jest.clearAllMocks()
        sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fw-history-index-'))
        dir = path.join(sandbox, 'data', 'versions')
        store = new VersionStore({ dir })
        tick = 0
    })
    afterEach(async () => {
        jest.restoreAllMocks()
        await fs.promises.rm(sandbox, { recursive: true, force: true })
    })

    describe('answers what the log walk answers', () => {
        it('across interleaved saves, metadata-only saves, deletions and a later re-creation', async () => {
            const ids = ['a', 'b', 'c', 'd']
            // Deterministic pseudo-random script: no seed to chase when it fails.
            let state = 7
            const next = (n: number) => (state = (state * 1103515245 + 12345) % 2147483648) % n
            const alive = new Set<string>()
            for (let step = 0; step < 36; step++) {
                const id = ids[next(ids.length)]
                const action = next(10)
                if (action === 0 && alive.has(id)) {
                    await store.captureDeletion({ chatflowId: id, name: id })
                    alive.delete(id)
                } else if (action === 1 && alive.has(id)) {
                    await store.captureFlow({
                        chatflowId: id,
                        flowData: await store.readAt(id, 'HEAD'),
                        meta: { name: `renamed at step ${step}` },
                        when: new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
                    })
                } else {
                    await save(id, `${id}-${step}`)
                    alive.add(id)
                }
                // Ask part-way through as well, so the index is extended many times, not built once.
                if (step % 9 === 0) for (const each of ids) expect(await oids(each)).toEqual(await walked(each, 100))
            }
            let total = 0
            for (const id of ids) {
                const reference = await walked(id, 100)
                total += reference.length
                for (const limit of [1, 2, 3, reference.length, reference.length + 5]) {
                    expect(await oids(id, limit)).toEqual(reference.slice(0, limit))
                }
            }
            // The script must really have produced histories worth comparing.
            expect(total).toBeGreaterThan(20)
            expect(logger.warn).not.toHaveBeenCalled()
        }, 120_000)

        it('leaves a metadata-only save out, as the walk does: the flow itself did not change', async () => {
            const v1 = await save('f1', 'v1', { deployed: false })
            await store.captureFlow({ chatflowId: 'f1', flowData: flow('v1'), meta: { deployed: true } })
            expect(await oids('f1')).toEqual([v1])
        })

        it('ends a deleted flow with its deletion', async () => {
            const v1 = await save('f1', 'v1')
            const deleted = (await store.captureDeletion({ chatflowId: 'f1' }))!
            expect(await oids('f1')).toEqual([deleted, v1])
            expect(await oids('f1')).toEqual(await walked('f1', 100))
        })

        // The one place the index and the walk disagree, and the index is the one that is right.
        // The walk compares each commit with the last commit in which it SAW the file, so a flow
        // deleted and later re-created with identical content loses its deletion from the walk.
        it('keeps a deletion that the walk drops when the flow is re-created with identical content', async () => {
            const v1 = await save('f1', 'same')
            const deleted = (await store.captureDeletion({ chatflowId: 'f1' }))!
            const again = await save('f1', 'same')
            expect(await walked('f1', 100)).toEqual([again, v1])
            expect(await oids('f1')).toEqual([again, deleted, v1])
        })

        it('returns nothing for a flow that has no commits', async () => {
            await save('f1', 'v1')
            expect(await oids('never-saved')).toEqual([])
        })
    })

    describe('does not walk the log', () => {
        it('opens only the commits it returns once the index is up to date', async () => {
            const mine = [await save('old', 'o1'), await save('old', 'o2'), await save('old', 'o3')].reverse()
            for (let i = 0; i < 40; i++) await save(`other-${i % 5}`, `x${i}`)
            await store.history('old') // brings the index up to date

            const log = jest.spyOn(git, 'log')
            const readCommit = jest.spyOn(git, 'readCommit')
            expect(await oids('old', 2)).toEqual(mine.slice(0, 2))
            expect(log).not.toHaveBeenCalled()
            expect(readCommit).toHaveBeenCalledTimes(2)
        })

        it('scans only the commits made since the last request', async () => {
            await save('old', 'o1')
            for (let i = 0; i < 30; i++) await save(`other-${i % 5}`, `x${i}`)
            await store.history('old')

            const newer = [await save('old', 'o2'), await save('other-0', 'y')]
            const readCommit = jest.spyOn(git, 'readCommit')
            expect((await oids('old'))[0]).toBe(newer[0])
            // Two new commits to scan, two commits of this flow to return.
            expect(readCommit.mock.calls.length).toBeLessThanOrEqual(4)
        })

        it('serves a second store on the same directory from the index the first one built', async () => {
            const v1 = await save('f1', 'v1')
            for (let i = 0; i < 10; i++) await save('other', `x${i}`)
            await store.history('f1')

            const readCommit = jest.spyOn(git, 'readCommit')
            expect((await new VersionStore({ dir }).history('f1')).map((e) => e.oid)).toEqual([v1])
            expect(readCommit).toHaveBeenCalledTimes(1)
        })
    })

    describe('is only a cache', () => {
        it('lives inside .git, so it is never committed and never shows as a change', async () => {
            await save('f1', 'v1')
            await store.history('f1')
            expect(fs.existsSync(path.join(indexRoot(), 'SCANNED'))).toBe(true)
            const dirty = (await git.statusMatrix({ fs, dir })).filter(
                ([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1)
            )
            expect(dirty).toEqual([])
            expect(fs.readdirSync(dir).sort()).toEqual(['.git', 'flows', 'meta'])
        })

        it('is rebuilt after being deleted', async () => {
            const expected = [await save('f1', 'v1'), await save('f1', 'v2')].reverse()
            await store.history('f1')
            await fs.promises.rm(indexRoot(), { recursive: true, force: true })
            expect(await oids('f1')).toEqual(expected)
            expect(fs.existsSync(path.join(indexRoot(), 'SCANNED'))).toBe(true)
        })

        it('is thrown away when its marker is not a commit in this history', async () => {
            const v1 = await save('f1', 'v1')
            await store.history('f1')
            // A restored backup: entries from some other history, and a marker to match.
            await fs.promises.writeFile(path.join(indexRoot(), 'SCANNED'), 'a'.repeat(40) + '\n')
            await fs.promises.writeFile(path.join(indexRoot(), 'flows', 'f1'), 'b'.repeat(40) + '\n')
            const v2 = await save('f1', 'v2')
            expect(await oids('f1')).toEqual([v2, v1])
            expect(logger.warn).not.toHaveBeenCalled()
        })

        it('is thrown away when the marker is unreadable', async () => {
            const v1 = await save('f1', 'v1')
            await store.history('f1')
            await fs.promises.writeFile(path.join(indexRoot(), 'SCANNED'), 'not a commit id')
            expect(await oids('f1')).toEqual([v1])
        })

        it('does not repeat entries when a scan was interrupted before its marker moved', async () => {
            const v1 = await save('f1', 'v1')
            await store.history('f1')
            const markerAfterV1 = await fs.promises.readFile(path.join(indexRoot(), 'SCANNED'), 'utf8')
            const v2 = await save('f1', 'v2')
            await store.history('f1')
            // The entries for v2 are on disk; put the marker back as if the scan had died first.
            await fs.promises.writeFile(path.join(indexRoot(), 'SCANNED'), markerAfterV1)
            expect(await oids('f1')).toEqual([v2, v1])
            expect(await oids('f1')).toEqual([v2, v1])
        })

        it.each([
            ['garbage in a flow file', 'this is not an oid\n'],
            ['a commit id that does not exist', 'c'.repeat(40) + '\n']
        ])('falls back to the walk, warns once and rebuilds on %s', async (_name, contents) => {
            const expected = [await save('f1', 'v1'), await save('f1', 'v2')].reverse()
            await store.history('f1')
            await fs.promises.appendFile(path.join(indexRoot(), 'flows', 'f1'), contents)

            expect(await oids('f1')).toEqual(expected)
            expect(logger.warn).toHaveBeenCalledTimes(1)
            expect((logger.warn as jest.Mock).mock.calls[0][0]).toMatch(/flow history index could not be used/)

            const log = jest.spyOn(git, 'log')
            expect(await oids('f1')).toEqual(expected)
            expect(log).not.toHaveBeenCalled()
        })

        // Asked of the index directly: what it hands back is passed to git as an object id, so
        // anything that is not one is refused here, not left for git to make sense of.
        it('refuses to return anything that is not a commit id', async () => {
            await save('f1', 'v1')
            await store.history('f1')
            await fs.promises.appendFile(path.join(indexRoot(), 'flows', 'f1'), '../../HEAD\n')
            await expect(new FlowHistoryIndex(dir).commitsFor('f1')).rejects.toThrow(/not a commit id/)
        })

        it('falls back to the walk when the index directory cannot be written', async () => {
            const v1 = await save('f1', 'v1')
            // A file where the directory should be.
            await fs.promises.writeFile(indexRoot(), 'in the way')
            jest.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('read-only'))
            expect(await oids('f1')).toEqual([v1])
            expect(logger.warn).toHaveBeenCalledTimes(1)
        })

        it('gives concurrent requests the same answer and writes each entry once', async () => {
            const expected = [await save('f1', 'v1'), await save('f1', 'v2'), await save('f1', 'v3')].reverse()
            const answers = await Promise.all(Array.from({ length: 8 }, () => oids('f1')))
            for (const answer of answers) expect(answer).toEqual(expected)
            const lines = (await fs.promises.readFile(path.join(indexRoot(), 'flows', 'f1'), 'utf8')).trim().split('\n')
            expect(lines).toEqual([...expected].reverse())
        })
    })

    describe('flow ids are never trusted as file names', () => {
        it.each(['a.b', 'with space', '-leading-dash', 'x'.repeat(129), 'ünï', 'a/b'])('does not index %j', (id) => {
            expect(FlowHistoryIndex.isIndexable(id)).toBe(false)
        })

        it.each(['f1', '3f2c1a9e-7b1d-4c5e-9a44-0d6b8f1e2a37', 'A_b-9'])('indexes %j', (id) => {
            expect(FlowHistoryIndex.isIndexable(id)).toBe(true)
        })

        it('still returns the history of a flow whose id it will not index, by walking', async () => {
            const v1 = (await store.captureFlow({ chatflowId: 'a.b', flowData: flow('v1') }))!
            const log = jest.spyOn(git, 'log')
            expect(await oids('a.b')).toEqual([v1])
            expect(log).toHaveBeenCalledTimes(1)
            expect(fs.existsSync(path.join(indexRoot(), 'flows', 'a.b'))).toBe(false)
            expect(logger.warn).not.toHaveBeenCalled()
        })
    })
})
