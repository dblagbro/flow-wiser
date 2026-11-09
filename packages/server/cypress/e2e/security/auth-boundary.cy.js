/* global cy, describe, it, beforeEach */

describe('Anonymous authentication boundary', () => {
    beforeEach(() => {
        cy.clearCookies()
        cy.clearLocalStorage()
    })

    it('renders the sign-in form in the built UI', () => {
        cy.visit('http://localhost:3000/signin')
        cy.get('form input[type="password"]').should('be.visible')
        cy.get('form button[type="submit"]').should('be.visible')
    })

    it('redirects an anonymous credentials-page visit to sign-in', () => {
        cy.visit('http://localhost:3000/credentials')
        cy.location('pathname').should('eq', '/signin')
        cy.get('form input[type="password"]').should('be.visible')
    })

    it('refuses anonymous access to credentials and chatflows', () => {
        for (const resource of ['credentials', 'chatflows']) {
            cy.request({
                url: `http://localhost:3000/api/v1/${resource}`,
                headers: { 'X-Request-From': 'internal' },
                failOnStatusCode: false
            })
                .its('status')
                .should('eq', 401)
        }
    })
})
