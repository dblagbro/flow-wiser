/**
 * Manual mock for 'flowise-components'.
 *
 * `src/utils/logger.ts` imports `StorageProviderFactory` at module load and asks it for winston
 * transports. Every identity module reaches `logger` eventually, so a test that touches any of them
 * pulls in the entire component library — which transitively loads `jsdom`, whose dependency
 * `@tootallnate/once` ships ESM that Jest's CommonJS runtime cannot parse. The failure has nothing
 * to do with the code under test: it is a browser-DOM shim being dragged into a database test.
 *
 * The provider only decides WHERE log lines are written, and a test asserts on rows in SQLite, never
 * on log files. So the factory returns a provider with no transports at all: winston keeps its
 * console transport, nothing is written to disk, and the import chain stops here.
 *
 * Wire it up with `--moduleNameMapper '{"^flowise-components$": "<rootDir>/__mocks__/flowise-components.ts"}'`
 * — the same shape as the existing `__mocks__/typeorm.ts` mapping in `jest.config.js`.
 */

module.exports = {
    StorageProviderFactory: {
        getProvider: () => ({
            getLoggerTransports: () => []
        })
    }
}
