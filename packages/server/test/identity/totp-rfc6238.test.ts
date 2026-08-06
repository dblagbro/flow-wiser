/**
 * RFC 6238 / RFC 4226 published test vectors for the TOTP implementation.
 *
 * These are PERMANENT, not scaffolding. A TOTP implementation that passes its author's own
 * hand-written expectations proves only that it is self-consistent; matching the values
 * published in the specification is what proves it is CORRECT — and therefore that a code
 * from Google Authenticator, 1Password or a YubiKey will actually verify.
 *
 * They are also a regression guard: every one of these vectors would still pass if the
 * implementation were subtly wrong in a way that only bit users on a different digest, a
 * different digit count, or beyond 2^31 seconds. T=20000000000 exists specifically to catch
 * a 32-bit counter truncation, which is the classic TOTP bug and does not surface until
 * 2603.
 *
 * Vectors: RFC 6238 Appendix B (TOTP) and RFC 4226 Appendix D (HOTP).
 */
import { totpAtStep, hotp } from '../../src/identity/services/TotpService'

// RFC 6238 Appendix B seeds. The ASCII string is repeated to the digest's block size.
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii') // 20 bytes
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii') // 32 bytes
const SEED_SHA512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii') // 64

interface Vector {
    time: number
    sha1: string
    sha256: string
    sha512: string
}

/** RFC 6238 Appendix B, verbatim. 8 digits, 30-second step. */
const RFC6238_VECTORS: Vector[] = [
    { time: 59, sha1: '94287082', sha256: '46119246', sha512: '90693936' },
    { time: 1111111109, sha1: '07081804', sha256: '68084774', sha512: '25091201' },
    { time: 1111111111, sha1: '14050471', sha256: '67062674', sha512: '99943326' },
    { time: 1234567890, sha1: '89005924', sha256: '91819424', sha512: '93441116' },
    { time: 2000000000, sha1: '69279037', sha256: '90698825', sha512: '38618901' },
    // Beyond 2^31 seconds — catches 32-bit counter truncation.
    { time: 20000000000, sha1: '65353130', sha256: '77737706', sha512: '47863826' }
]

describe('TOTP — RFC 6238 Appendix B published vectors', () => {
    for (const v of RFC6238_VECTORS) {
        it(`T=${v.time} matches the published values for all three digests`, () => {
            const step = Math.floor(v.time / 30)
            expect(totpAtStep(SEED_SHA1, step, 8, 'sha1')).toBe(v.sha1)
            expect(totpAtStep(SEED_SHA256, step, 8, 'sha256')).toBe(v.sha256)
            expect(totpAtStep(SEED_SHA512, step, 8, 'sha512')).toBe(v.sha512)
        })
    }
})

/** RFC 4226 Appendix D — HOTP is TOTP with an explicit counter, so this pins truncation. */
const RFC4226_HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']

describe('HOTP — RFC 4226 Appendix D published vectors', () => {
    it('matches all ten counter values at 6 digits', () => {
        RFC4226_HOTP.forEach((expected, counter) => {
            expect(hotp(SEED_SHA1, counter, 6, 'sha1')).toBe(expected)
        })
    })
})
