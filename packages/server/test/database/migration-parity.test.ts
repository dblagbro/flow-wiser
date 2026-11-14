/**
 * Migration parity across the four engines (RM-07).
 *
 * AGENTS.md §2: "A migration added for one engine must be added for all four." Nothing enforced it,
 * and the directories hold 52 / 54 / 56 / 55 migrations — so "the counts differ" could not be told
 * apart from "someone forgot an engine". Every difference was read on 2026-11-13 and each is a
 * correction that only makes sense on the engine that has it; they are declared below, with the
 * reason. Anything else that exists for some engines and not others fails here.
 *
 * To add an engine-specific migration, add it to ENGINE_SPECIFIC with the reason it cannot apply to
 * the other engines. That is the point: the exception has to be written down.
 *
 * This reads the filesystem and each engine's `index.ts` as text. It does not run a migration —
 * the real-ORM project does that for SQLite.
 */
import fs from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/database/migrations')
const ENGINES = ['sqlite', 'postgres', 'mysql', 'mariadb'] as const
type Engine = (typeof ENGINES)[number]

/** Logical migration name → the engines it exists for, and why the others do not need it. */
const ENGINE_SPECIFIC: Record<string, { engines: Engine[]; why: string }> = {
    FieldTypes: {
        engines: ['postgres'],
        why: 'Casts id columns to uuid/varchar. Only Postgres has a uuid column type to have got wrong.'
    },
    ModifyExecutionSessionIdFieldType: {
        engines: ['postgres'],
        why: 'Casts execution.sessionId from uuid to varchar. The other engines created it as a string.'
    },
    LongTextColumn: {
        engines: ['mysql', 'mariadb'],
        why: 'TEXT → LONGTEXT. TEXT is capped at 64 KB only on MySQL/MariaDB; it is unbounded on SQLite and Postgres.'
    },
    ModifyExecutionDataColumnType: {
        engines: ['mysql', 'mariadb'],
        why: 'TEXT → LONGTEXT on execution.executionData, for the same 64 KB cap.'
    },
    FixDocumentStoreFileChunkLongText: {
        engines: ['mysql', 'mariadb'],
        why: 'TEXT → LONGTEXT on document_store_file_chunk, for the same 64 KB cap.'
    },
    FixErrorsColumnInEvaluationRun: {
        engines: ['mysql'],
        why: 'Re-runs AddErrorToEvaluationRun for MySQL, whose first attempt used a DEFAULT syntax MySQL rejects. MariaDB accepted its own spelling.'
    }
}

const FILE = /^(\d+)-(.+)\.ts$/

/**
 * A logical name is not unique within an engine — `AddTextToSpeechToChatFlow` exists twice in each —
 * so migrations are identified by name plus occurrence, in timestamp order: `Name`, `Name#2`.
 */
const migrationFiles = (engine: Engine): { file: string; timestamp: string; name: string; key: string }[] => {
    const seen = new Map<string, number>()
    return fs
        .readdirSync(path.join(MIGRATIONS_DIR, engine))
        .filter((file) => file !== 'index.ts' && file.endsWith('.ts'))
        .map((file) => {
            const match = FILE.exec(file)
            if (!match) throw new Error(`${engine}/${file} is not named <timestamp>-<Name>.ts`)
            return { file, timestamp: match[1], name: match[2] }
        })
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
        .map((migration) => {
            const occurrence = (seen.get(migration.name) ?? 0) + 1
            seen.set(migration.name, occurrence)
            return { ...migration, key: occurrence === 1 ? migration.name : `${migration.name}#${occurrence}` }
        })
}

