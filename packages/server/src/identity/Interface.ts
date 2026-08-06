import { AuthenticatedUser } from './rbac/types'

/**
 * Identity wire types shared between the Apache-2.0 server tree and the identity layer.
 *
 * CLEAN-ROOM PROVENANCE. Every member below was derived from an Apache-2.0 CALL SITE — either
 * server code that reads the field, or `packages/ui` (also Apache-2.0) which is the other end of
 * the same wire. Nothing here was copied from, or checked against, the commercially-licensed tree.
 */

/**
 * The literals the shipped client compares for EQUALITY.
 *
 * Verbatim from `packages/ui/src/store/constant.js:29-38`, which is the client's own copy of this
 * map. `ErrorContext.jsx` and `signIn.jsx` switch on these strings, so a message that differs by a
 * character stops being handled and falls through to a generic failure.
 *
 * Two are deliberately never emitted by Flow-Wiser and are present only so the set stays a faithful
 * mirror of the client's:
 *
 *   INCORRECT_PASSWORD — turns `/auth/login` into an account-existence oracle. `AuthService` emits
 *                        UNKNOWN_USER for a bad address AND a bad password (see AuthService.ts).
 *   TOKEN_EXPIRED      — the session cookie has no separate "expired but present" state; an expired
 *                        session is indistinguishable from an absent one (INVALID_MISSING_TOKEN).
 */
export const ErrorMessage = {
    /** `ErrorContext.jsx:38` — triggers a clean client-side logout. */
    INVALID_MISSING_TOKEN: 'Invalid or Missing token',
    /** Mirror only — see note above. */
    TOKEN_EXPIRED: 'Token Expired',
    /** `client.js` interceptor — the one message that makes the client attempt a refresh. */
    REFRESH_TOKEN_EXPIRED: 'Refresh Token Expired',
    FORBIDDEN: 'Forbidden',
    UNKNOWN_USER: 'Unknown Username or Password',
    /** Mirror only — see note above. */
    INCORRECT_PASSWORD: 'Incorrect Password',
    INACTIVE_USER: 'Inactive User',
    INVALID_WORKSPACE: 'No Workspace Assigned',
    UNKNOWN_ERROR: 'Unknown Error'
} as const

export type ErrorMessageKey = keyof typeof ErrorMessage

/**
 * `req.user` as the Apache-2.0 tree types it.
 *
 * The RBAC layer's {@link AuthenticatedUser} is the same principal seen through a narrower lens:
 * every field there is optional because the API-key branch populates only some of them. This type
 * widens it with the account-shaped fields the session branch also carries, and TIGHTENS the three
 * fields the Apache-2.0 code dereferences without a guard.
 *
 * Required here, optional in `AuthenticatedUser` — each because of a specific unguarded read:
 *
 *   permissions          `services/apikey/index.ts:80`  `user.permissions.includes(permission)`
 *                        `services/apikey/index.ts:128` same, inside a filter
 *   activeWorkspaceId    `services/apikey/index.ts:187` assigned to `ApiKey.workspaceId`, a `string`
 *   activeOrganizationId `controllers/apikey/index.ts:14` passed to a `(organizationId: string)`
 *
 * Narrowing an optional property to a required one is assignment-compatible in the other
 * direction, so a `LoggedInUser` is still a valid `AuthenticatedUser` everywhere RBAC expects one.
 *
 * The remaining fields come from the login payload the client destructures in
 * `packages/ui/src/utils/authUtils.js:35-53` (`extractUser`). They are optional because the
 * API-key authentication branch (`packages/server/src/index.ts`) never sets them — an API key has
 * no email, no name and no last login.
 */
export interface LoggedInUser extends AuthenticatedUser {
    /** Sessions only; absent on the API-key branch. Read at `controllers/chatflows/index.ts:245`. */
    id?: string

    /** Effective grants for the active workspace. Dereferenced unguarded — see above. */
    permissions: string[]

    /** The scope `permissions` belongs to. Dereferenced unguarded — see above. */
    activeWorkspaceId: string

    /**
     * The tenant. Required for the same reason as the two above:
     * `controllers/apikey/index.ts:14` passes it to `getAllApiKeysByOrganization(organizationId:
     * string)` with no guard. Both authentication branches always populate it — the API-key branch
     * at `index.ts:283` and the session branch at `AuthService.authenticate` — so requiring it
     * describes what is actually built rather than tightening a genuinely optional field.
     */
    activeOrganizationId: string

    /** `authUtils.js:38` — logged in `services/apikey/index.ts:40` when features are missing. */
    email?: string
    /** `authUtils.js:39` */
    name?: string
    /** `authUtils.js:40` — `active` | `invited` | `inactive`, projected from OrganizationUser. */
    status?: string
    /** `authUtils.js:41` — the NAME of the role held in the active workspace. */
    role?: string
    /** `authUtils.js:42` — stored by the client as `localStorage.isSSO`. */
    isSSO?: boolean
    /** `authUtils.js:49` */
    lastLogin?: string
    /** `authUtils.js:51` — feeds the workspace switcher. */
    assignedWorkspaces?: { id: string; name: string }[]

    /**
     * MIGRATION §6. Not part of `extractUser`, so the shipped client ignores it; the session
     * middleware reads it to decide whether the subject is confined to the change-password route.
     */
    mustChangePassword?: boolean
}
