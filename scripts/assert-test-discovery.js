#!/usr/bin/env node
/**
 * Fail the build if a test file exists on disk that Jest does not run.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * `packages/server/test/identity/recovery-cli.test.ts` — 30 tests, and the only evidence that
 * REQUIREMENTS-MIGRATION §7 holds — was committed, counted as coverage, and never executed once.
 * Nothing reported that, because nothing was looking: a test suite that does not run produces no
 * failures, and no failures reads exactly like success. See G10 in docs/PROCESS-GAPS.md.
 *
 * A test-count floor was the other candidate and is worse. A floor has to be revised every time
 * someone legitimately deletes a test, so it drifts downward until it asserts nothing; and it cannot
 * distinguish "we removed 30 tests on purpose" from "30 tests silently stopped being discovered".
 * Comparing the filesystem to Jest's own discovery answers the actual question.
 *
 * ── What it does NOT catch ───────────────────────────────────────────────────────────────────
 *
 * A suite that is discovered but fails to LOAD is not this script's problem — Jest already reports
 * that as a failure and the build already goes red. The gap this closes is narrower and quieter: a
 * file Jest never considers at all, because `roots`, `testMatch`, `testRegex`, `testPathIgnorePatterns`
 * or a `projects` split silently stopped covering it.
 *
 * ── Intentional exclusions ───────────────────────────────────────────────────────────────────
 *
 * Sometimes a test file genuinely should not run in CI. That is fine, but it has to be DECLARED —
 * an entry in EXPECTED_UNDISCOVERED below, with a reason. The whole failure this script guards
 * against is an exclusion nobody wrote down, so an undeclared exclusion is the thing it must reject.
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages')

/** Anything Jest could plausibly be configured to treat as a test. */
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.next', 'cypress'])

/**
 * Test files that are deliberately not run, and why.
 * Format: 'packages/<pkg>/<path>': 'reason'
 */
const EXPECTED_UNDISCOVERED = {}

const walk = (dir, out = []) => {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return out
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out)
        } else if (TEST_FILE.test(entry.name)) {
            out.push(path.join(dir, entry.name))
        }
    }
    return out
}

const discoveredBy = (packageDir) => {
    // --listTests reports exactly what this package's config would run, honouring `projects`,
    // testPathIgnorePatterns and every other narrowing knob. That is the point: we are comparing
    // against Jest's real answer, not re-implementing its resolution and hoping the copy stays true.
    const raw = execFileSync('npx', ['jest', '--listTests'], {
        cwd: packageDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024
    })
    return new Set(
        raw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((file) => path.resolve(file))
    )
}

const main = () => {
    const packages = fs
        .readdirSync(PACKAGES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(PACKAGES_DIR, entry.name))
        .filter((dir) => fs.existsSync(path.join(dir, 'jest.config.js')) || fs.existsSync(path.join(dir, 'jest.config.ts')))

    const undiscovered = []
    let onDiskTotal = 0
    let discoveredTotal = 0

    for (const packageDir of packages) {
        const name = path.relative(REPO_ROOT, packageDir)
        const onDisk = walk(packageDir).map((file) => path.resolve(file))
        let discovered

        try {
            discovered = discoveredBy(packageDir)
        } catch (error) {
            // A config Jest cannot even load is a hard failure — it means every suite in this package
            // is currently running on assumptions nobody has verified.
            console.error(`FAIL  ${name}: jest --listTests did not run: ${String(error.message).split('\n')[0]}`)
            process.exitCode = 1
            continue
        }

        onDiskTotal += onDisk.length
        discoveredTotal += discovered.size

        const missing = onDisk.filter((file) => !discovered.has(file))
        for (const file of missing) undiscovered.push(path.relative(REPO_ROOT, file))

        console.info(
            `  ${name.padEnd(22)} ${String(discovered.size).padStart(3)} discovered / ${String(onDisk.length).padStart(3)} on disk`
        )
    }

    const undeclared = undiscovered.filter((file) => !(file in EXPECTED_UNDISCOVERED))

    console.info(`\n${discoveredTotal} test file(s) discovered, ${onDiskTotal} on disk.`)

    if (undeclared.length > 0) {
        console.error(`\nFAIL: ${undeclared.length} test file(s) exist but Jest will never run them:\n`)
        for (const file of undeclared) console.error(`  ${file}`)
        console.error(
            '\nA suite that does not run produces no failures, and no failures looks exactly like\n' +
                'success — this is how 30 recovery-CLI tests sat dead for weeks (G10).\n\n' +
                'Either fix the config so the file is discovered, or add it to EXPECTED_UNDISCOVERED\n' +
                'in scripts/assert-test-discovery.js WITH A REASON. An exclusion is acceptable; an\n' +
                'exclusion nobody wrote down is the defect this check exists to catch.'
        )
        process.exitCode = 1
        return
    }

    for (const [file, reason] of Object.entries(EXPECTED_UNDISCOVERED)) {
        if (!undiscovered.includes(file)) {
            console.error(`\nFAIL: ${file} is declared in EXPECTED_UNDISCOVERED but IS discovered.`)
            console.error(`      Reason on record: ${reason}`)
            console.error('      Remove the entry — a stale exclusion hides the next real one.')
            process.exitCode = 1
            return
        }
    }

    if (process.exitCode !== 1) console.info('OK: every test file on disk is discovered by Jest.')
}

main()
