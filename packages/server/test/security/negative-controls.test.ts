/**
 * Negative tests: proof that each control FAILS when it should.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────────
 *
 * A QA pass on 3.1.4-fw8-rc2 found four separate controls in this repository that could not fail:
 *
 *   - the release gate counted a `skipped` check as success, and interpolated a tag name straight
 *     into a shell `run:` block
 *   - `audit:export --verify` printed a digest and exited 0 whether or not it matched
 *   - `credential:rotate-encryption` compared key VERSIONS, so a completely wrong key at the same
 *     version reported "nothing to do" on unrecoverable data
 *   - the Dockerfile's version assertion only ran when you passed the argument the docs omit
 *
 * Each had been "verified" by exercising the path where it succeeds. That is not a verification;
 * it is a demonstration. The rule this file enforces is: **a guard ships with a test that feeds it
 * the bad input and asserts it refuses.**
 *
 * Everything here is a pure unit test against real exported logic — no database, no network, no
 * container — so it runs in the `stubbed-orm` project and cannot be skipped for being slow.
 */

import { DEFAULT_DENY_LIST } from 'flowise-components'

describe('negative controls — each guard must refuse its bad input', () => {
    /**
     * SEC-B-02. `0.0.0.0` and `::1` were both denied; `::` was not, and it routes to loopback —
     * confirmed live, `curl http://[::]:3100/` returned 200. The positive test ("does it block
     * 127.0.0.1") passed throughout and told us nothing about this.
     */
    describe('SSRF deny list', () => {
        const denied = (value: string) => DEFAULT_DENY_LIST.some((entry: string) => entry === value)

        it('denies the IPv6 unspecified address, which routes to loopback', () => {
            expect(denied('::')).toBe(true)
        })

        it('still denies the addresses it always did', () => {
            for (const address of ['0.0.0.0', '::1', '169.254.169.254']) {
                expect(denied(address)).toBe(true)
            }
        })

        it('denies CGNAT and benchmark ranges', () => {
            expect(DEFAULT_DENY_LIST).toContain('100.64.0.0/10')
            expect(DEFAULT_DENY_LIST).toContain('198.18.0.0/15')
        })
    })

    /**
     * SEC-A-01 / C-1. The argon2 pattern excluded `,` from its character class, so it stopped
     * matching at the parameter block every real hash contains — leaving salt and digest in clear.
     * A comma-free argon2 string redacted correctly, which is why it survived review.
     */
    describe('audit redaction', () => {
        // Imported lazily so a failure here reports as an assertion, not a module-load error.
        const { redactString } = require('../../src/identity/crypto/redaction')

        it('redacts a REAL argon2 hash, parameter commas and all', () => {
            const real = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzYWx0$RdescudvJCsgt3ub+b+dWRWJTmaaJObG'
            const out = redactString(`hash=${real}`)
            expect(out).not.toContain('c29tZXNhbHRzYWx0') // salt
            expect(out).not.toContain('RdescudvJCsgt3ub') // digest
        })

        it('redacts a libpq keyword/value connection string, not only the URL form', () => {
            const out = redactString('host=db user=flowise password=S3cr3tP@ss dbname=flowise')
            expect(out).not.toContain('S3cr3tP@ss')
        })

        it('still redacts what it always did', () => {
            expect(redactString('postgres://admin:hunter2@db:5432/x')).not.toContain('hunter2')
            expect(redactString('Authorization: Bearer abcdef0123456789abcdef')).not.toContain('abcdef0123456789abcdef')
        })
    })
})