describe('migration parity across engines (RM-07)', () => {
    const byEngine = Object.fromEntries(ENGINES.map((engine) => [engine, migrationFiles(engine)])) as Record<
        Engine,
        ReturnType<typeof migrationFiles>
    >

    it('finds migrations for every engine', () => {
        for (const engine of ENGINES) expect(byEngine[engine].length).toBeGreaterThan(40)
    })

    it('has no migration that exists for some engines but not others, unless declared engine-specific', () => {
        const presence = new Map<string, Set<Engine>>()
        for (const engine of ENGINES) {
            for (const { key } of byEngine[engine]) presence.set(key, (presence.get(key) ?? new Set<Engine>()).add(engine))
        }

        const undeclared: string[] = []
        for (const [name, engines] of presence) {
            if (engines.size === ENGINES.length) continue
            const declared = ENGINE_SPECIFIC[name]
            const actual = [...engines].sort().join(', ')
            if (!declared) undeclared.push(`${name}: exists only for ${actual}`)
            else if ([...declared.engines].sort().join(', ') !== actual) {
                undeclared.push(`${name}: declared for ${[...declared.engines].sort().join(', ')} but exists for ${actual}`)
            }
        }
        expect(undeclared).toEqual([])
    })

    it('declares no engine-specific migration that has since become universal or been removed', () => {
        const stale = Object.keys(ENGINE_SPECIFIC).filter((name) => {
            const engines = ENGINES.filter((engine) => byEngine[engine].some((m) => m.key === name))
            return engines.length === 0 || engines.length === ENGINES.length
        })
        expect(stale).toEqual([])
    })

    /**
     * Timestamps are NOT compared for equality: the migrations inherited from upstream were
     * generated separately per engine and differ by seconds to hours, and a timestamp is part of an
     * applied migration's identity, so they cannot be renamed. What has to hold is ORDER — the
     * migrations every engine shares must run in the same sequence on each, or two engines reach
     * different schemas from the same list.
     */
    it('runs the migrations shared by every engine in the same order on each', () => {
        const shared = (engine: Engine) =>
            byEngine[engine].map((m) => m.key).filter((key) => ENGINES.every((other) => byEngine[other].some((m) => m.key === key)))
        const reference = shared('sqlite')
        expect(reference.length).toBeGreaterThan(40)
        for (const engine of ENGINES) expect({ engine, order: shared(engine) }).toEqual({ engine, order: reference })
    })

    it('gives every migration written for this fork (identity layer onward) one timestamp across engines', () => {
        // 1780000000000 is the first clean-room identity migration. From there on the fork controls
        // the timestamps, so they are expected to match exactly.
        const timestamps = new Map<string, Set<string>>()
        for (const engine of ENGINES) {
            for (const { key, timestamp } of byEngine[engine]) {
                if (Number(timestamp) >= 1780000000000) timestamps.set(key, (timestamps.get(key) ?? new Set<string>()).add(timestamp))
            }
        }
        expect(timestamps.size).toBeGreaterThan(0)
        const split = [...timestamps].filter(([, set]) => set.size > 1).map(([key, set]) => `${key}: ${[...set].sort().join(' vs ')}`)
        expect(split).toEqual([])
    })

    it.each(ENGINES)('%s: index.ts registers every migration file, and nothing that does not exist', (engine) => {
        const index = fs.readFileSync(path.join(MIGRATIONS_DIR, engine, 'index.ts'), 'utf8')
        const imported = [...index.matchAll(/from '\.\/(\d+-[^']+)'/g)].map((m) => `${m[1]}.ts`).sort()
        const onDisk = byEngine[engine].map((m) => m.file).sort()
        expect(imported).toEqual(onDisk)

        // Imported is not the same as registered: each class must also appear in the exported array.
        const exported = /export const \w+\s*=\s*\[([\s\S]*?)\]/.exec(index)?.[1] ?? ''
        const unregistered = [...index.matchAll(/import \{ (\w+) \} from '\.\/\d+-/g)]
            .map((m) => m[1])
            .filter((cls) => !new RegExp(`\\b${cls}\\b`).test(exported))
        expect(unregistered).toEqual([])
    })
})
