/**
 * Regression guard for the Account-page password change (two defects, 2026-08-28).
 *
 * 1. The handler called `userApi.updateUser` -> `PUT /user`, which is one of five deliberate
 *    501 stubs on this build. Changing your own password was impossible from the UI; it failed
 *    with "User administration is not available on this instance". The working endpoint is
 *    `POST /account/reset-password`.
 *
 * 2. The success snackbar was queued AFTER `logoutApi.request()`, which tears down the session
 *    and redirects to /signin in the same tick. Neither the success nor the failure message was
 *    ever visible, so a successful change looked identical to a failure.
 *
 * This is a SOURCE-LEVEL guard, not a behavioural test. `jest.config.js` here runs in the `node`
 * environment and matches only `*.test.js`, so rendering the view would mean pulling in MUI, the
 * redux store and the router. The behavioural evidence is the browser run recorded in
 * docs/bug-log.md; this file exists to stop the endpoint being repointed back at a 501 stub and
 * to stop the logout being reordered ahead of the confirmation.
 */
const fs = require('fs')
const path = require('path')

const VIEW = path.join(__dirname, 'index.jsx')
const source = fs.readFileSync(VIEW, 'utf8')

// The password-change handler only; the file has other handlers that legitimately touch other APIs.
const handler = (() => {
    const start = source.indexOf('const savePassword')
    expect(start).toBeGreaterThan(-1)
    // Up to the next top-level `const <name> = ` declaration at the same indent.
    const rest = source.slice(start + 1)
    const end = rest.search(/\n {4}const \w+ = /)
    return end === -1 ? rest : rest.slice(0, end)
})()

describe('account password change', () => {
    it('uses the account reset-password endpoint, not the 501 user-admin stub', () => {
        expect(handler).toMatch(/await\s+accountApi\.resetPassword\(/)
        // Match the call, not the word -- a comment in the handler names the old endpoint.
        expect(handler).not.toMatch(/await\s+userApi\.updateUser\(/)
    })

    it('sends the payload shape POST /account/reset-password expects', () => {
        // changeOwnPassword identifies the user from the session but still verifies the email,
        // so an omitted or mismatched email is rejected.
        expect(handler).toMatch(/email:\s*currentUser\.email/)
        expect(handler).toMatch(/currentPassword:\s*oldPassword/)
        expect(handler).toMatch(/password:\s*newPassword/)
    })

    it('confirms before signing out, so the outcome is visible', () => {
        const toast = handler.indexOf("message: 'Password updated'")
        const logout = handler.indexOf('logoutApi.request()')
        expect(toast).toBeGreaterThan(-1)
        expect(logout).toBeGreaterThan(-1)
        expect(toast).toBeLessThan(logout)
    })

    it('gives the confirmation time to render before the redirect unmounts it', () => {
        // Ordering alone is not enough -- the redirect happens in the same tick.
        expect(handler).toMatch(/setTimeout\(resolve,\s*\d+\)[\s\S]{0,120}logoutApi\.request\(\)/)
    })
})
