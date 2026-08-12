/**
 * Two projects, because two kinds of test need two different `typeorm`.
 *
 * Most suites here test a module in isolation and only need TypeORM's decorators to be callable so
 * an entity class can be defined. For those, `__mocks__/typeorm.ts` replaces every decorator with a
 * no-op — no driver, no connection, fast.
 *
 * A few suites test the database itself: migrations, the recovery CLI, `doctor`. Those build a real
 * SQLite DataSource, run the real migration chain against it, and assert on the resulting schema.
 * A stubbed `DataSource` has no `initialize()`, so under the global mock they fail on the first line
 * of their fixture.
 *
 * `moduleNameMapper` is resolution-level, so it cannot be lifted per-file — `jest.unmock` and
 * `jest.requireActual` both still go through it. Splitting into projects is the supported way to
 * give one set of files a different resolution from another.
 *
 * This mattered less than it should have until 2026-08-09, because both real-ORM suites were failing
 * to load for an unrelated reason (a pnpm override pulled an ESM-only `@tootallnate/once` into a CJS
 * require chain) and their 30 tests had never run in CI at all. Fixing the override exposed the mock
 * problem underneath it.
 */

const base = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    // Include the package's own node_modules so that Jest can resolve
    // symlinked pnpm dependencies when tests live inside src/
    modulePaths: ['<rootDir>/node_modules']
}

// uuid v10+ ships ESM-only; redirect to the CJS dist so Jest can require it. Needed by both
// projects.
const uuidToCjs = { '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js' }

/**
 * Suites that need the real ORM. Keep this list explicit rather than pattern-matched: a test landing
 * in the real-ORM project by accident gets a slow, driver-backed run and a confusing failure, and
 * the reverse is worse — it silently gets stubs.
 */
const REAL_ORM_SUITES = ['<rootDir>/test/identity/recovery-cli.test.ts']

module.exports = {
    projects: [
        {
            ...base,
            displayName: 'stubbed-orm',
            // `test/` holds the suites that verify a subsystem end to end rather than a single
            // module — they live outside src/ because they are not shipped, and they must be
            // discovered or they are decorative.
            roots: ['<rootDir>/src', '<rootDir>/test'],
            testRegex: '.*\\.test\\.tsx?$',
            testPathIgnorePatterns: ['/node_modules/', ...REAL_ORM_SUITES.map((p) => p.replace('<rootDir>', ''))],
            moduleNameMapper: {
                ...uuidToCjs,
                '^typeorm$': '<rootDir>/__mocks__/typeorm.ts'
            }
        },
        {
            ...base,
            displayName: 'real-orm',
            roots: ['<rootDir>/test'],
            testMatch: REAL_ORM_SUITES,
            // No typeorm mapping: these suites want the real DataSource and the real driver.
            moduleNameMapper: uuidToCjs
        }
    ],

    // Display individual test results with the test suite hierarchy.
    verbose: true
}
