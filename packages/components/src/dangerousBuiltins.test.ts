import { deniedBuiltInDep, filterDangerousBuiltIns } from './utils'

/**
 * Regression tests for FINDING 0 (security assessment 2026-08-07, CONFIRMED HIGH).
 *
 * The live deployment set `TOOL_FUNCTION_BUILTIN_DEP=crypto,fs,path`, which was concatenated onto
 * the sandbox require allowlist unfiltered. A code node could then `require('fs')` and read
 * `/root/.flowise/database.sqlite` — every stored credential — and write to the mounted NAS. No vm2
 * escape was needed.
 *
 * The configuration has been corrected, but configuration is one edit from returning. These tests
 * pin the code-level refusal so the hole cannot be reopened silently.
 */

describe('filterDangerousBuiltIns', () => {
    const original = process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS
    let warn: jest.SpyInstance

    beforeEach(() => {
        delete process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
        warn.mockRestore()
        if (original === undefined) delete process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS
        else process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS = original
    })

    it('removes fs — the exact configuration that was exploited', () => {
        expect(filterDangerousBuiltIns(['crypto', 'fs', 'path'])).toEqual(['crypto', 'path'])
    })

    it('keeps path — it manipulates strings and opens nothing', () => {
        expect(filterDangerousBuiltIns(['path'])).toEqual(['path'])
    })

    it.each(deniedBuiltInDep)('removes %s', (dep) => {
        expect(filterDangerousBuiltIns(['crypto', dep])).toEqual(['crypto'])
    })

    it('warns rather than filtering silently, so a failing flow is explicable', () => {
        filterDangerousBuiltIns(['fs'])
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('fs'))
    })

    it('trims whitespace — the value arrives from a comma-split env var', () => {
        expect(filterDangerousBuiltIns([' fs ', ' crypto '])).toEqual(['crypto'])
    })

    it('drops empty entries from a trailing comma', () => {
        expect(filterDangerousBuiltIns(['crypto', '', '  '])).toEqual(['crypto'])
    })

    describe('the override', () => {
        it('is refused unless set to the exact acknowledgement string', () => {
            process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS = 'true'
            expect(filterDangerousBuiltIns(['fs'])).toEqual([])
            process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS = '1'
            expect(filterDangerousBuiltIns(['fs'])).toEqual([])
        })

        it('permits everything when the operator states it explicitly, and warns loudly', () => {
            process.env.TOOL_FUNCTION_ALLOW_DANGEROUS_BUILTINS = 'i-understand-this-grants-host-access'
            expect(filterDangerousBuiltIns(['fs', 'child_process'])).toEqual(['fs', 'child_process'])
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('host-access'))
        })
    })

    it('lists the builtins that actually matter', () => {
        // Named explicitly: a future edit that trims this list should have to change a test.
        for (const critical of ['fs', 'child_process', 'process', 'vm', 'module', 'worker_threads', 'net', 'dns']) {
            expect(deniedBuiltInDep).toContain(critical)
        }
    })
})
