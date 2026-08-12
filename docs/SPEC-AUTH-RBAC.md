# Clean-Room Specification: Auth / Identity / RBAC Subsystem

**Status:** Implementation-ready interface specification
**Derivation basis:** Apache-2.0 sources only — `packages/ui/**`, `packages/server/src/routes/**`,
`packages/server/src/controllers/**`, `packages/server/src/utils/constants.ts`,
`packages/server/src/index.ts`, `packages/server/src/Interface.ts`.

> **Clean-room provenance.** Nothing under `packages/server/src/enterprise/` and nothing in
> `packages/server/src/IdentityManager.ts` was read while producing this document. Those paths
> are referenced only as *import specifiers observed in Apache-2.0 files* (e.g.
> `packages/server/src/routes/apikey/index.ts:3`), never as content. Every behavioural claim below
> is derived from (a) how the Apache-2.0 UI **constructs** requests and **consumes** responses, or
> (b) how Apache-2.0 route/controller/bootstrap code **calls** the identity layer. Where the
> interface does not determine behaviour, it is recorded in §F (Gaps) rather than guessed.

---

## Table of contents

- [0. Transport & conventions](#0-transport--conventions)
- [A. HTTP API surface](#a-http-api-surface)
- [B. Permission vocabulary](#b-permission-vocabulary)
- [C. Middleware contract](#c-middleware-contract)
- [D. Data model requirements](#d-data-model-requirements)
- [E. Session / token handling](#e-session--token-handling)
- [F. Gaps — decisions left to the implementer](#f-gaps--decisions-left-to-the-implementer)

---

## 0. Transport & conventions

### 0.1 Base client

All UI→server calls in scope go through one axios instance.

| Property | Value | Citation |
|---|---|---|
| `baseURL` | `` `${baseURL}/api/v1` `` where `baseURL = import.meta.env.VITE_API_BASE_URL \|\| window.location.origin` | `packages/ui/src/api/client.js:6`; `packages/ui/src/store/constant.js:25` |
| `Content-type` | `application/json` | `packages/ui/src/api/client.js:8` |
| `x-request-from` | `internal` (constant, on **every** request) | `packages/ui/src/api/client.js:9` |
| `withCredentials` | `true` | `packages/ui/src/api/client.js:11` |

**Consequences the server MUST honour:**

1. **Cookie-based auth.** `withCredentials: true` and the total absence of any `Authorization`
   header construction anywhere in `packages/ui/src/api/**` mean credentials travel as cookies.
   CORS responses must therefore set `Access-Control-Allow-Credentials: true` and a concrete
   (non-`*`) `Access-Control-Allow-Origin`.
2. **`x-request-from: internal` selects the authentication scheme.** The bootstrap
   (`packages/server/src/index.ts:239-240`) branches on exactly this header: when it equals
   `'internal'` the request is authenticated as a *user session*; otherwise it is authenticated as
   an *API key*. This header is the sole discriminator.
3. Query parameters are built by **raw template interpolation**, not `encodeURIComponent` — see
   e.g. `packages/ui/src/api/user.js:4`, `packages/ui/src/api/role.js:3`. Ids are UUID-shaped so
   this is safe in practice, but the server must not rely on the client encoding anything.

### 0.2 Path gating in the bootstrap

`packages/server/src/index.ts:230-298` establishes the request pipeline for every path matching
`/api/v1` (case-insensitively). The order is load-bearing:

```
1. path matches /api/v1 case-INSENSITIVELY?          index.ts:232
     no  -> next()  (static assets, /canvas)         index.ts:296-297
2. path matches /api/v1 case-SENSITIVELY?            index.ts:234
     no  -> 401 { error: 'Unauthorized Access' }     index.ts:294
3. path startsWith any whitelisted prefix?           index.ts:236
     yes -> next()   (NO authentication at all)      index.ts:238
4. header x-request-from === 'internal'?             index.ts:239
     yes -> verifyToken(req, res, next)              index.ts:240
5. otherwise: API-key path                           index.ts:242-292
```

An implementer MUST reproduce steps 1–2: a lowercase-only match with a case-sensitive mismatch
(e.g. `/API/V1/user`) is rejected with **401**, not routed.

### 0.3 Unauthenticated (whitelisted) endpoints

Verbatim from `packages/server/src/utils/constants.ts:6-58` (`WHITELIST_URLS`), filtered at
runtime by a `denylistURLs` set (`packages/server/src/index.ts:224`). Identity-relevant entries:

| Prefix | constants.ts line |
|---|---|
| `/api/v1/auth/resolve` | `:27` |
| `/api/v1/auth/login` | `:28` |
| `/api/v1/auth/refreshToken` | `:29` |
| `/api/v1/settings` | `:30` |
| `/api/v1/account/logout` | `:31` |
| `/api/v1/account/verify` | `:32` |
| `/api/v1/account/register` | `:33` |
| `/api/v1/account/resend-verification` | `:34` |
| `/api/v1/account/forgot-password` | `:35` |
| `/api/v1/account/reset-password` | `:36` |
| `/api/v1/account/confirm-email-change` | `:37` |
| `/api/v1/loginmethod/default` | `:38` |
| `/api/v1/pricing` | `:39` |
| `/api/v1/user/test` | `:40` |
| `/api/v1/verify/apikey/` | `:7` |
| `/api/v1/ping`, `/api/v1/version` | `:24`, `:25` |
| SSO login/logout/callback URIs for azure, google, auth0, github | `:46-57` |

> Note the whitelist is **prefix-based** (`req.path.startsWith(url)`, `index.ts:236`). Any endpoint
> whose path begins with a whitelisted prefix is also unauthenticated. In particular
> `/api/v1/auth/resolve`, `/api/v1/auth/login` and `/api/v1/auth/refreshToken` are whitelisted but
> `/api/v1/auth/permissions/:type` and `/api/v1/auth/sso-success` are **not** — they require a session.

### 0.4 API-key-blacklisted endpoints

`packages/server/src/utils/constants.ts:60-67` — these paths are reachable **only** by a user
session, never by an API key; an API-key request to them returns
`401 { error: 'Unauthorized Access' }` (`packages/server/src/index.ts:242-245`):

```
/api/v1/nvidia-nim
/api/v1/account/delete
/api/v1/files
/api/v1/organizationuser
/api/v1/workspace
/api/v1/workspaceuser
```

### 0.5 Canonical error-message strings

The UI compares response `message` values against these exact literals
(`packages/ui/src/store/constant.js:29-38`):

| Constant | Literal | Used at |
|---|---|---|
| `INVALID_MISSING_TOKEN` | `Invalid or Missing token` | `packages/ui/src/store/context/ErrorContext.jsx:38` |
| `TOKEN_EXPIRED` | `Token Expired` | `packages/ui/src/api/client.js:21` |
| `REFRESH_TOKEN_EXPIRED` | `Refresh Token Expired` | `packages/ui/src/store/constant.js:32` |
| `FORBIDDEN` | `Forbidden` | `packages/ui/src/store/constant.js:33` |
| `UNKNOWN_USER` | `Unknown Username or Password` | `packages/ui/src/store/constant.js:34` |
| `INCORRECT_PASSWORD` | `Incorrect Password` | `packages/ui/src/store/constant.js:35` |
| `INACTIVE_USER` | `Inactive User` | `packages/ui/src/store/constant.js:36` |
| `INVALID_WORKSPACE` | `No Workspace Assigned` | `packages/ui/src/store/constant.js:37` |
| `UNKNOWN_ERROR` | `Unknown Error` | `packages/ui/src/store/constant.js:38` |

Server-side counterparts observed in Apache-2.0 code
(`packages/server/src/utils/constants.ts:69-77`, `:79-86`):

```
GeneralErrorMessage:   Forbidden | Unauthorized | Unhandled Edge Case | Invalid Password |
                       Not Allowed To Delete Owner | Internal Server Error |
                       Email (SMTP) is not configured on this server
GeneralSuccessMessage: Resource Created Successful | Resource Updated Successful |
                       Resource Deleted Successful | Resource Fetched Successful |
                       Login Successful | Logout Successful
```

Additional literals the UI tests for equality (not in the constants file):

- `'User Email Unverified'` — `packages/ui/src/views/auth/signIn.jsx:157`; when the login error
  message equals this, the UI reveals a "Resend Verification Email" button.
- `'logged_out'` — logout response `message`; `packages/ui/src/views/account/index.jsx:151`,
  `packages/ui/src/layout/MainLayout/Header/WorkspaceSwitcher/index.jsx:210`.
- `'Account deleted'` — delete-account response `message`; `packages/ui/src/views/account/index.jsx:161`.
- `'unauthorized'` / `'subscription_canceled'` — 401 body `error` values driving redirect;
  `packages/ui/src/utils/genericHelper.js:1071,1073`.
- `'authentication_rate_limit'` — 429 body `type`; `packages/ui/src/store/context/ErrorContext.jsx:18`.

---

## A. HTTP API surface

53 distinct endpoints. All paths are relative to `/api/v1`.

### A.1 Authentication — `/auth`

#### `POST /auth/login`

- **Auth:** none (whitelisted, `constants.ts:28`).
- **Client:** `packages/ui/src/api/auth.js:5`.
- **Request body:** `{ email: string, password: string }` — built at
  `packages/ui/src/views/auth/signIn.jsx:80-83`; identically at
  `packages/ui/src/views/organization/index.jsx:180-183`.
- **200 response:** the *login payload*. Its field set is fully determined by
  `AuthUtils.extractUser` + `AuthUtils.updateStateAndLocalStorage`
  (`packages/ui/src/utils/authUtils.js:35-71`), which the reducer applies verbatim
  (`packages/ui/src/store/reducers/authSlice.js:24-26`):

  ```jsonc
  {
    "id":                                 "string",   // authUtils.js:37
    "email":                              "string",   // authUtils.js:38
    "name":                               "string",   // authUtils.js:39
    "status":                             "string",   // authUtils.js:40
    "role":                               "string",   // authUtils.js:41
    "isSSO":                              true,       // authUtils.js:42
    "activeOrganizationId":               "string",   // authUtils.js:43
    "activeOrganizationSubscriptionId":   "string",   // authUtils.js:44
    "activeOrganizationCustomerId":       "string",   // authUtils.js:45
    "activeOrganizationProductId":        "string",   // authUtils.js:46
    "activeWorkspaceId":                  "string",   // authUtils.js:47
    "activeWorkspace":                    "string",   // authUtils.js:48  — the workspace NAME
    "lastLogin":                          "ISO-8601", // authUtils.js:49
    "isOrganizationAdmin":                false,      // authUtils.js:50
    "assignedWorkspaces": [ { "id": "string", "name": "string" } ], // authUtils.js:51, authSlice.js:51-59
    "permissions":  ["chatflows:view", "..."],        // authUtils.js:52, :61, :69
    "features":     { "feat:workspaces": "true" },    // authUtils.js:62, :70
    "token":        "string"                          // authUtils.js:60
  }
  ```

  Notes on individual fields:
  - `activeWorkspace` is a **display name**, not an id — rendered directly at
    `packages/ui/src/layout/MainLayout/Header/WorkspaceSwitcher/index.jsx:263`.
  - `permissions` is a **flat array of permission-key strings**; membership is tested with
    `Array.prototype.includes` (`packages/ui/src/hooks/useAuth.jsx:18`).
  - `features` is an **object map** `flagKey -> "true"|"false"|boolean`; the UI accepts either the
    string `'true'` or the boolean `true` (`packages/ui/src/hooks/useAuth.jsx:46`,
    `packages/ui/src/routes/RequireAuth.jsx:23`). An array is explicitly rejected as malformed
    (`packages/ui/src/hooks/useAuth.jsx:40`, `RequireAuth.jsx:17`).
  - `isOrganizationAdmin` becomes the client's `isGlobal` flag (`authUtils.js:64`), which
    **bypasses all client-side permission checks** (`packages/ui/src/hooks/useAuth.jsx:12`).
  - `token` is stored in Redux only; it is never read back or attached to a request
    (`authSlice.js:9` initialises it to `null`, no code reads `state.auth.token`). Session
    transport is the cookie. See §F-4.
  - `name` is additionally persisted separately during org bootstrap:
    `localStorage.setItem('username', loginApi.data.name)`
    (`packages/ui/src/views/organization/index.jsx:194`).

- **401 with redirect:** if `status === 401` **and** `response.data.redirectUrl` is truthy, the UI
  navigates the browser to `response.data.data.redirectUrl`
  (`packages/ui/src/views/auth/signIn.jsx:90-92`).
  ⚠ The **guard** reads `data.redirectUrl` but the **value** read is `data.data.redirectUrl`. To
  satisfy the shipped client, a server issuing this redirect must emit **both**:
  `{ "redirectUrl": "<url>", "data": { "redirectUrl": "<url>" } }`. See §F-7.
- **Other errors:** `response.data.message` is rendered as the sign-in error banner
  (`packages/ui/src/views/auth/signIn.jsx:93`).
- **429:** see §A.14.

#### `POST /auth/resolve`

- **Auth:** none (whitelisted, `constants.ts:27`).
- **Client:** `packages/ui/src/api/auth.js:4`; called with an **empty object** body `{}`
  (`packages/ui/src/views/auth/login.jsx:26`).
- **200 response:** `{ redirectUrl: string }` — the UI immediately performs
  `window.location.href = resolveLogin.data.redirectUrl` (`packages/ui/src/views/auth/login.jsx:34`).
- **Purpose (inferred from usage):** the `/login` route is a pure resolver page that renders only a
  loading backdrop (`packages/ui/src/views/auth/login.jsx:40`) and bounces the browser to whichever
  concrete sign-in surface applies (`/signin`, an SSO IdP, an org-setup page). Any error simply
  clears the loading state (`login.jsx:22-23`); no error UI exists.

#### `POST /auth/refreshToken`

- **Auth:** none (whitelisted, `constants.ts:29`).
- **Client:** issued directly by the axios *response interceptor*, bypassing the shared client:
  `axios.post(`${baseURL}/api/v1/auth/refreshToken`, {}, { withCredentials: true })`
  (`packages/ui/src/api/client.js:24`).
- **Request body:** `{}`. Refresh credential must be carried by cookie.
- **Trigger condition (exact):** a `401` whose body satisfies **both**
  `data.message === 'Token Expired'` **and** `data.retry === true`
  (`packages/ui/src/api/client.js:21`). A 401 lacking `retry: true` will **not** trigger a refresh;
  it logs the user out.
- **Success response:** must contain a truthy `id` field — `if (response.data.id)`
  (`packages/ui/src/api/client.js:25`). The client then replays the original request once
  (`client.js:27`) and reads nothing else from the refresh response.
- **Failure:** any non-`id` response falls through to `localStorage.removeItem('username')`,
  `removeItem('password')`, `AuthUtils.removeCurrentUser()` (`client.js:30-32`).

#### `GET /auth/permissions/:type`

- **Auth:** session required (**not** whitelisted).
- **Client:** `packages/ui/src/api/auth.js:8`.
- **Path param `type`:** exactly two values are ever sent —
  - `'ROLE'` — `packages/ui/src/views/roles/CreateEditRoleDialog.jsx:134`,
    `packages/ui/src/views/roles/index.jsx:84`
  - `'API_KEY'` — `packages/ui/src/views/apikey/APIKeyDialog.jsx:71`
- **200 response — the permission catalog.** A map of *category name* → *array of permission
  descriptors*:

  ```jsonc
  {
    "chatflows": [
      { "key": "chatflows:view", "value": "View Chatflows",
        "isOpenSource": false, "isEnterprise": true, "isCloud": true }
    ],
    "documentStores": [ /* ... */ ],
    "templates":      [ /* ... */ ]
  }
  ```

  Field derivation:
  - Top-level keys are iterated with `Object.keys` and used as UI category headings, rendered by
    splitting camelCase: `category.replace(/([A-Z])/g,' $1').trim().toUpperCase()`
    (`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:358-361`). This is why the category for
    document stores must be the camelCase token `documentStores` — it renders as `DOCUMENT STORES`.
  - `permission.key` — the permission string; matched against role/API-key permission arrays
    (`CreateEditRoleDialog.jsx:182`, `APIKeyDialog.jsx:121`) and used as the React key
    (`CreateEditRoleDialog.jsx:374`).
  - `permission.value` — the human label rendered next to the checkbox
    (`CreateEditRoleDialog.jsx:387`, `packages/ui/src/views/roles/index.jsx:165`).
  - `permission.isOpenSource` / `isEnterprise` / `isCloud` — **booleans**; the client filters the
    catalog to exactly one of these depending on platform type, and deletes any category left empty
    (`CreateEditRoleDialog.jsx:161-174`, `APIKeyDialog.jsx:96-110`). If none of the three platform
    flags is set client-side, the filter returns `false` for everything
    (`CreateEditRoleDialog.jsx:166`).

- **Category-name constraint.** The dialog derives an implicit "view" permission per category as
  `` `${category}:view` `` (`CreateEditRoleDialog.jsx:75`, `:109`; `APIKeyDialog.jsx:155`, `:189`).
  Therefore **the category name must be the prefix of its own permission keys**, with one
  hard-coded exception: `templates`, whose implicit-view pair is `templates:marketplace` +
  `templates:custom` (`CreateEditRoleDialog.jsx:69-73`, `:101-107`).

#### `GET /auth/sso-success?token=<token>`

- **Auth:** session required (not whitelisted); in practice reached with a one-time token.
- **Client:** `packages/ui/src/api/auth.js:9`.
- **Query param:** `token` — read from the browser URL by the SSO landing page
  (`packages/ui/src/views/auth/ssoSuccess.jsx:14`).
- **Response:** the client checks `user.status === 200` (the **axios** status) and dispatches
  `loginSuccess(user.data)` (`ssoSuccess.jsx:20-21`). **The 200 body is therefore the same login
  payload documented under `POST /auth/login`.** Any non-200 or thrown error → navigate `/login`
  (`ssoSuccess.jsx:24`, `:27`, `:30`).

#### `GET /auth/roles/:id` and `GET /auth/roles/name/:name`

- **Client:** `packages/ui/src/api/role.js:4` and `:7`.
- Exported from the role API module but **no call site exists** anywhere in `packages/ui/src`.
  Specified here for completeness of the surface; response shape is undetermined by the UI. See §F-9.

### A.2 Account lifecycle — `/account`

| Endpoint | Auth | Client def |
|---|---|---|
| `POST /account/register` | none (whitelisted `:33`) | `packages/ui/src/api/account.api.js:4` |
| `POST /account/invite` | session | `packages/ui/src/api/account.api.js:3` |
| `POST /account/verify` | none (whitelisted `:32`) | `packages/ui/src/api/account.api.js:5` |
| `POST /account/confirm-email-change` | none (whitelisted `:37`) | `packages/ui/src/api/account.api.js:6` |
| `POST /account/resend-verification` | none (whitelisted `:34`) | `packages/ui/src/api/account.api.js:7` |
| `POST /account/forgot-password` | none (whitelisted `:35`) | `packages/ui/src/api/account.api.js:8` |
| `POST /account/reset-password` | none (whitelisted `:36`) | `packages/ui/src/api/account.api.js:9` |
| `POST /account/billing` | session | `packages/ui/src/api/account.api.js:10` |
| `POST /account/logout` | none (whitelisted `:31`) | `packages/ui/src/api/account.api.js:11` |
| `DELETE /account/delete` | session, **API-key-blacklisted** (`constants.ts:62`) | `packages/ui/src/api/account.api.js:12` |

#### `POST /account/register`

Three distinct body shapes are produced, all nesting the user under a `user` key:

1. **Enterprise self-registration with invite code** — `packages/ui/src/views/auth/register.jsx:137-144`:
   ```json
   { "user": { "name": "…", "email": "…", "credential": "…", "tempToken": "<invite code>" } }
   ```
2. **Cloud self-registration** — `packages/ui/src/views/auth/register.jsx:161-170`:
   ```json
   { "user": { "name": "…", "email": "…", "credential": "…", "referral": "…" } }
   ```
   `referral` is added only when a `referral` form field is non-empty (`register.jsx:168-170`).
3. **First-run organization setup** — `packages/ui/src/views/organization/index.jsx:120-130`:
   ```json
   { "user": { "name": "…", "email": "…", "credential": "…" },
     "organization": { "name": "<org name>" } }
   ```
   The `organization` key is attached **only when `isEnterpriseLicensed`** (`organization/index.jsx:127-131`).

- **Field naming is load-bearing:** the password field is named **`credential`**, never `password`,
  on every register path (`register.jsx:141`, `:165`; `organization/index.jsx:124`). The invite
  code field is **`tempToken`** (`register.jsx:142`).
- **200 response:** `{ message: string }` — rendered directly as the success banner in the org-setup
  flow (`packages/ui/src/views/organization/index.jsx:178`). The self-service register flow ignores
  the body entirely and shows a canned message (`register.jsx:243-247`).
- **Post-register behaviour differs by platform:** enterprise redirects to `/signin` after 3 s
  (`register.jsx:244`, `:248-250`); cloud shows "click the verification link we sent"
  (`register.jsx:246`); org-setup auto-logs-in after 1 s by calling `POST /auth/login` with the
  same credentials (`organization/index.jsx:179-185`).
- **Errors:** `response.data.message` when the body is an object, else the raw body string
  (`organization/index.jsx:143-145`; `register.jsx:188`, `:191`).
- **Password policy (client-side, must be matched or exceeded server-side):** min 8, max 128, ≥1
  lowercase, ≥1 uppercase, ≥1 digit, ≥1 special character —
  `packages/ui/src/utils/validation.js` (`passwordSchema`, imported at `register.jsx:25`).

#### `POST /account/invite`

- **Request body** — `packages/ui/src/ui-component/dialog/InviteUsersDialog.jsx:312-336`:
  ```json
  { "user":      { "email": "…", "createdBy": "<current user id>" },
    "workspace": { "id": "<workspace id>" },
    "role":      { "id": "<role id>" } }
  ```
  The shape is **identical** for a brand-new invitee and for an existing org user being added to a
  workspace; only the source of `email` differs (`item.email` vs `item.user.email`,
  `InviteUsersDialog.jsx:315` vs `:327`).
- **One request per invitee.** The dialog fans out with `Promise.all` over the selected users
  (`InviteUsersDialog.jsx:310-341`); there is no bulk endpoint.
- **200 response:** the body is collected but never inspected — only array non-emptiness is checked
  (`InviteUsersDialog.jsx:339`, `:342`). Return any JSON object.
- **Errors:** `error.response?.data?.message` (`InviteUsersDialog.jsx:362`).

#### `POST /account/verify` and `POST /account/confirm-email-change`

- **Request body (both):** `{ "user": { "tempToken": "<token from ?token= query param>" } }` —
  `packages/ui/src/views/auth/verify-email.jsx:58`,
  `packages/ui/src/views/auth/confirm-email-change.jsx:56`.
- **200:** body ignored; UI shows success and navigates to `/signin` after a delay
  (`verify-email.jsx:38`, `confirm-email-change.jsx:36`).
- **Error:** the whole axios error is stored and rendered by the generic error surface
  (`verify-email.jsx:47`, `confirm-email-change.jsx:45`).

#### `POST /account/resend-verification`

- **Request body:** `{ "email": "<value of the username input>" }` — **flat**, *not* nested under
  `user` (`packages/ui/src/views/auth/signIn.jsx:170`). This is the only account endpoint with a
  flat body.
- **Errors:** `error.response?.data?.message`, falling back to
  `'Failed to send verification email.'` (`signIn.jsx:176`).

#### `POST /account/forgot-password`

- **Request body:** `{ "user": { "email": "…" } }` — `packages/ui/src/views/auth/forgotPassword.jsx:52-56`.
- **200:** body ignored; UI shows the fixed string
  `'Password reset instructions sent to the email.'` (`forgotPassword.jsx:85`).
- **Error:** `response.data.message` if object, else the raw body (`forgotPassword.jsx:69-71`).

#### `POST /account/reset-password`

- **Request body:** `packages/ui/src/views/auth/resetPassword.jsx:101-106`:
  ```json
  { "user": { "email": "…", "tempToken": "<reset token>", "password": "<new password>" } }
  ```
  ⚠ Note the asymmetry with register: here the field is **`password`**, not `credential`.
- **Token source:** `?token=` query param, pre-filled but user-editable
  (`resetPassword.jsx:66`, `:71`, `:215`).
- **200:** truthiness of `data` only (`resetPassword.jsx:113`); UI then navigates to `/signin`.
- **Error:** `response.data.message` if object, else raw body, rendered as a list
  (`resetPassword.jsx:134`).

#### `POST /account/logout`

- **Request body:** none — `client.post('/account/logout')` with no second argument
  (`packages/ui/src/api/account.api.js:11`); axios sends `undefined`.
- **200 response:** `{ "message": "logged_out", "redirectTo": "<url>" }`.
  - `message` is compared to the **exact literal `'logged_out'`**; anything else is a no-op and the
    user stays logged in client-side
    (`packages/ui/src/layout/MainLayout/Header/WorkspaceSwitcher/index.jsx:210`,
    `packages/ui/src/views/account/index.jsx:151`).
  - On match: `logoutSuccess()` is dispatched (clearing localStorage + all cookies) and the browser
    is sent to `redirectTo` via `window.location.href`
    (`WorkspaceSwitcher/index.jsx:211-212`, `account/index.jsx:152-153`).
  - `redirectTo` must always be present — for local sessions it is the app's own sign-in URL; for
    SSO sessions it would be the IdP's end-session URL. See §F-5.
- Called after a successful password change to force re-authentication
  (`packages/ui/src/views/account/index.jsx:336`).

#### `POST /account/billing`

- **Request body:** none (`packages/ui/src/api/account.api.js:10`).
- **200 response:** `{ "url": "<billing-portal url>" }` → `window.open(url, '_blank')`
  (`packages/ui/src/views/account/index.jsx:205-207`).
- **Client gate:** the button is disabled unless `currentUser.isOrganizationAdmin`
  (`account/index.jsx:523`) — a **client-side-only** check; the server must enforce it independently.
- **Error handling:** the error object is discarded; a fixed snackbar
  `'Failed to access billing portal'` is shown (`account/index.jsx:210`). This call is made
  directly, not through `useApi`, so it bypasses the global 401/403/429 handler.

#### `DELETE /account/delete`

- **Request body:** `{ "confirmationText": "<string>" }`, sent in the axios `data` config slot
  (`packages/ui/src/api/account.api.js:12`; call site
  `packages/ui/src/views/account/index.jsx:1455`).
- **Client gate:** the confirm button is enabled only when the typed text is exactly
  `'permanently delete'` (`account/index.jsx:1456`). The server MUST re-validate the literal.
- **200 response:** `{ "message": "Account deleted" }` — compared to the exact literal
  (`account/index.jsx:161`); on match the client dispatches `logoutSuccess()` and hard-redirects to
  `/login` (`account/index.jsx:162-163`).

### A.3 User — `/user`

#### `GET /user?id=<id>`

- **Client:** `packages/ui/src/api/user.js:4`; called with `currentUser.id`
  (`packages/ui/src/views/account/index.jsx:112`).
- **200 response fields consumed:** `name`, `email`
  (`packages/ui/src/views/account/index.jsx:135-136`).

#### `PUT /user`

Two distinct bodies share this endpoint; the server must discriminate on which optional fields are
present.

**(a) Profile update** — `packages/ui/src/views/account/index.jsx:228-232`:
```json
{ "id": "<user id>", "name": "…", "email": "…" }
```
- **200 response** (`account/index.jsx:234-272`):
  ```json
  { "user": { "id": "…", "name": "…", "email": "…" },
    "emailChangePending": true,
    "pendingEmail": "new@example.com" }
  ```
  - When `emailChangePending` is truthy the UI renders
    `` `Check your current email (${payload.user.email}) to confirm the change to ${payload.pendingEmail}.` ``
    (`account/index.jsx:238-239`) — i.e. the confirmation mail goes to the **current** address, and
    the address change is not applied until `POST /account/confirm-email-change` succeeds.
  - Otherwise: `'Profile updated'` (`account/index.jsx:241`).
  - A legacy fallback accepts a **flat** user object as the whole body (`account/index.jsx:255-271`).
  - The returned user is dispatched to `userProfileUpdated`, which copies only `name` and `email`
    into the cached session user (`packages/ui/src/store/reducers/authSlice.js:42-47`).

**(b) Password change** — `packages/ui/src/views/account/index.jsx:322-327`:
```json
{ "id": "<user id>", "oldPassword": "…", "newPassword": "…", "confirmPassword": "…" }
```
- All three password fields are sent; the server should verify `newPassword === confirmPassword`
  as well as re-verify `oldPassword`.
- **200 response:** `{ "user": {…} }` or a flat user — the client accepts both
  (`account/index.jsx:329-330`).
- **Post-condition:** the client immediately calls `POST /account/logout`
  (`account/index.jsx:336`), so a successful password change must invalidate the current session.
- **Hidden for SSO users:** the entire Security panel is suppressed when `currentUser.isSSO`
  (`account/index.jsx:707`).
- **Client-side pre-validation** (`account/index.jsx:294-320`): non-empty `oldPassword`
  (`'Old Password cannot be left blank'`), `newPassword === confirmPassword`
  (`'New Password and Confirm Password do not match'`), and the shared `passwordSchema`.

### A.4 Roles — `/role`

Mounted behind a plan gate: `router.use('/role', IdentityManager.checkFeatureByPlan('feat:roles'), roleRouter)`
(`packages/server/src/routes/index.ts:141`).

| Method | Path | Client def |
|---|---|---|
| GET | `/role?organizationId=<id>` | `packages/ui/src/api/role.js:3` |
| POST | `/role` | `packages/ui/src/api/role.js:5` |
| PUT | `/role` | `packages/ui/src/api/role.js:6` |
| DELETE | `/role?id=<id>&organizationId=<id>` | `packages/ui/src/api/role.js:8` |

#### `GET /role?organizationId=`

- **200 response:** an **array** of role objects. Fields consumed:
  - `id` — `packages/ui/src/ui-component/dialog/InviteUsersDialog.jsx:74`,
    `packages/ui/src/views/roles/index.jsx:472`
  - `name` — `InviteUsersDialog.jsx:75`, `roles/index.jsx:256`, `:464`
  - `description` — `InviteUsersDialog.jsx:77`, `roles/index.jsx:257`
  - `permissions` — a **JSON-encoded string** containing an array of permission keys; the client
    calls `JSON.parse(props.role.permissions)` (`roles/index.jsx:272`, `:103`;
    `packages/ui/src/views/roles/CreateEditRoleDialog.jsx:177`)
  - `userCount` — integer; drives the assigned-users column and the delete-disabled state
    (`roles/index.jsx:290`, `:291`, `:314`, `:316`)
- **Ordering:** unspecified; the client re-maps but does not sort.

#### `POST /role` / `PUT /role`

- **Request body** — `packages/ui/src/views/roles/CreateEditRoleDialog.jsx:217-239`:
  ```json
  { "name": "…", "description": "…",
    "createdBy": "<current user id>",
    "organizationId": "<current user activeOrganizationId>",
    "permissions": "[\"chatflows:view\",\"chatflows:update\"]",
    "id": "<role id>",            // PUT only  (CreateEditRoleDialog.jsx:235)
    "updatedBy": "<current user id>" }  // PUT only (CreateEditRoleDialog.jsx:236)
  ```
  `permissions` is `JSON.stringify(array)` (`CreateEditRoleDialog.jsx:232`) — a **string**, matching
  the string the GET returns.
- **200 response:** must contain `id` — `onConfirm(saveResp.data.id)`
  (`CreateEditRoleDialog.jsx:254`).
- **Client-side constraint:** role names may not contain spaces
  (`CreateEditRoleDialog.jsx:201`, message `'Role Name cannot contain spaces.'`). Name is immutable
  on edit — the input is disabled for `EDIT` (`CreateEditRoleDialog.jsx:327`).
- **Errors:** `error.response.data.message` if object, else raw body
  (`CreateEditRoleDialog.jsx:258`).

#### `DELETE /role?id=&organizationId=`

- **200:** truthiness of `data` only (`packages/ui/src/views/roles/index.jsx:473`).
- **Client gate:** delete is disabled while `role.userCount > 0`, tooltip
  `'Remove users with the role from Workspace first'` (`roles/index.jsx:314-316`).

### A.5 Organization users — `/organizationuser`

**API-key-blacklisted** (`packages/server/src/utils/constants.ts:64`) — session only.

#### `GET /organizationuser`

Three query-parameter combinations, three different result semantics:

| Query | Client def | Semantics |
|---|---|---|
| `?organizationId=<id>` | `packages/ui/src/api/user.js:8` | all members of the org |
| `?organizationId=<id>&userId=<id>` | `packages/ui/src/api/user.js:9-10` | one membership record |
| `?userId=<id>` | `packages/ui/src/api/user.js:11` | all orgs a user belongs to |

**`?organizationId=` — org member list.** Response is an **array**; fields consumed by the Users
page (`packages/ui/src/views/users/index.jsx`) and the invite dialog:

| Field | Type | Read at |
|---|---|---|
| `userId` | string | `users/index.jsx:148`, `:171`; `InviteUsersDialog.jsx:229`, `:263` |
| `organizationId` | string | `users/index.jsx:148` |
| `user.id` | string | `users/index.jsx:172`, `:179` |
| `user.name` | string \| null | `users/index.jsx:125`, `:267` |
| `user.email` | string | `users/index.jsx:129`, `:268` |
| `status` | `'active'` \| `'invited'` \| `'inactive'` | `users/index.jsx:154-156` (compared **uppercased**), `:160`, `:284` |
| `lastLogin` | ISO-8601 \| null | `users/index.jsx:158` (`null` → renders `'Never'`) |
| `roleCount` | integer | `users/index.jsx:142`, `:150` |
| `isOrgOwner` | boolean | `users/index.jsx:102`, `:133`, `:170`, `:387` |

- `status` is compared **case-insensitively** via `.toUpperCase()`; emit lowercase to match the
  `EditUserDialog` dropdown values `'active'` / `'inactive'`
  (`packages/ui/src/views/users/EditUserDialog.jsx:28-37`).
- The client hoists the `isOrgOwner === true` row to the top of the list
  (`users/index.jsx:387-391`) — server ordering is not relied upon.

**`?userId=` — organizations for a user.** Response is an array; the breadcrumb component reads
`organization.id` and `organization.user.name` / `organization.user.email`, rendering the org label
as `` `${name || email}'s Organization` ``
(`packages/ui/src/layout/MainLayout/Header/OrgWorkspaceBreadcrumbs/index.jsx:224-227`).
⚠ The **organization display name is derived client-side from the owner's user record**, not from an
organization `name` field. See §F-8.

#### `PUT /organizationuser`

- **Request body** — `packages/ui/src/views/users/EditUserDialog.jsx:80-84`:
  ```json
  { "userId": "…", "organizationId": "…", "status": "active" | "inactive" }
  ```
- **200 response:** must contain `id` (`EditUserDialog.jsx:100`).
- **Client gate:** the status dropdown is disabled when `isOrgOwner`, with the caption
  `'Cannot change status of the organization owner!'` (`EditUserDialog.jsx:185`, `:193`). The server
  must enforce this — cf. `GeneralErrorMessage.NOT_ALLOWED_TO_DELETE_OWNER`
  (`packages/server/src/utils/constants.ts:74`).

#### `DELETE /organizationuser?organizationId=&userId=`

- **Client:** `packages/ui/src/api/user.js:13-14`; call site
  `packages/ui/src/views/users/index.jsx:325`.
- **200:** truthiness of `data` (`users/index.jsx:326`).
- **Client gates:** the delete button is hidden for `isOrgOwner` rows and for the current user
  (`users/index.jsx:170-171`).

### A.6 Organization / billing — `/organization`

All read-only or Stripe-adjacent; all defined in `packages/ui/src/api/user.js:16-27`.

| Method | Path | Query / body | Response fields consumed |
|---|---|---|---|
| GET | `/organization/additional-seats-quantity` | `?subscriptionId=` (`user.js:16-17`) | `includedSeats`, `quantity`, `totalOrgUsers` (`account/index.jsx:184-186`) |
| GET | `/organization/customer-default-source` | `?customerId=` (`user.js:18`) | `invoice_settings.default_payment_method.card.{brand,last4,exp_month,exp_year}` (`account/index.jsx:966-984`) |
| GET | `/organization/additional-seats-proration` | `?subscriptionId=&quantity=` (`user.js:19-20`) | `prorationDate`, `currentPeriodStart`, `currentPeriodEnd`, `currency`, `basePlanAmount`, `additionalSeatsProratedAmount`, `seatPerUnitPrice`, `prorationAmount`, `creditBalance` (`account/index.jsx:373`, `:1025-1110`) |
| POST | `/organization/update-additional-seats` | `{subscriptionId, quantity, prorationDate}` (`user.js:21-22`) | body unread (`account/index.jsx:377-383`) |
| GET | `/organization/plan-proration` | `?subscriptionId=&newPlanId=` (`user.js:23-24`) | no call site in `packages/ui/src` |
| POST | `/organization/update-subscription-plan` | `{subscriptionId, newPlanId, prorationDate}` (`user.js:25-26`) | no call site in `packages/ui/src` |
| GET | `/organization/get-current-usage` | none (`user.js:27`) | `predictions.{usage,limit}`, `storage.{usage,limit}` (`account/index.jsx:600`, `:631-633`) |

- `quantity` on the proration/update endpoints is the **new total** additional-seat count, not a
  delta (`account/index.jsx:425`).
- `currentPeriodStart` / `currentPeriodEnd` are **Unix seconds** (multiplied by 1000 at
  `account/index.jsx:1025`, `:1030`).
- Storage usage is rendered with a hard-coded `MB` suffix (`account/index.jsx:631-633`), so
  `storage.usage` and `storage.limit` must be expressed in megabytes.
- ⚠ **Currently unreachable in the shipped UI.** `setOpenAddSeatsDialog` / `setOpenRemoveSeatsDialog`
  / `setOpenPricingDialog` are never invoked with `true` (only `false` at `account/index.jsx:416`,
  `:417`, `:434`, `:442`, `:861`, `:1002`, `:1276`). Consequently `customer-default-source`,
  `additional-seats-proration` and `update-additional-seats` are never called at runtime; only
  `additional-seats-quantity` feeds the read-only Seats panel (`account/index.jsx:539-587`).
- All billing endpoints are requested only when `isCloud` (`account/index.jsx:120-123`).

### A.7 Workspaces — `/workspace`

**API-key-blacklisted** (`packages/server/src/utils/constants.ts:65`) — session only.

| Method | Path | Client def |
|---|---|---|
| GET | `/workspace?organizationId=<id>` | `packages/ui/src/api/workspace.js:3` |
| GET | `/workspace?id=<id>` | `packages/ui/src/api/workspace.js:5` |
| POST | `/workspace` | `packages/ui/src/api/workspace.js:12` |
| PUT | `/workspace` | `packages/ui/src/api/workspace.js:13` |
| DELETE | `/workspace/<id>` | `packages/ui/src/api/workspace.js:14` |
| POST | `/workspace/switch?id=<id>` | `packages/ui/src/api/workspace.js:10` |
| POST | `/workspace/link-users/<id>` | `packages/ui/src/api/workspace.js:8` |
| POST | `/workspace/unlink-users/<id>` | `packages/ui/src/api/workspace.js:7` |
| GET | `/workspace/shared/<id>` | `packages/ui/src/api/workspace.js:16` |
| POST | `/workspace/shared/<id>` | `packages/ui/src/api/workspace.js:17` |

> Note the same path `/workspace` with different query params serves both "list by org" and
> "get by id" — the server must branch on which of `organizationId` / `id` is present.

#### `GET /workspace?organizationId=`

**200 response:** array of workspace objects. Fields consumed by
`packages/ui/src/views/workspace/index.jsx` and `InviteUsersDialog.jsx`:

| Field | Read at |
|---|---|
| `id` | `workspace/index.jsx:99`, `:122`; `InviteUsersDialog.jsx:121` |
| `name` | `workspace/index.jsx:98`, `:130`, `:145`, `:278`; `InviteUsersDialog.jsx:122-123` |
| `description` | `InviteUsersDialog.jsx:124` |
| `userCount` | `workspace/index.jsx:116`, `:117`, `:146` |
| `isOrgDefault` | `workspace/index.jsx:146` |
| `updatedDate` | `workspace/index.jsx:128` (moment-formatted) |

- The literal workspace name **`'Default Workspace'`** is special-cased client-side: edit and delete
  controls are hidden for it (`workspace/index.jsx:130`, `:145`) and the workspace switcher is
  suppressed when a user has exactly one workspace named `'Default Workspace'`
  (`packages/ui/src/layout/MainLayout/Header/WorkspaceSwitcher/index.jsx:251`).
- Delete is additionally blocked when `userCount > 1` or `isOrgDefault === true`
  (`workspace/index.jsx:146`).

#### `POST /workspace`

- **Request body** — `packages/ui/src/views/workspace/AddEditWorkspaceDialog.jsx:97-103`:
  ```json
  { "name": "…", "description": "…",
    "createdBy": "<current user id>",
    "organizationId": "<current user activeOrganizationId>",
    "existingWorkspaceId": "<current user activeWorkspaceId>" }
  ```
  `existingWorkspaceId` carries the comment *"this is used to inherit the current role"*
  (`AddEditWorkspaceDialog.jsx:102`) — the creator's role in the named workspace is to be copied
  into the new one.
- **200:** must contain `id` (`AddEditWorkspaceDialog.jsx:118`).

#### `PUT /workspace`

- **Request body** — `AddEditWorkspaceDialog.jsx:142-147`:
  `{ "id": "…", "name": "…", "description": "…", "updatedBy": "<current user id>" }`
- **200 response:** must include at minimum `{ id, name }` — dispatched to `workspaceNameUpdated`,
  which locates the matching entry in `user.assignedWorkspaces` by `id` and replaces its `name`
  (`AddEditWorkspaceDialog.jsx:151`; `packages/ui/src/store/reducers/authSlice.js:48-61`).

#### `POST /workspace/switch?id=<id>`

- **Request body:** none (`packages/ui/src/api/workspace.js:10`).
- **200 response:** **the full login payload again** — the result is dispatched to
  `workspaceSwitchSuccess`, which runs the identical `AuthUtils.updateStateAndLocalStorage`
  (`packages/ui/src/store/reducers/authSlice.js:36-38`) as `loginSuccess`. Therefore switching a
  workspace **re-issues the complete identity envelope**, including a freshly scoped
  `permissions` array and updated `activeWorkspaceId` / `activeWorkspace`.
  Call sites: `packages/ui/src/views/workspace/index.jsx:368`,
  `packages/ui/src/layout/MainLayout/Header/WorkspaceSwitcher/index.jsx:189`,
  `packages/ui/src/layout/MainLayout/Header/OrgWorkspaceBreadcrumbs/index.jsx:256`.
  The client reads `switchWorkspaceApi.data.activeWorkspaceId` to detect a no-op switch
  (`workspace/index.jsx:360`).
- **Error:** `switchWorkspaceApi.error.message`, fallback `'Failed to switch workspace'`
  (`WorkspaceSwitcher/index.jsx:203`).

#### `GET /workspace/shared/<id>` and `POST /workspace/shared/<id>`

- Used by the cross-workspace sharing dialog
  (`packages/ui/src/ui-component/dialog/ShareWithWorkspaceDialog.jsx:108`, `:130`).
- `<id>` is the **shared item's** id (a credential or custom template), not a workspace id
  (`ShareWithWorkspaceDialog.jsx:108` passes `dialogProps.data.id`).
- GET returns an array of workspace records the item is shared into (`ShareWithWorkspaceDialog.jsx:75`).
- POST body is built at `ShareWithWorkspaceDialog.jsx:~130`; the response is only checked for
  truthiness.
- Gated in the UI by `credentials:share` (`packages/ui/src/views/credentials/index.jsx:392`) and
  `templates:custom-share` (`packages/ui/src/ui-component/table/MarketplaceTable.jsx:239`,
  `packages/ui/src/views/marketplaces/index.jsx:918`).

#### `POST /workspace/link-users/<id>` and `POST /workspace/unlink-users/<id>`

- Defined at `packages/ui/src/api/workspace.js:8` and `:7`. Bodies are user-id collections. No
  direct call site was located in `packages/ui/src`; the Workspace Users screen removes members via
  `DELETE /workspaceuser` instead (`packages/ui/src/views/workspace/WorkspaceUsers.jsx:208`). See §F-9.

### A.8 Workspace users — `/workspaceuser`

**API-key-blacklisted** (`packages/server/src/utils/constants.ts:66`) — session only.

#### `GET /workspaceuser`

Five query shapes (`packages/ui/src/api/user.js:30-35`):

| Query | Client def | Semantics |
|---|---|---|
| `?workspaceId=<id>` | `user.js:30` | members of a workspace |
| `?roleId=<id>` | `user.js:31` | all assignments carrying a role |
| `?userId=<id>&workspaceId=<id>` | `user.js:32` | one assignment |
| `?userId=<id>` | `user.js:33` | all workspaces for a user (any org) |
| `?organizationId=<id>&userId=<id>` | `user.js:34-35` | all workspaces for a user within one org |

**200 response:** array of *workspace-user assignment* records. Union of fields consumed:

| Field | Read at |
|---|---|
| `userId` | `WorkspaceUsers.jsx:99`, `:118`, `:208`, `:457` |
| `workspaceId` | `WorkspaceSwitcher/index.jsx:145`, `:167`; `OrgWorkspaceBreadcrumbs/index.jsx:153`, `:188` |
| `user.id` | `InviteUsersDialog.jsx` / `EditWorkspaceUserRoleDialog.jsx:111` |
| `user.name` | `WorkspaceUsers.jsx:466-468`; `users/index.jsx:364` |
| `user.email` | `WorkspaceUsers.jsx:472`; `roles/index.jsx:364` |
| `role.id` | `InviteUsersDialog.jsx:169` |
| `role.name` | `WorkspaceUsers.jsx:478`; `workspace/index.jsx:193`, `:196`; `users/index.jsx:211`; `InviteUsersDialog.jsx:170-171` |
| `role.description` | `InviteUsersDialog.jsx:172` |
| `workspace.id` | `InviteUsersDialog.jsx:175` |
| `workspace.name` | `WorkspaceSwitcher/index.jsx:146`, `:168`; `users/index.jsx:213`; `roles/index.jsx:365`; `workspace/index.jsx` |
| `workspace.description` | `InviteUsersDialog.jsx:178` |
| `workspace.organizationId` | `OrgWorkspaceBreadcrumbs/index.jsx:151`, `:185` — used to filter workspaces to the active org |
| `status` | `WorkspaceUsers.jsx:486-493` (uppercased compare) |
| `lastLogin` | `WorkspaceUsers.jsx:499-501` |
| `isOrgOwner` | `WorkspaceUsers.jsx:454`, `:475`, `:482`; `workspace/index.jsx:191`; `roles/index.jsx` |

- The literal role name **`'personal workspace'`** is special-cased for display
  (`packages/ui/src/views/workspace/index.jsx:193`).
- Org owners are rendered without a role/status chip and cannot be selected for removal
  (`WorkspaceUsers.jsx:454`, `:475`, `:482`).

#### `PUT /workspaceuser`

- **Request body** — `packages/ui/src/views/workspace/EditWorkspaceUserRoleDialog.jsx:110-116`:
  ```json
  { "userId": "…", "workspaceId": "…", "roleId": "…", "updatedBy": "<current user id>" }
  ```
  (There is a further field at `:113` in the same object literal; the four above are the ones the
  dialog binds from state.)
- **200:** must contain `id` (`EditWorkspaceUserRoleDialog.jsx:132`).
- Exposed on the workspace API module as `updateWorkspaceUserRole`
  (`packages/ui/src/api/workspace.js:19`).

#### `DELETE /workspaceuser?workspaceId=&userId=`

- `packages/ui/src/api/user.js:36`; call site `WorkspaceUsers.jsx:208`, issued as one request per
  selected user via `Promise.all`.

### A.9 Login methods / SSO configuration — `/loginmethod`

| Method | Path | Auth | Client def |
|---|---|---|---|
| GET | `/loginmethod?organizationId=<id>` | session | `packages/ui/src/api/loginmethod.js:4` |
| GET | `/loginmethod/default` | **none** (whitelisted, `constants.ts:38`) | `packages/ui/src/api/loginmethod.js:6` |
| PUT | `/loginmethod` | session, `sso:manage` | `packages/ui/src/api/loginmethod.js:7` |
| POST | `/loginmethod/test` | session, `sso:manage` | `packages/ui/src/api/loginmethod.js:9` |

#### `GET /loginmethod/default`

- **200 response:** `{ "providers": ["azure", "google", "auth0", "github"] }` — a **flat array of
  provider-name strings**. Consumed at `packages/ui/src/views/auth/signIn.jsx:148-151` and compared
  to the literals `'azure'` (`signIn.jsx:265`), `'google'` (`:284`), `'auth0'` (`:303`),
  `'github'` (`:322`); same pattern at `packages/ui/src/views/auth/register.jsx:226-232` and
  `packages/ui/src/views/organization/index.jsx:166-168`.
- Must be callable **before login** — it drives which SSO buttons appear on the sign-in page.

#### `GET /loginmethod?organizationId=`

- **200 response** (`packages/ui/src/views/auth/ssoConfig.jsx:342-394`):
  ```jsonc
  {
    "providers": [
      { "name": "azure",            // NOTE: `name`, not `providerName`   ssoConfig.jsx:345
        "status": "enable",         // compared to the literal 'enable'   ssoConfig.jsx:355
        "config": { "tenantID": "…", "clientID": "…", "domain": "…" } }   // ssoConfig.jsx:351-352, :374
    ],
    "callbacks": [
      { "providerName": "azure", "callbackURL": "https://…" }             // ssoConfig.jsx:346, :348
    ]
  }
  ```
- ⚠ **Naming asymmetry that must be preserved:** the response identifies a provider by **`name`**
  (`ssoConfig.jsx:345`, `:357`, `:367`, `:381`) while the request body identifies it by
  **`providerName`** (`ssoConfig.jsx:151`). The `callbacks` array uses `providerName` in both
  directions (`ssoConfig.jsx:346`).
- **`clientSecret` is never returned.** `packages/ui/src/views/auth/ssoConfig.jsx:36-37` states
  *"API never sends clientSecret; show asterisks when a secret is already configured"* and defines
  `PLACEHOLDER_SECRET = '********'`. The client substitutes the placeholder when a config exists
  (`ssoConfig.jsx:353-354`, `:364`, `:376-377`, `:388`).

#### `PUT /loginmethod`

- **Request body** — `packages/ui/src/views/auth/ssoConfig.jsx:144-190`:
  ```jsonc
  {
    "organizationId": "<activeOrganizationId>",   // :146
    "userId": "<current user id>",                // :147
    "providers": [
      { "providerLabel": "Microsoft", "providerName": "azure",
        "config": { "tenantID": "…", "clientID": "…", "clientSecret": "…" },
        "status": "enable" | "disable" },         // :150-157
      { "providerLabel": "Google", "providerName": "google",
        "config": { "clientID": "…", "clientSecret": "…" },
        "status": "…" },                          // :160-166
      { "providerLabel": "Auth0", "providerName": "auth0",
        "config": { "domain": "…", "clientID": "…", "clientSecret": "…" },
        "status": "…" },                          // :169-176
      { "providerLabel": "Github", "providerName": "github",
        "config": { "clientID": "…", "clientSecret": "…" },
        "status": "…" }                           // :179-185
    ]
  }
  ```
- **Array order is positionally significant** — index 0 azure, 1 google, 2 auth0, 3 github. The test
  path slices by tab index: `body.providers = [body.providers[tabValue]]` (`ssoConfig.jsx:258`),
  matched against the tab→name map at `ssoConfig.jsx:329-340`.
- **`'********'` means "unchanged".** If the operator does not retype a secret, the literal
  `'********'` is submitted verbatim (`ssoConfig.jsx:155`, `:164`, `:174`, `:183`); validation only
  checks non-emptiness (`ssoConfig.jsx:92-94`, `:100-102`, `:109-111`, `:121-123`). **The server MUST
  treat the exact string `'********'` as a sentinel meaning "retain the stored secret"**, or
  configurations will be destroyed on every unrelated save.
- **200 response:** truthiness of `data` only (`ssoConfig.jsx:203`).
- **Error:** `error.response.data.message` if object, else raw body (`ssoConfig.jsx:219`).

#### `POST /loginmethod/test`

- **Request body:** the `PUT` body with `providers` reduced to a single element, **plus** a
  top-level lowercase `providerName` field: `body.providerName = providerName.toLowerCase()`
  (`ssoConfig.jsx:259`).
- **200 response:** `{ "message": "…" }` on success (`ssoConfig.jsx:265-267`) **or**
  `{ "error": "…" }` on failure (`ssoConfig.jsx:279-281`).
  ⚠ **A failed connectivity test is signalled inside a 200 body via `error`, not by an HTTP status.**
  The raw `error` string is rendered to the operator, so it should be diagnostic.

#### SSO provider entry points

- `GET /api/v1/<provider>/login` — `packages/ui/src/api/sso.js:3`. In practice the UI performs a
  **full-page navigation** rather than an XHR: `window.location.href = `/api/v1/${ssoProvider}/login``
  (`packages/ui/src/views/auth/signIn.jsx:165`, `packages/ui/src/views/auth/register.jsx:181`).
- Each provider contributes three whitelisted URIs — `LOGIN_URI`, `LOGOUT_URI`, `CALLBACK_URI` —
  registered in `WHITELIST_URLS` (`packages/server/src/utils/constants.ts:46-57`) for azure, google,
  auth0 and github. Their concrete path values are defined in files outside the Apache-2.0 scope;
  the interface only requires that they exist per provider and are reachable unauthenticated. See §F-6.
- SSO middleware is installed **after** the JWT cookie middleware, per the explicit comment
  *"this is for SSO and must be after the JWT cookie middleware"*
  (`packages/server/src/index.ts:300-301`).
- On completion the IdP flow lands on the app's `/sso-success?token=<t>` page, which exchanges the
  token via `GET /auth/sso-success?token=` (§A.1).
- **SSO error convention:** a `401` carrying `response.data.redirectUrl` causes a hard browser
  navigation to that URL (`signIn.jsx:139-141`, `register.jsx:217-219`). This field is
  **`redirectUrl`** — distinct from the `redirectTo` used by the generic 401 handler (§A.14).

### A.10 Login activity / audit — `/audit`

Mounted behind a plan gate:
`router.use('/audit', IdentityManager.checkFeatureByPlan('feat:login-activity'), auditRouter)`
(`packages/server/src/routes/index.ts:138`).

#### `POST /audit/login-activity`

A **read operation performed via POST** (`packages/ui/src/api/audit.js:3`).

- **Request body** (`packages/ui/src/views/auth/loginActivity.jsx:123-128`):
  ```json
  { "pageNo": 1, "startDate": "<ISO-8601>", "endDate": "<ISO-8601>", "activityCodes": [0, -1] }
  ```
  - `pageNo` is **1-based** (`loginActivity.jsx:186`, `:131-135`).
  - `startDate` / `endDate` are JS `Date` objects, serialised by axios to ISO-8601 strings.
    Defaults: start = now − 1 month (`loginActivity.jsx:103`), end = now (`:104`).
  - `activityCodes` is an array of integers; `[]` when unfiltered (`loginActivity.jsx:117-122`).
  - ⚠ The **initial** mount request sends only `{ pageNo: 1 }` (`loginActivity.jsx:184-189`) — no
    date range. The server must treat missing `startDate`/`endDate`/`activityCodes` as "unfiltered".
  - **No page-size parameter is ever sent.** The client seeds its own display state to `50`
    (`loginActivity.jsx:102`), implying a server default page size of 50.

- **200 response:**
  ```json
  { "count": 1234, "currentPage": 1, "pageSize": 50, "data": [ /* records */ ] }
  ```
  (`loginActivity.jsx:204-209`). Pagination arithmetic is done client-side from these four fields
  (`loginActivity.jsx:207-208`).

- **Record fields consumed:**

  | Field | Type | Read at |
  |---|---|---|
  | `activityCode` | integer | `loginActivity.jsx:444`, `:455`, `:466`, `:478` |
  | `username` | string | `loginActivity.jsx:481` |
  | `attemptedDateTime` | ISO-8601 | `loginActivity.jsx:483` |
  | `loginMode` | string \| null | `loginActivity.jsx:486` (falsy → renders `'Email/Password'`) |
  | `message` | string | `loginActivity.jsx:488` |

- **Activity-code vocabulary** (`loginActivity.jsx:146-182`):

  | Code | Description |
  |---:|---|
  | `0` | Login Success |
  | `1` | Logout Success |
  | `-1` | Unknown User |
  | `-2` | Incorrect Credential |
  | `-3` | User Disabled |
  | `-4` | No Assigned Workspace |
  | *(other)* | Unknown Activity |

  These map 1:1 onto the client-side error constants in §0.5 (`UNKNOWN_USER`, `INCORRECT_PASSWORD`,
  `INACTIVE_USER`, `INVALID_WORKSPACE`), which is how a failed login should be recorded.
  ⚠ Selecting the "Unknown Activity" filter transmits `activityCodes: [-99]`
  (`loginActivity.jsx:180`) — a code the server never stores. Treat `-99` as "no match".

### A.11 Platform settings — `/settings`

#### `GET /settings`

- **Auth:** none (whitelisted, `packages/server/src/utils/constants.ts:30`). Route:
  `packages/server/src/routes/settings/index.ts:6`.
- **Client:** `packages/ui/src/api/platformsettings.js:3`; fetched once at app start by
  `ConfigProvider` (`packages/ui/src/store/context/ConfigContext.jsx:15`).
- **200 response:** an object; the only field consumed is **`PLATFORM_TYPE`**
  (`ConfigContext.jsx:22`), whose values are the exact literals:

  | Value | Derived flags | Citation |
  |---|---|---|
  | `'enterprise'` | `isEnterpriseLicensed = true` | `ConfigContext.jsx:23-26` |
  | `'cloud'` | `isCloud = true` | `ConfigContext.jsx:27-30` |
  | *anything else* | `isOpenSource = true` | `ConfigContext.jsx:31-35` |

  These match `packages/server/src/Interface.ts:44-47` (`Platform` enum: `open source` / `cloud` /
  `enterprise`).
- **This endpoint is the bootstrap dependency for the entire auth UI.** `RequireAuth` returns
  `null` (renders nothing) until it resolves (`packages/ui/src/routes/RequireAuth.jsx:40-42`), and
  a failure leaves all three platform flags `false`, which makes `RequireAuth` fall through to
  *deny* (`RequireAuth.jsx:86-87`) and empties the permission catalog
  (`CreateEditRoleDialog.jsx:166`).

### A.12 Pricing — `/pricing`

#### `GET /pricing`

- **Auth:** none (whitelisted, `constants.ts:39`). Client: `packages/ui/src/api/pricing.js:3`.
- **200 response:** an **array** of plan objects. Only two fields are consumed: `prodId` (matched
  against `currentUser.activeOrganizationProductId`) and `title`
  (`packages/ui/src/views/account/index.jsx:197-198`, rendered at `:498`).
- Requested only when `isCloud` (`account/index.jsx:121`).

### A.13 API keys — `/apikey` (permission-bearing)

Included because API keys carry a `permissions` array and constitute the second authentication
scheme (§C.2).

| Method | Path | Permission | Route |
|---|---|---|---|
| GET | `/apikey` | `apikeys:view` | `packages/server/src/routes/apikey/index.ts:10` |
| POST | `/apikey` | `apikeys:create` | `packages/server/src/routes/apikey/index.ts:7` |
| PUT | `/apikey` or `/apikey/:id` | any of `apikeys:create,apikeys:update` | `packages/server/src/routes/apikey/index.ts:13` |
| DELETE | `/apikey` or `/apikey/:id` | `apikeys:delete` | `packages/server/src/routes/apikey/index.ts:16` |

- **Create / update body** — `packages/ui/src/views/apikey/APIKeyDialog.jsx:222-225` and `:274-277`:
  ```json
  { "keyName": "…", "permissions": ["chatflows:view", "tools:view"] }
  ```
  ⚠ Here `permissions` is a **native array**, unlike roles where it is a JSON **string** (§A.4).
- The dialog populates itself from `GET /auth/permissions/API_KEY`
  (`APIKeyDialog.jsx:71`) and pre-checks from `dialogProps.key.permissions`, an array
  (`APIKeyDialog.jsx:115`).
- `GET /apikey` therefore returns records including at least `id`, `keyName`, and `permissions[]`.
- **`GET /verify/apikey/:apikey`** (`packages/server/src/routes/verify/index.ts:6`) is
  unauthenticated (whitelisted, `constants.ts:7`) and validates a key.

### A.14 Cross-cutting status codes

The global handler is `packages/ui/src/store/context/ErrorContext.jsx:16-58`, invoked for every
`useApi`-wrapped call.

| Status | Body condition | Client behaviour | Citation |
|---|---|---|---|
| **429** | `data.type === 'authentication_rate_limit'` | shows an inline banner, stays on page | `ErrorContext.jsx:18-19` |
| **429** | any other | reads `Retry-After` header (integer seconds **or** HTTP-date), default 60; navigates to `/rate-limited` | `ErrorContext.jsx:20-34` |
| **403** | — | navigates to `/unauthorized` (renders "403 Forbidden") | `ErrorContext.jsx:35-36`; `packages/ui/src/views/auth/unauthorized.jsx:39` |
| **401** | `data.message === 'Invalid or Missing token'` | logout + `/login` | `ErrorContext.jsx:38-40` |
| **401** | `data.redirectTo` **and** `data.error` both present | `redirectWhenUnauthorized({error, redirectTo})` — hard navigation when `error === 'unauthorized'`, or to `${redirectTo}?error=subscription_canceled` when `error === 'subscription_canceled'` | `ErrorContext.jsx:42-48`; `packages/ui/src/utils/genericHelper.js:1070-1076` |
| **401** | `data.message === 'Token Expired'` **and** `data.retry === true` | silent refresh + single replay (interceptor, runs first) | `packages/ui/src/api/client.js:21-28` |
| **401** | any other | logout + `/login`, unless already on `/signin` or `/login` | `ErrorContext.jsx:49-55` |
| other | — | stored in error state → `ErrorBoundary` | `ErrorContext.jsx:57` |

**Server obligations implied:**
- Emit a `Retry-After` header on every 429.
- Distinguish authentication rate-limiting (`type: 'authentication_rate_limit'`) from general
  rate-limiting — the former must not navigate the user away from the sign-in form.
- Use **403** (never 401) for authorization failures on an authenticated session, and **401** for
  authentication failures. The UI's routing depends on this split.
- On an expired-but-refreshable access token, respond
  `401 { message: 'Token Expired', retry: true }`. Omitting `retry: true` forces a full logout.

---

## B. Permission vocabulary

**82 distinct permission strings**, all of the form `<category>:<action>`. Of these, **61 are
enforced server-side** by a `checkPermission` / `checkAnyPermission` call in
`packages/server/src/routes/**`; the remaining **21 are UI-only literals** with no Apache-2.0
route enforcement (see §B.3 — most correspond to endpoints that live in the non-Apache portion of
the tree, so an implementer must supply the enforcement).

### B.1 Enforcement primitives

| Function | Semantics | Evidence |
|---|---|---|
| `checkPermission('a')` | requires that single permission | single-token argument at every call site, e.g. `packages/server/src/routes/apikey/index.ts:10` |
| `checkAnyPermission('a,b,c')` | requires **at least one** of the comma-separated tokens | the client mirror `hasPermission` splits on `,` and uses `.some()` — `packages/ui/src/hooks/useAuth.jsx:16-19` |

There is **no `checkAllPermissions`** in the Apache-2.0 route tree. Every multi-token check is
any-of. Both helpers are imported from `'../../enterprise/rbac/PermissionCheck'` at every call site
(e.g. `packages/server/src/routes/apikey/index.ts:3`,
`packages/server/src/routes/chatflows/index.ts:3`).

### B.2 Server-enforced permissions, by category

#### apikeys (4)

| Permission | Routes | Mode |
|---|---|---|
| `apikeys:view` | `GET /apikey` — `routes/apikey/index.ts:10` | all |
| `apikeys:create` | `POST /apikey` — `routes/apikey/index.ts:7` | all |
| `apikeys:create` / `apikeys:update` | `PUT /apikey[/:id]` — `routes/apikey/index.ts:13` | any-of |
| `apikeys:delete` | `DELETE /apikey[/:id]` — `routes/apikey/index.ts:16` | all |

#### assistants (4)

| Permission | Routes | Mode |
|---|---|---|
| `assistants:view` | `GET /assistants` — `routes/assistants/index.ts:11`; `GET /assistants[/:id]` — `:12`; `GET /openai-assistants` — `routes/openai-assistants/index.ts:10`; `GET /openai-assistants[/:id]` — `:11`; `GET /openai-assistants-vector-store/:id` — `routes/openai-assistants-vector-store/index.ts:12`; `GET /openai-assistants-vector-store` — `:15` | all |
| `assistants:create` | `POST /assistants` — `routes/assistants/index.ts:8`; `POST /openai-assistants-vector-store` — `routes/openai-assistants-vector-store/index.ts:9` | all |
| `assistants:create` / `assistants:update` | `PUT /assistants[/:id]` — `routes/assistants/index.ts:15`; `routes/openai-assistants-vector-store/index.ts:20`, `:30` | any-of |
| `assistants:update` | `PATCH /openai-assistants-vector-store[/:id]` — `routes/openai-assistants-vector-store/index.ts:36` | all |
| `assistants:delete` | `DELETE /assistants[/:id]` — `routes/assistants/index.ts:18`; `routes/openai-assistants-vector-store/index.ts:25`; and as one alternative on `DELETE /chatflows[/:id]` — `routes/chatflows/index.ts:34` | all |

#### chatflows (5) and agentflows (5)

These two categories are **almost always checked together as any-of pairs** — the same route serves
both flow kinds and the controller narrows by type afterwards (see §C.4).

| Permission set | Routes | Mode |
|---|---|---|
| `chatflows:create,chatflows:update,agentflows:create,agentflows:update` | `POST /chatflows` — `routes/chatflows/index.ts:9`; `PUT /chatflows[/:id]` — `:29`; `POST /node-custom-function` — `routes/node-custom-functions/index.ts:11`; webhook-listener register/stream/unregister — `routes/webhook-listener/index.ts:7,9,10,11` | any-of |
| `chatflows:view,chatflows:update,agentflows:view,agentflows:update` | `GET /chatflows` — `routes/chatflows/index.ts:16`; `GET /chatflows/:id/schedule/status` — `:50`; `GET /chatflows/:id/schedule/trigger-logs` — `:56` | any-of |
| `chatflows:view,chatflows:update,chatflows:delete,agentflows:view,agentflows:update,agentflows:delete` | `GET /chatflows[/:id]` — `routes/chatflows/index.ts:21` | any-of |
| `chatflows:delete,agentflows:delete,assistants:delete` | `DELETE /chatflows[/:id]` — `routes/chatflows/index.ts:34` | any-of |
| `chatflows:update,agentflows:update` | `POST /chatflows/:id/webhook-secret` — `:37`; `DELETE /chatflows/:id/webhook-secret` — `:38`; `GET /chatflows/has-changed/:id/:lastUpdatedDateTime` — `:43`; `PATCH /chatflows/:id/schedule/enabled` — `:53` | any-of |
| `chatflows:update,agentflows:update,executions:delete` | `DELETE /chatflows/:id/schedule/trigger-logs` — `routes/chatflows/index.ts:61` | any-of |
| `chatflows:view,chatflows:create,chatflows:update,chatflows:delete` | `GET /openai-realtime[/:id]` — `routes/openai-realtime/index.ts:10`; `POST /openai-realtime[/:id]` — `:17` | any-of |
| `chatflows:config,agentflows:config` | all five `/mcp-server` routes — `routes/mcp-server/index.ts:7,10,13,16,19` | any-of |
| `chatflows:view,chatflows:create,chatflows:update,chatflows:delete,agentflows:view,agentflows:create,agentflows:update,agentflows:delete,documentStores:view,documentStores:create,documentStores:update,documentStores:add-loader` | `POST /node-load-method[/:name]` — `routes/node-load-methods/index.ts:9-11` | any-of |

> `GET /chatflows/apikey[/:apikey]` (`routes/chatflows/index.ts:24`) has **no** permission check —
> it is authenticated by API key alone.

#### credentials (4)

| Permission | Routes | Mode |
|---|---|---|
| `credentials:view` | `GET /credentials` — `routes/credentials/index.ts:10` | all |
| `credentials:create` | `POST /credentials` — `routes/credentials/index.ts:7` | all |
| `credentials:create` / `credentials:update` | `GET /credentials[/:id]` — `:11`; `GET /credentials/:id/reveal` — `:14`; `PUT /credentials[/:id]` — `:17` | any-of |
| `credentials:delete` | `DELETE /credentials[/:id]` — `:20` | all |

> Note the deliberate asymmetry: reading a *specific* credential (and revealing its secret) requires
> **write** permission, not `credentials:view`.

#### tools (4)

| Permission | Routes | Mode |
|---|---|---|
| `tools:view` | `GET /tools` — `routes/tools/index.ts:11`; `GET /tools[/:id]` — `:12` (any-of, single token); `GET /custom-mcp-servers` — `routes/custom-mcp-servers/index.ts:11`; `GET /custom-mcp-servers/:id` — `:12`; `GET /custom-mcp-servers/:id/tools` — `:13` | all |
| `tools:create` | `POST /tools` — `routes/tools/index.ts:8`; `POST /custom-mcp-servers` — `routes/custom-mcp-servers/index.ts:8` | all |
| `tools:update` / `tools:create` | `PUT /tools[/:id]` — `routes/tools/index.ts:15`; `PUT /custom-mcp-servers/:id` — `routes/custom-mcp-servers/index.ts:16`; `POST /custom-mcp-servers/:id/authorize` — `:19` | any-of |
| `tools:delete` | `DELETE /tools[/:id]` — `routes/tools/index.ts:18`; `DELETE /custom-mcp-servers/:id` — `routes/custom-mcp-servers/index.ts:22` | all |

#### datasets (4)

| Permission | Routes | Mode |
|---|---|---|
| `datasets:view` | `GET /datasets` — `routes/dataset/index.ts:7`; `GET /datasets/set[/:id]` — `:9` | all |
| `datasets:create` | `POST /datasets/set[/:id]` — `:11`; `POST /datasets/rows[/:id]` — `:18` | all |
| `datasets:create` / `datasets:update` | `PUT /datasets/set[/:id]` — `:13`; `PUT /datasets/rows[/:id]` — `:20`; `POST /datasets/reorder` — `:27` | any-of |
| `datasets:delete` | `DELETE /datasets/set[/:id]` — `:15`; `DELETE /datasets/rows[/:id]` — `:22`; `PATCH /datasets/rows` — `:24` | all |

Whole router additionally gated by `checkFeatureByPlan('feat:datasets')` (`routes/index.ts:88`).

#### documentStores (8)

| Permission | Routes | Mode |
|---|---|---|
| `documentStores:view` | `GET /document-store/store` — `routes/documentstore/index.ts:16`; `GET /document-store/store-configs/:id/:loaderId` — `:28` (any-of, single token); `GET /document-store/chunks/:storeId/:fileId/:pageNo` — `:61`; `POST /document-store/vectorstore/query` — `:70`; `POST /document-store/generate-tool-desc/:id` — `:82` | all |
| `documentStores:create` | `POST /document-store/store` — `:14` | all |
| `documentStores:view,documentStores:update,documentStores:delete` | `GET /document-store/store/:id` — `:20` | any-of |
| `documentStores:create,documentStores:update` | `PUT /document-store/store/:id` — `:24` | any-of |
| `documentStores:delete` | `DELETE /document-store/store/:id` — `:26` | all |
| `documentStores:add-loader` | `GET /document-store/components/loaders` — `:32` | all |
| `documentStores:delete-loader` | `DELETE /document-store/loader/:id/:loaderId` — `:37` | all |
| `documentStores:preview-process` | `POST /document-store/loader/preview` — `:41`; `POST /document-store/loader/save` — `:43`; `POST /document-store/loader/process/:loaderId` — `:45` | all |
| `documentStores:update,documentStores:delete` | `DELETE /document-store/chunks/:storeId/:loaderId/:chunkId` — `:51` | any-of |
| `documentStores:update` | `PUT /document-store/chunks/:storeId/:loaderId/:chunkId` — `:57` | all |
| `documentStores:upsert-config` | `POST /document-store/vectorstore/insert` — `:64`; `POST /document-store/vectorstore/save` — `:66`; `DELETE /document-store/vectorstore/:storeId` — `:68`; `GET /document-store/components/embeddings` — `:72`; `GET /document-store/components/vectorstore` — `:74`; `GET /document-store/components/recordmanager` — `:76`; `POST /document-store/vectorstore/update` — `:79` | all |

> `POST /document-store/upsert[/:id]` (`:8`) and `POST /document-store/refresh[/:id]` (`:10`) carry
> **no** permission check.

#### evaluations (4) / evaluators (4)

| Permission | Routes | Mode |
|---|---|---|
| `evaluations:view` | `GET /evaluations` — `routes/evaluations/index.ts:6`; `GET /evaluations/:id` — `:7`; `GET /evaluations/versions/:id` — `:12` | all |
| `evaluations:create` | `POST /evaluations` — `:9` | all |
| `evaluations:create,evaluations:run` | `POST /evaluations/run-again/:id` — `:11` | any-of |
| `evaluations:delete` | `DELETE /evaluations/:id` — `:8`; `PATCH /evaluations` — `:13` | all |
| `evaluators:view` | `GET /evaluators` — `routes/evaluator/index.ts:7`; `GET /evaluators[/:id]` — `:9` | all |
| `evaluators:create` | `POST /evaluators[/:id]` — `:11` | all |
| `evaluators:create,evaluators:update` | `PUT /evaluators[/:id]` — `:13` | any-of |
| `evaluators:delete` | `DELETE /evaluators[/:id]` — `:15` | all |

Both routers gated by `checkFeatureByPlan('feat:evaluations')` / `('feat:evaluators')`
(`routes/index.ts:90-91`).

> `evaluations:update` does **not** exist. The category has `view/create/delete/run` only.

#### executions (3)

| Permission | Routes | Mode |
|---|---|---|
| `executions:view` | `GET /executions` — `routes/executions/index.ts:7`; `GET /executions[/:id]` — `:8` | any-of (single token) |
| `executions:update` | `PUT /executions[/:id]` — `:11` | any-of (single token) |
| `executions:delete` | `DELETE /executions/:id` — `:14`; `DELETE /executions` — `:15`; and as one alternative on `DELETE /chatflows/:id/schedule/trigger-logs` — `routes/chatflows/index.ts:61` | any-of (single token) |

#### templates (5)

| Permission | Routes | Mode |
|---|---|---|
| `templates:marketplace` | `GET /marketplaces/templates` — `routes/marketplaces/index.ts:7` | all |
| `templates:custom` | `GET /marketplaces/custom` — `:12` | all |
| `templates:custom-delete` | `DELETE /marketplaces[/custom/:id]` — `:15` | all |
| `templates:flowexport,templates:toolexport` | `POST /marketplaces/custom` — `:9` | any-of |

#### variables (4)

| Permission | Routes | Mode |
|---|---|---|
| `variables:view` | `GET /variables` — `routes/variables/index.ts:11` | all |
| `variables:create` | `POST /variables` — `:8` | all |
| `variables:create,variables:update` | `PUT /variables[/:id]` — `:14` | any-of |
| `variables:delete` | `DELETE /variables[/:id]` — `:17` | all |

#### workspace — export/import (2)

| Permission | Routes | Mode |
|---|---|---|
| `workspace:export` | `POST /export-import/export` — `routes/export-import/index.ts:6`; `POST /export-import/chatflow-messages` — `:8` | all |
| `workspace:import` | `POST /export-import/import` — `:10` | all |

> These two are flagged in the role editor as *administrative privileges* with a warning tooltip:
> *"Administrative privilege: Performs workspace-level actions with implicit access to all contained
> resources. Intended for backup/restore and migration operations. Restrict to authorized
> administrators only."* — `packages/ui/src/views/roles/CreateEditRoleDialog.jsx:388-395`.
> An implementer should treat them as bypassing per-resource checks within the workspace.

#### logs (1)

| Permission | Routes | Mode |
|---|---|---|
| `logs:view` | `GET /logs` — `routes/log/index.ts:7` | any-of (single token) |

Gated by `checkFeatureByPlan('feat:logs')` (`routes/index.ts:147`).

### B.3 UI-only permissions (21) — no Apache-2.0 route enforcement

These appear as literals in `packages/ui` but have no `checkPermission` call site in
`packages/server/src/routes/**`. **An implementer must supply server-side enforcement for all of
them** — the client-side checks are cosmetic (`RBACButtons` render `null`, they do not disable).

| Permission | UI use | Citation |
|---|---|---|
| `chatflows:duplicate` | flow context menu | `packages/ui/src/menu-items/settings.js:77` |
| `chatflows:import` | flow context menu | `packages/ui/src/menu-items/settings.js:85` |
| `chatflows:export` | flow context menu | `packages/ui/src/menu-items/settings.js:93` |
| `chatflows:domains` | allowed-domains dialog | `packages/ui/src/ui-component/button/FlowListMenu.jsx:410` |
| `agentflows:duplicate` | agent context menu | `packages/ui/src/menu-items/agentsettings.js:70` |
| `agentflows:import` | agent context menu | `packages/ui/src/menu-items/agentsettings.js:78` |
| `agentflows:export` | agent context menu | `packages/ui/src/menu-items/agentsettings.js:86` |
| `agentflows:domains` | allowed-domains dialog | `packages/ui/src/ui-component/button/FlowListMenu.jsx:410` |
| `credentials:share` | share-with-workspace button | `packages/ui/src/views/credentials/index.jsx:392` |
| `templates:custom-share` | share custom template | `packages/ui/src/ui-component/table/MarketplaceTable.jsx:239`; `packages/ui/src/views/marketplaces/index.jsx:918` |
| `tools:export` | export tool | `packages/ui/src/views/tools/ToolDialog.jsx:448` |
| `workspace:view` | route + menu guard for `/workspaces` | `packages/ui/src/routes/MainRoutes.jsx:322`, `:330`; `packages/ui/src/menu-items/dashboard.js:241` |
| `workspace:create` | "Add Workspace" | `packages/ui/src/views/workspace/index.jsx:414` |
| `workspace:update` | edit workspace | `packages/ui/src/views/workspace/index.jsx:132` |
| `workspace:delete` | delete workspace | `packages/ui/src/views/workspace/index.jsx:152` |
| `workspace:add-user` | invite/add user to workspace | `packages/ui/src/views/workspace/WorkspaceUsers.jsx:337`, `:359`; `packages/ui/src/views/users/index.jsx:162`, `:405` |
| `workspace:unlink-user` | remove user from workspace | `packages/ui/src/views/workspace/WorkspaceUsers.jsx:326`; `packages/ui/src/views/users/index.jsx:176` |
| `users:manage` | Users screen, role drawer | `packages/ui/src/routes/MainRoutes.jsx:298`; `packages/ui/src/views/users/index.jsx:144`, `:162`, `:176`, `:405` |
| `roles:manage` | Roles screen and all its actions | `packages/ui/src/routes/MainRoutes.jsx:306`; `packages/ui/src/views/roles/index.jsx:280`, `:293`, `:305`, `:313`, `:543` |
| `sso:manage` | SSO config screen, Save/Test buttons | `packages/ui/src/routes/MainRoutes.jsx:338`; `packages/ui/src/views/auth/ssoConfig.jsx:991`, `:1000` |
| `loginActivity:view` | Login Activity screen | `packages/ui/src/routes/MainRoutes.jsx:314`; `packages/ui/src/menu-items/dashboard.js:251` |

Note the composite any-of guards used in the Users screen: `'workspace:add-user,users:manage'`
(`packages/ui/src/views/users/index.jsx:162`, `:405`) and
`'workspace:unlink-user,users:manage'` (`:176`) — i.e. either the workspace-scoped permission or
the org-scoped one grants the action.

### B.4 Feature flags (11) — a separate axis

Feature flags are **not** permissions. They live in the `features` map on the login payload
(§A.1) and gate *availability* rather than *authority*. The full set:

| Flag | Gates | Citation |
|---|---|---|
| `feat:datasets` | `/datasets` router + route + menu | `packages/server/src/routes/index.ts:88`; `packages/ui/src/routes/MainRoutes.jsx:238` |
| `feat:evaluations` | `/evaluations` router + route + menu | `routes/index.ts:90`; `MainRoutes.jsx:254` |
| `feat:evaluators` | `/evaluators` router + route + menu | `routes/index.ts:91`; `MainRoutes.jsx:270` |
| `feat:login-activity` | `/audit` router + route + menu | `routes/index.ts:138`; `MainRoutes.jsx:314` |
| `feat:logs` | `/logs` router + route + menu | `routes/index.ts:147`; `MainRoutes.jsx:278` |
| `feat:roles` | `/role` router + Roles screen | `routes/index.ts:141`; `MainRoutes.jsx:306` |
| `feat:sso-config` | SSO config screen | `MainRoutes.jsx:338`; `packages/ui/src/menu-items/dashboard.js:210` |
| `feat:users` | Users screen | `MainRoutes.jsx:298`; `dashboard.js:230` |
| `feat:workspaces` | Workspaces screens, workspace switcher | `MainRoutes.jsx:322`; `packages/ui/src/layout/MainLayout/Header/WorkspaceSwitcher/index.jsx:126` |
| `feat:account` | Account screen | `packages/ui/src/menu-items/dashboard.js:286`; `packages/ui/src/routes/DefaultRedirect.jsx:63` |
| `feat:files` | Files screen (currently commented out) | `routes/index.ts:148`; `MainRoutes.jsx:286` |

Server-side, feature gating is applied as router-level middleware,
`IdentityManager.checkFeatureByPlan('<flag>')` (`packages/server/src/routes/index.ts:88`, `:90`,
`:91`, `:138`, `:141`, `:147`, `:148`). It composes **before** per-route permission checks.

**Not permissions (do not add to the RBAC catalog):** `file:full` / `file:rag` are chat upload
*types* (`packages/ui/src/views/chatmessage/ChatMessage.jsx:364`, `:443`), and `HH:mm` is a moment
format string — both merely resemble the `a:b` shape.

### B.5 Category-name registry

The permission-catalog response (§A.1) must group under exactly these category keys, because each
category's implicit-view permission is derived as `` `${category}:view` ``:

```
apikeys  assistants  chatflows  agentflows  credentials  tools  datasets
documentStores  evaluations  evaluators  executions  variables  workspace
templates(*)  logs  users  roles  sso  loginActivity
```

`(*)` `templates` is the sole exception; its implicit-view pair is `templates:marketplace` +
`templates:custom` (`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:69-73`).

### B.6 Role-editor coupling rules (client-side; mirror server-side for consistency)

From `packages/ui/src/views/roles/CreateEditRoleDialog.jsx:62-120` (and identically in
`packages/ui/src/views/apikey/APIKeyDialog.jsx:150-198`):

1. Enabling any non-view permission in a category **auto-enables** that category's `:view`
   permission (`CreateEditRoleDialog.jsx:75-82`).
2. The `:view` checkbox is **disabled** (cannot be unchecked) while any other permission in the
   category is enabled (`CreateEditRoleDialog.jsx:109-115`).
3. For `templates`, enabling anything other than `templates:marketplace` / `templates:custom`
   auto-enables **both** of those (`CreateEditRoleDialog.jsx:69-73`), and both become
   un-uncheckable (`:103-107`).
4. A role must retain at least one enabled permission or Save is disabled
   (`CreateEditRoleDialog.jsx:281-283`).

---

## C. Middleware contract

### C.1 Signatures

Two exported functions, both **middleware factories** returning standard Express middleware:

```ts
// packages/server/src/enterprise/rbac/PermissionCheck  (module path only; contents not read)
function checkPermission(permission: string): RequestHandler
function checkAnyPermission(permissions: string): RequestHandler   // comma-separated
```

Evidence for the factory shape: every call site invokes the function and passes its **return
value** into an Express route as a handler — `router.get('/', checkPermission('apikeys:view'), controller)`
(`packages/server/src/routes/apikey/index.ts:10`). Evidence that the result is reusable and not
per-request: `packages/server/src/routes/webhook-listener/index.ts:7` binds the result to a const
and reuses it across three routes:

```ts
const requireFlowEdit = checkAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update')
router.post('/:id/register', requireFlowEdit, webhookListenerController.registerListener)   // :9
router.get('/:id/stream/:listenerId', requireFlowEdit, webhookListenerController.streamListener)  // :10
router.delete('/:id/listener/:listenerId', requireFlowEdit, webhookListenerController.unregisterListener)  // :11
```

Argument-format facts:
- `checkPermission` receives a single token; **no call site passes a comma** to it.
- `checkAnyPermission` receives comma-separated tokens **with no whitespace** — verified across all
  call sites, including the 12-token argument at
  `packages/server/src/routes/node-load-methods/index.ts:10`.
- `checkAnyPermission` is sometimes called with a single token, e.g.
  `checkAnyPermission('logs:view')` (`packages/server/src/routes/log/index.ts:7`),
  `checkAnyPermission('executions:view')` (`routes/executions/index.ts:7`),
  `checkAnyPermission('documentStores:view')` (`routes/documentstore/index.ts:28`),
  `checkAnyPermission('tools:view')` (`routes/tools/index.ts:12`). Single-token any-of must be
  equivalent to `checkPermission`.

### C.2 What the middleware must read off the request

The authenticated principal is **`req.user`**, established upstream by the bootstrap. Both
authentication schemes populate the same shape. The API-key branch constructs it explicitly in
Apache-2.0 code (`packages/server/src/index.ts:280-290`):

```ts
req.user = {
    permissions:                      apiKey.permissions,   // index.ts:281
    features,                                               // index.ts:282
    activeOrganizationId,                                   // index.ts:283
    activeOrganizationSubscriptionId: subscriptionId,       // index.ts:284
    activeOrganizationCustomerId:     customerId,           // index.ts:285
    activeOrganizationProductId:      productId,            // index.ts:286
    isOrganizationAdmin:              false,                // index.ts:287
    activeWorkspaceId:                workspace.id,         // index.ts:288
    activeWorkspace:                  workspace.name        // index.ts:289
}
```

The session branch must additionally supply **`req.user.id`** — required by
`packages/server/src/controllers/chatflows/index.ts:245`
(`workspaceUserService.readWorkspaceUserByUserId(req.user.id, …)`) — which the API-key branch
notably does **not** set. An implementer must therefore treat `req.user.id` as present-for-sessions,
absent-for-API-keys.

**Minimum contract for the permission middleware:**

| Field | Type | Required by |
|---|---|---|
| `req.user` | object \| undefined | absence ⇒ 401 (`packages/server/src/controllers/chatflows/index.ts:242`) |
| `req.user.permissions` | `string[]` | `.includes(...)` at `controllers/chatflows/index.ts:80-83`; `.some/.includes` mirror at `packages/ui/src/hooks/useAuth.jsx:18` |
| `req.user.isOrganizationAdmin` | boolean | short-circuit grant, `controllers/chatflows/index.ts:71` |
| `req.user.activeWorkspaceId` | string | scoping (§C.5) |
| `req.user.activeOrganizationId` | string | scoping (§C.5) |
| `req.user.features` | `Record<string, string \| boolean>` | feature gating |
| `req.user.id` | string (sessions only) | `controllers/chatflows/index.ts:245` |

`permissions` is a **flat array of `<category>:<action>` strings** — not a nested structure, not a
bitmask. This is established twice independently: server-side by
`permissions.includes('chatflows:delete')` (`controllers/chatflows/index.ts:80`) and client-side by
`permissions.includes(permissionId)` (`packages/ui/src/hooks/useAuth.jsx:18`).

### C.3 Success / failure behaviour

| Outcome | Behaviour | Evidence |
|---|---|---|
| Permission satisfied | `next()` — control passes to the controller | positional composition at every call site |
| Permission not satisfied | **403** | `packages/ui/src/store/context/ErrorContext.jsx:35-36` navigates to `/unauthorized` on 403; the page reads *"403 Forbidden — You do not have permission to access this page."* (`packages/ui/src/views/auth/unauthorized.jsx:39`, `:42`). Server-side confirmation: `throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'You do not have permission to delete any chatflow types')` (`packages/server/src/controllers/chatflows/index.ts:84`) |
| No `req.user` at all | **401** | `return res.status(StatusCodes.UNAUTHORIZED).json({ message: GeneralErrorMessage.UNAUTHORIZED })` (`controllers/chatflows/index.ts:242`) |

**403 must be reserved for authorization failures and 401 for authentication failures** — the
client routes on this distinction (§A.14): 403 → `/unauthorized` (user stays logged in);
401 → logout + `/login`.

The error body should carry a `message` field; the UI's generic renderer reads
`response.data.message` when the body is an object and falls back to the raw body when it is a
string — a pattern repeated in every dialog, e.g.
`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:258`,
`packages/ui/src/views/users/EditUserDialog.jsx:106`,
`packages/ui/src/views/workspace/AddEditWorkspaceDialog.jsx:123`.

### C.4 Post-middleware narrowing (the second half of the pattern)

Any-of middleware is deliberately permissive; the controller then narrows. The canonical example is
`packages/server/src/controllers/chatflows/index.ts:69-84`:

```ts
const userPermittedTypes: EnumChatflowType[] = []
const permissions = req.user!.permissions                      // :70
if (req.user?.isOrganizationAdmin) {                           // :71
    // push CHATFLOW, AGENTFLOW, MULTIAGENT, ASSISTANT         // :72-75
} else {
    if (permissions.includes(`chatflows:delete`))  push CHATFLOW    // :77
    if (permissions.includes(`agentflows:delete`)) push AGENTFLOW   // :78
    if (permissions.includes(`agentflows:delete`)) push MULTIAGENT  // :79
    if (permissions.includes(`assistants:delete`)) push ASSISTANT   // :80
    if (userPermittedTypes.length === 0)
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, '…')  // :83-84
}
```

Two rules an implementer must carry forward:

1. **`isOrganizationAdmin` is a total bypass** of permission evaluation
   (`controllers/chatflows/index.ts:71-75`), mirrored client-side at
   `packages/ui/src/hooks/useAuth.jsx:12` and `packages/ui/src/routes/RequireAuth.jsx:66`, `:79`.
2. **`agentflows:*` governs both `AGENTFLOW` and `MULTIAGENT`** flow types
   (`controllers/chatflows/index.ts:78-79`) — there is no separate multi-agent permission.

### C.5 Workspace/organization scoping is orthogonal to permission checking

The permission middleware answers *"may this principal perform this verb?"*. **Row scoping is done
separately, in every controller, from `req.user.activeWorkspaceId`.** This is uniform across the
Apache-2.0 controllers:

- `packages/server/src/controllers/variables/index.ts:20`, `:43`, `:60`, `:85`
- `packages/server/src/controllers/dataset/index.ts:11`, `:31`, `:50`, `:73`, `:92`, `:114`, `:137`, `:157`, `:174`, `:193`
- `packages/server/src/controllers/executions/index.ts:8`, `:29`, `:43`, `:95`
- `packages/server/src/controllers/chatflows/index.ts:62`, `:97`, `:132`, `:158`, `:195`, `:288`
- `packages/server/src/controllers/stats/index.ts:12`
- `packages/server/src/controllers/predictions/index.ts:28`

Missing scope is a **404**, not a 403 — e.g.
`throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Error: chatflowsController.deleteChatflow - workspace ${workspaceId} not found!')`
(`packages/server/src/controllers/chatflows/index.ts:63-68`), and the analogous organization check
at `:56-61`.

A distinct **cross-workspace access check** appears at
`packages/server/src/controllers/chatflows/index.ts:242-250`: resolve all workspace ids the user
belongs to, and if the resource's `workspaceId` is not among them return
**400** `{ message: 'You are not in the workspace that owns this chatflow' }` (`:249-250`); if the
user has no workspace memberships at all, **404** with a `WORKSPACE_USER_NOT_FOUND` message (`:246-247`).

### C.6 Middleware composition order

For a fully gated route the observed order is:

```
1. bootstrap auth        (index.ts:230-298)  -> populates req.user, else 401
2. feature gate          (routes/index.ts:88 etc.) IdentityManager.checkFeatureByPlan('feat:x')
3. permission gate       (per-route) checkPermission / checkAnyPermission -> 403
4. controller            scoping by req.user.activeWorkspaceId -> 404 / 400
```

### C.7 Client-side mirror (must stay semantically identical)

`packages/ui/src/hooks/useAuth.jsx:11-21` is the authoritative reference implementation of the
matching algorithm:

```js
const hasPermission = (permissionId) => {
    if (isOpenSource || isGlobal) return true // :12
    if (!permissionId) return false // :15
    const permissionIds = permissionId.split(',') // :16
    if (permissions && permissions.length) {
        return permissionIds.some((p) => permissions.includes(p)) // :18
    }
    return false // :20
}
```

Note: **open-source deployments grant everything** (`useAuth.jsx:12`); RBAC is inert there
(`packages/ui/src/routes/RequireAuth.jsx:52-54` shows only display-flag-free routes).

---

## D. Data model requirements

Stated as *interface requirements* — the minimum fields the HTTP surface and UI demand. This is not
a schema reproduction; storage layout, keys, and indexing are unconstrained.

### D.1 `User`

| Field | Type | Required by |
|---|---|---|
| `id` | string (uuid-shaped) | login payload `authUtils.js:37`; `GET /user?id=`; every `createdBy`/`updatedBy` body |
| `email` | string, unique, login identifier | `authUtils.js:38`; the sign-in field is typed `email` and labelled *"Will be used as login id"* (`packages/ui/src/views/auth/register.jsx:336`) |
| `name` | string, **nullable** | `authUtils.js:39`; rendered with `?? ''` and `name \|\| email` fallbacks (`packages/ui/src/views/users/index.jsx:125`, `:267`, `:316`) |
| `credential` | opaque password hash | inbound field name on register (`register.jsx:141`, `:165`) |
| `status` | enum `active` \| `invited` \| `inactive` | `authUtils.js:40`; compared uppercased at `users/index.jsx:154-156`; dropdown values at `EditUserDialog.jsx:31`, `:35` |
| `lastLogin` | timestamp, nullable | `authUtils.js:49`; `null` renders `'Never'` (`users/index.jsx:158`) |
| `isSSO` | boolean | `authUtils.js:42`, `:67`; suppresses password UI (`account/index.jsx:707`) |
| `tempToken` | string, nullable | invite code (`register.jsx:142`), email verification (`verify-email.jsx:58`), password reset (`resetPassword.jsx:104`), email-change confirmation (`confirm-email-change.jsx:56`) |
| `pendingEmail` | string, nullable | `PUT /user` response (`account/index.jsx:239`) |
| `role` | string, nullable | `authUtils.js:41` — present on the login payload but never rendered. See §F-2 |
| `referral` | string, nullable | cloud registration only (`register.jsx:169`) |

**`tempToken` carries at least four distinct semantics** (invite, email verification, password
reset, email-change confirmation). A single nullable column cannot serve them concurrently; see §F-3.

### D.2 `Organization`

| Field | Type | Required by |
|---|---|---|
| `id` | string | `activeOrganizationId` (`authUtils.js:43`); query param on `/role`, `/organizationuser`, `/workspace`, `/loginmethod` |
| `name` | string | supplied at first-run setup (`packages/ui/src/views/organization/index.jsx:128-130`) |
| `subscriptionId` | string, nullable | `packages/server/src/index.ts:270`; `activeOrganizationSubscriptionId` |
| `customerId` | string, nullable | `packages/server/src/index.ts:271`; `activeOrganizationCustomerId` |
| *(derived)* `productId` | string | resolved from the subscription (`packages/server/src/index.ts:273`) |

⚠ **The organization has no user-facing display name in the UI.** The breadcrumb renders
`` `${organization.user.name || organization.user.email}'s Organization` ``
(`packages/ui/src/layout/MainLayout/Header/OrgWorkspaceBreadcrumbs/index.jsx:226`) — i.e. it
composes the label from the **owner's** user record. See §F-8.

### D.3 `OrganizationUser` (membership, org↔user)

The `GET /organizationuser?organizationId=` row shape (§A.5):

| Field | Type | Required by |
|---|---|---|
| `organizationId` | FK → Organization | `users/index.jsx:148` |
| `userId` | FK → User | `users/index.jsx:148`, `:171` |
| `user` | embedded `{ id, name, email }` | `users/index.jsx:125`, `:129`, `:172` |
| `status` | enum active/invited/inactive | `users/index.jsx:154-156` |
| `lastLogin` | timestamp, nullable | `users/index.jsx:158` |
| `isOrgOwner` | boolean | `users/index.jsx:102`, `:133`, `:170`, `:387` |
| `roleCount` | **derived** integer — distinct roles held across the org's workspaces | `users/index.jsx:142`, `:150` |

`status` and `lastLogin` appear on **both** the User (login payload) and the OrganizationUser row.
See §F-1.

Exactly one member per organization has `isOrgOwner === true`; the UI enforces that this member
cannot be deleted (`users/index.jsx:170`) nor have their status changed
(`EditUserDialog.jsx:185`, `:193`), matching `GeneralErrorMessage.NOT_ALLOWED_TO_DELETE_OWNER`
(`packages/server/src/utils/constants.ts:74`).

### D.4 `Workspace`

| Field | Type | Required by |
|---|---|---|
| `id` | string | `activeWorkspaceId` (`authUtils.js:47`); `packages/server/src/index.ts:288` |
| `name` | string | `activeWorkspace` (`authUtils.js:48`); `packages/server/src/index.ts:289` |
| `description` | string, nullable | `InviteUsersDialog.jsx:124` |
| `organizationId` | FK → Organization | `packages/server/src/index.ts:268`; used to filter workspaces to the active org (`OrgWorkspaceBreadcrumbs/index.jsx:151`, `:185`) |
| `isOrgDefault` | boolean | delete-guard (`packages/ui/src/views/workspace/index.jsx:146`) |
| `createdBy` / `updatedBy` | FK → User | `AddEditWorkspaceDialog.jsx:100`, `:146` |
| `updatedDate` | timestamp | `workspace/index.jsx:128` |
| `userCount` | **derived** integer | `workspace/index.jsx:116`, `:146` |

`workspaceId` is the pervasive tenancy discriminator across the whole product — it appears on
`IChatFlow`-adjacent entities throughout `packages/server/src/Interface.ts` (lines `77`, `125`,
`135`, `145`, `155`, `187`, `208`, `223`, `251`, `412`, `436`, `465`).

Two literal names are behaviourally significant: **`'Default Workspace'`**
(`workspace/index.jsx:130`, `:145`; `WorkspaceSwitcher/index.jsx:251`) and the role name
**`'personal workspace'`** (`workspace/index.jsx:193`).

### D.5 `Role`

| Field | Type | Required by |
|---|---|---|
| `id` | string | `InviteUsersDialog.jsx:74`; `roles/index.jsx:472` |
| `name` | string, **no spaces** | `CreateEditRoleDialog.jsx:201`; immutable after creation (`:327`) |
| `description` | string, nullable | `roles/index.jsx:257` |
| `permissions` | **JSON-encoded string** of `string[]` | `JSON.parse` at `roles/index.jsx:272`, `:103`; `JSON.stringify` at `CreateEditRoleDialog.jsx:232` |
| `organizationId` | FK → Organization | `CreateEditRoleDialog.jsx:221` |
| `createdBy` / `updatedBy` | FK → User | `CreateEditRoleDialog.jsx:220`, `:236` |
| `userCount` | **derived** integer | `roles/index.jsx:290`, `:314` |

Roles are **organization-scoped**, not workspace-scoped: every read and delete is keyed by
`organizationId` (`packages/ui/src/api/role.js:3`, `:8`).

### D.6 `WorkspaceUser` (assignment: user × workspace × role)

The join that actually carries authority. Row shape from `GET /workspaceuser` (§A.8):

| Field | Type | Required by |
|---|---|---|
| `userId` | FK → User | `WorkspaceUsers.jsx:99`, `:208` |
| `workspaceId` | FK → Workspace | `WorkspaceSwitcher/index.jsx:145` |
| `roleId` | FK → Role | `EditWorkspaceUserRoleDialog.jsx:114` |
| `user` | embedded `{ id, name, email }` | `WorkspaceUsers.jsx:466-472` |
| `workspace` | embedded `{ id, name, description, organizationId }` | `InviteUsersDialog.jsx:175-178`; `OrgWorkspaceBreadcrumbs/index.jsx:151` |
| `role` | embedded `{ id, name, description }` | `InviteUsersDialog.jsx:169-172` |
| `status` | enum | `WorkspaceUsers.jsx:486-493` |
| `lastLogin` | timestamp, nullable | `WorkspaceUsers.jsx:499` |
| `isOrgOwner` | boolean (denormalised from OrganizationUser) | `WorkspaceUsers.jsx:454`, `:475` |
| `updatedBy` | FK → User | `EditWorkspaceUserRoleDialog.jsx:115` |

**A user holds one role per workspace** — the edit dialog binds a single `roleId`
(`EditWorkspaceUserRoleDialog.jsx:114`) and the invite dialog sends a single `role.id`
(`InviteUsersDialog.jsx:321-323`). Multi-workspace membership is what produces `roleCount > 1` on
the org-user row.

**The effective permission set for a request = the permissions of the role held in
`activeWorkspaceId`**, which is exactly why `POST /workspace/switch` re-issues the whole login
payload (§A.7).

### D.7 `Permission` (catalog — reference data, not per-tenant)

Descriptor shape from `GET /auth/permissions/:type` (§A.1):

| Field | Type | Required by |
|---|---|---|
| `key` | string, unique, `<category>:<action>` | `CreateEditRoleDialog.jsx:182`, `:374` |
| `value` | string (human label) | `CreateEditRoleDialog.jsx:387` |
| `category` | string (the map key) | `CreateEditRoleDialog.jsx:161`, `:354` |
| `isOpenSource` | boolean | `CreateEditRoleDialog.jsx:163` |
| `isEnterprise` | boolean | `CreateEditRoleDialog.jsx:164` |
| `isCloud` | boolean | `CreateEditRoleDialog.jsx:165` |
| *(implicit)* applicability | `ROLE` \| `API_KEY` | the `:type` path param — `CreateEditRoleDialog.jsx:134` vs `APIKeyDialog.jsx:71` |

The catalog must be filterable by both platform (3 booleans) and assignment target (`ROLE` /
`API_KEY`). Full key list in §B.

### D.8 `LoginMethod` (SSO provider configuration)

Per organization, per provider (§A.9):

| Field | Type | Required by |
|---|---|---|
| `organizationId` | FK → Organization, **nullable** | `ssoConfig.jsx:146`; the API module comments note org id "will be null" for the default/global case (`packages/ui/src/api/loginmethod.js:3`) |
| `name` / `providerName` | enum `azure` \| `google` \| `auth0` \| `github` | response uses `name` (`ssoConfig.jsx:345`), request uses `providerName` (`:151`) |
| `providerLabel` | string — `Microsoft` \| `Google` \| `Auth0` \| `Github` | `ssoConfig.jsx:151`, `:161`, `:170`, `:180` |
| `status` | enum `enable` \| `disable` | `ssoConfig.jsx:157`, `:355` |
| `config.clientID` | string | all four providers |
| `config.clientSecret` | string, **write-only — never returned** | `ssoConfig.jsx:36-37` |
| `config.tenantID` | string | azure only (`ssoConfig.jsx:153`) |
| `config.domain` | string | auth0 only (`ssoConfig.jsx:172`) |
| `callbackURL` | string, **server-generated, read-only** | returned in the separate `callbacks` array (`ssoConfig.jsx:348`) |
| `userId` | FK → User (who last configured) | `ssoConfig.jsx:147` |

### D.9 `LoginActivity` (audit record)

| Field | Type | Required by |
|---|---|---|
| `activityCode` | integer — `0,1,-1,-2,-3,-4` | `loginActivity.jsx:146-163` |
| `username` | string | `loginActivity.jsx:481` |
| `attemptedDateTime` | timestamp | `loginActivity.jsx:483`; also the range filter field |
| `loginMode` | string, nullable (falsy → `'Email/Password'`) | `loginActivity.jsx:486` |
| `message` | string | `loginActivity.jsx:488` |

Must support: filter by `attemptedDateTime` range, filter by `activityCode` set, offset pagination
returning `{ count, currentPage, pageSize, data }`, default page size 50.

Rows must be written for **failed** logins too — codes `-1` … `-4` correspond exactly to the
`UNKNOWN_USER` / `INCORRECT_PASSWORD` / `INACTIVE_USER` / `INVALID_WORKSPACE` error constants (§0.5).
Note `username` is stored as a **string**, not an FK — an unknown-user attempt (code `-1`) has no
user row to reference.

### D.10 `ApiKey`

| Field | Type | Required by |
|---|---|---|
| `id` | string | `APIKeyDialog.jsx:274` |
| `keyName` | string | `APIKeyDialog.jsx:223` |
| `permissions` | `string[]` (**native array**) | `packages/server/src/index.ts:281`; `APIKeyDialog.jsx:224` |
| `workspaceId` | FK → Workspace | `packages/server/src/index.ts:260` |

The API key's workspace transitively determines its organization, subscription, customer, product
and feature set (`packages/server/src/index.ts:259-286`). API keys **always** get
`isOrganizationAdmin: false` (`index.ts:287`).

### D.11 `SharedWorkspaceItem`

Implied by `GET`/`POST /workspace/shared/:id` (§A.7) — a join between an item id (credential or
custom template) and a set of workspaces it is visible in
(`packages/ui/src/ui-component/dialog/ShareWithWorkspaceDialog.jsx:75`, `:130`).

### D.12 `Session` / `RefreshToken`

Not directly modelled by the UI (cookies are opaque to it), but required by the observed protocol —
see §E and §F-4.

| Requirement | Evidence |
|---|---|
| An access credential with a **finite lifetime** | 401 `{ message: 'Token Expired', retry: true }` (`packages/ui/src/api/client.js:21`) |
| A **separately-lifetimed refresh credential** | `POST /auth/refreshToken` with an empty body succeeds on cookies alone (`client.js:24`) |
| Refresh response carries an `id` | `if (response.data.id)` (`client.js:25`) |
| A distinct **refresh-expired** terminal state | `ErrorMessage.REFRESH_TOKEN_EXPIRED = 'Refresh Token Expired'` (`packages/ui/src/store/constant.js:32`) |
| The session must bind `activeWorkspaceId` and be **re-mintable** on workspace switch | `POST /workspace/switch` returns a full new login payload (`packages/ui/src/store/reducers/authSlice.js:36-38`) |
| Password change must invalidate the session | client force-logs-out immediately after (`packages/ui/src/views/account/index.jsx:336`) |

### D.13 Entity summary

**12 entities:** User, Organization, OrganizationUser, Workspace, WorkspaceUser, Role, Permission
(catalog), LoginMethod, LoginActivity, ApiKey, SharedWorkspaceItem, Session/RefreshToken.

Relationship skeleton:

```
Organization 1─n Workspace
Organization 1─n Role
Organization 1─n OrganizationUser n─1 User      (exactly one row has isOrgOwner = true)
Workspace    1─n WorkspaceUser    n─1 User      (each row carries exactly one roleId)
WorkspaceUser n─1 Role
Workspace    1─n ApiKey
Organization 1─n LoginMethod                    (nullable organizationId = global default)
Role         n─n Permission        (materialised as a JSON string on Role.permissions)
ApiKey       n─n Permission        (materialised as a native array on ApiKey.permissions)
```

---

## E. Session / token handling

### E.1 Transport: cookies, not bearer tokens

Established by three independent facts:

1. `withCredentials: true` on the shared axios client (`packages/ui/src/api/client.js:11`).
2. **No code anywhere in `packages/ui/src/api/**` constructs an `Authorization` header.** The only
   headers set are `Content-type` and `x-request-from` (`client.js:7-10`).
3. Logout clears cookies client-side by expiring every cookie name on `path=/`
   (`packages/ui/src/utils/authUtils.js:28-33`).

The `token` field on the login payload is stored in Redux (`packages/ui/src/utils/authUtils.js:60`)
but **never read back and never attached to a request**. `authSlice` initialises it to `null` on
page load (`packages/ui/src/store/reducers/authSlice.js:9`), so it does not even survive a refresh.
See §F-4.

### E.2 Client-side session state

Persisted in `localStorage` by `AuthUtils.updateStateAndLocalStorage`
(`packages/ui/src/utils/authUtils.js:57-71`):

| Key | Value | Line |
|---|---|---|
| `isAuthenticated` | `'true'` | `:65` |
| `isGlobal` | stringified `user.isOrganizationAdmin` | `:66` |
| `isSSO` | stringified `user.isSSO` | `:67` |
| `user` | `JSON.stringify(extractUser(payload))` | `:68` |
| `permissions` | `JSON.stringify(payload.permissions)` | `:69` |
| `features` | `JSON.stringify(payload.features)` | `:70` |

Rehydrated at store construction (`packages/ui/src/store/reducers/authSlice.js:5-18`) with explicit
guards against the literal string `'undefined'` (`authSlice.js:11`, `:15`; also
`packages/ui/src/utils/authUtils.js:2`).

Cleared by `AuthUtils.removeCurrentUser` (`authUtils.js:14-17`): removes all six keys
(`:20-25`) **and** expires every cookie (`:28-33`).

⚠ `packages/ui/src/api/client.js:30-31` additionally removes `localStorage['username']` and
`localStorage['password']` on any 401 — implying credentials are persisted in plaintext elsewhere.
`packages/ui/src/views/organization/index.jsx:194` writes `username`. **A reimplementation should
not carry this forward.**

### E.3 Login flow

```
GET /settings                       -> { PLATFORM_TYPE }                      ConfigContext.jsx:15
   |
   +-- open source -> RBAC inert, everything permitted                        useAuth.jsx:12
   +-- cloud / enterprise:
        GET /loginmethod/default    -> { providers: [...] }                   signIn.jsx:102
        (render SSO buttons for azure/google/auth0/github)                    signIn.jsx:265-337
        |
        +-- password path:  POST /auth/login { email, password }              signIn.jsx:80-85
        |      200 -> loginSuccess(payload)  -> localStorage + Redux          signIn.jsx:120
        |             navigate(location.state?.path || '/')                   signIn.jsx:121
        |      401 + redirectUrl -> window.location.href = ...                signIn.jsx:90-92
        |      other -> render data.message                                   signIn.jsx:93
        |      message === 'User Email Unverified'
        |             -> reveal "Resend Verification Email"                   signIn.jsx:157-158
        |                POST /account/resend-verification { email }          signIn.jsx:170
        |
        +-- SSO path:  window.location.href = /api/v1/<provider>/login        signIn.jsx:165
               ... IdP round trip ...
               -> app lands on /sso-success?token=<t>                         ssoSuccess.jsx:14
               -> GET /auth/sso-success?token=<t>                             ssoSuccess.jsx:18
                  axios status 200 -> loginSuccess(user.data); navigate('/')  ssoSuccess.jsx:20-22
                  anything else    -> navigate('/login')                      ssoSuccess.jsx:24,27,30
```

The sign-in page **dispatches `logoutSuccess()` on mount** (`packages/ui/src/views/auth/signIn.jsx:99`)
— arriving at `/signin` always clears any existing client-side session.

`location.state.path` is the deep link captured by `RequireAuth` when it bounced an unauthenticated
user (`packages/ui/src/routes/RequireAuth.jsx:47`), and is honoured on successful login
(`signIn.jsx:121`).

### E.4 Refresh flow

Implemented entirely in the axios response interceptor
(`packages/ui/src/api/client.js:14-37`):

```
any response 401
  and data.message === 'Token Expired'
  and data.retry === true
      -> POST /api/v1/auth/refreshToken  {}   withCredentials: true      client.js:24
         response.data.id truthy ?
            yes -> apiClient.request(originalRequest)   (single replay)  client.js:27
            no  -> fall through to logout                                client.js:30-32
otherwise (any other 401)
      -> localStorage.removeItem('username'/'password')                  client.js:30-31
         AuthUtils.removeCurrentUser()                                   client.js:32
```

Server requirements:
- Signal refreshability explicitly: `401 { message: 'Token Expired', retry: true }`. Without
  `retry: true` no refresh is attempted.
- Accept the refresh with **no body** — the refresh credential must be a cookie.
- Return a body containing a truthy **`id`**.
- The refresh must set new auth cookies as a side effect; the client re-sends the original request
  without touching headers.
- **Only one replay is attempted.** There is no retry-loop guard, so a refresh that succeeds while
  the replay still 401s with `retry: true` would recurse — the server must not emit
  `retry: true` twice for the same failure.

### E.5 Logout flow

```
POST /account/logout                (no body)                       account.api.js:11
  200 { message: 'logged_out', redirectTo: '<url>' }
     -> store.dispatch(logoutSuccess())
          -> clears 6 localStorage keys + ALL cookies                authUtils.js:20-33
     -> window.location.href = redirectTo             WorkspaceSwitcher/index.jsx:211-212
  message !== 'logged_out' -> no-op (user stays logged in)
```

Whitelisted (`packages/server/src/utils/constants.ts:31`), so it succeeds even with an already-dead
session. Also called automatically after a successful password change
(`packages/ui/src/views/account/index.jsx:336`).

### E.6 How permissions reach the client

**Permissions are pushed in the authentication payload; there is no dedicated "my permissions"
endpoint.** They arrive as `payload.permissions: string[]` on exactly three occasions:

| Occasion | Reducer | Citation |
|---|---|---|
| `POST /auth/login` 200 | `loginSuccess` | `packages/ui/src/store/reducers/authSlice.js:24-26` |
| `GET /auth/sso-success` 200 | `loginSuccess` | `packages/ui/src/views/auth/ssoSuccess.jsx:21` |
| `POST /workspace/switch` 200 | `workspaceSwitchSuccess` | `packages/ui/src/store/reducers/authSlice.js:36-38` |

(A fourth reducer, `upgradePlanSuccess`, applies the same update — `authSlice.js:39-41` — but has no
call site.)

All three run the identical `AuthUtils.updateStateAndLocalStorage` (`authUtils.js:57-71`).

**Critical consequence:** permissions are a **cached snapshot**. A role change made by an
administrator does **not** propagate to an active session until that user logs in again or switches
workspace. There is no revalidation endpoint and no polling. Server-side checks remain
authoritative; the client cache only affects what the UI *offers*. See §F-10.

`GET /auth/permissions/:type` is the **catalog** (what permissions exist), never the current user's
grants — it is called only from the role editor and the API-key dialog
(`CreateEditRoleDialog.jsx:134`, `APIKeyDialog.jsx:71`).

### E.7 Route-guard algorithm

`packages/ui/src/routes/RequireAuth.jsx:30-88`, in order:

```
0. config still loading             -> render null                    :40-42
1. !currentUser                     -> /login, state.path = pathname  :46-48
2. isOpenSource                     -> allow iff no `display` flag    :52-54
3. isCloud || isEnterpriseLicensed:
     has `display`:
       permissions.length === 0     -> /unauthorized                  :61-63
       isGlobal                     -> checkFeatureFlag(...)          :66-68
       !permission || hasPermission -> checkFeatureFlag(...)          :71-73
       else                         -> /unauthorized                  :75
     no `display`:
       permission && !hasPermission && !isGlobal -> /unauthorized     :79-81
       else                         -> allow                          :83
4. no platform type matched         -> /unauthorized  (fail closed)   :86-87
```

`checkFeatureFlag` (`RequireAuth.jsx:15-28`) denies when `features` is absent, is an **array**, or
is an empty object (`:17`); otherwise accepts `'true'` or `true` (`:23`).

**Landing-page selection.** When the user hits `/`, `DefaultRedirect`
(`packages/ui/src/routes/DefaultRedirect.jsx:33-99`) walks an ordered list of 21 candidate screens
and renders the first for which the user satisfies both the permission and the display flag
(`:82-94`); if none match it renders the Unauthorized page (`:99`). Open-source and
`isGlobal` users always land on Chatflows (`:72-78`). The ordered list is at
`DefaultRedirect.jsx:40-64` and mirrors the menu order in
`packages/ui/src/menu-items/dashboard.js`.

### E.8 Rate limiting

Two distinct classes the server must distinguish (§A.14):

- **Authentication rate limit** — `429` with `{ type: 'authentication_rate_limit' }`. Renders an
  inline banner on the sign-in form; the user is **not** navigated away
  (`packages/ui/src/store/context/ErrorContext.jsx:18-19`; banner at
  `packages/ui/src/views/auth/signIn.jsx:188-192`). The sign-in and register pages clear this state
  on mount and on submit (`signIn.jsx:78`, `:100`; `register.jsx:126`, `:199`).
- **General rate limit** — `429` without that `type`. The client reads `Retry-After` (integer
  seconds or an HTTP-date; default 60) and navigates to `/rate-limited`
  (`ErrorContext.jsx:20-34`), which renders "429 Too Many Requests … wait {n}s"
  (`packages/ui/src/views/auth/rateLimited.jsx:35-39`).

---

## F. Gaps — decisions left to the implementer

Ordered roughly by impact.

### F-1. The `status` / `lastLogin` ownership split

`status` and `lastLogin` appear on **three** shapes: the login payload
(`packages/ui/src/utils/authUtils.js:40`, `:49`), the org-user row
(`packages/ui/src/views/users/index.jsx:154`, `:158`), and the workspace-user row
(`packages/ui/src/views/workspace/WorkspaceUsers.jsx:486`, `:499`). The interface does not reveal
whether these are the same column denormalised or genuinely per-scope values (i.e. whether a user
can be `active` in one org and `inactive` in another).

**Decision required:** own `status`/`lastLogin` on `User` and denormalise into the membership
projections (simplest, matches "Account Status" phrasing in `EditUserDialog.jsx:178`), **or** own
them on `OrganizationUser` and support per-org suspension. Note `PUT /organizationuser` takes
`{userId, organizationId, status}` (`EditUserDialog.jsx:80-84`) — an org-scoped write signature,
which mildly favours the second reading.

### F-2. `user.role` on the login payload

`AuthUtils.extractUser` copies a top-level `role` field (`packages/ui/src/utils/authUtils.js:41`)
into the cached user, but **no component ever reads `currentUser.role`**. Meanwhile the real
role lives on the `WorkspaceUser` join.

**Decision required:** populate it with the name of the role held in `activeWorkspaceId` (most
consistent), or omit it. Omitting is safe — nothing renders it — but it must then not be relied on
by any new client code.

### F-3. `tempToken` multiplexing

One field name carries four unrelated single-use tokens: workspace invite code
(`register.jsx:142`), email verification (`verify-email.jsx:58`), password reset
(`resetPassword.jsx:104`), and email-change confirmation (`confirm-email-change.jsx:56`).

**Decision required:** a single-purpose column cannot serve concurrent flows (e.g. a user with a
pending email change who also requests a password reset). Model a separate `Token` entity with
`{ userId, purpose, value, expiresAt, consumedAt }` and keep `tempToken` purely as the wire field
name. Also undetermined: token TTLs, single-use enforcement, and whether issuing a new token of a
purpose invalidates the prior one.

### F-4. The unused `token` field

The login payload carries `token` (`packages/ui/src/utils/authUtils.js:60`), stored in Redux and
never used — no request attaches it, and `authSlice` resets it to `null` on reload
(`packages/ui/src/store/reducers/authSlice.js:9`).

**Decision required:** either (a) return it for API-client convenience and treat cookies as the only
supported browser mechanism, or (b) omit it entirely. Do **not** treat its presence as evidence that
bearer auth is supported — no code path exercises it. Cookie attributes (`HttpOnly`, `Secure`,
`SameSite`, `Path`, `Domain`, lifetime) are entirely undetermined by the Apache-2.0 sources;
recommend `HttpOnly; Secure; SameSite=Lax` with a short-lived access cookie and a longer-lived
refresh cookie scoped to `/api/v1/auth/refreshToken`.

### F-5. `redirectTo` on logout

The logout response must include `redirectTo` (`WorkspaceSwitcher/index.jsx:212`), but nothing
determines its value for a **local** (non-SSO) session.

**Decision required:** presumably the app's own `/signin`. For SSO sessions it should presumably be
the IdP end-session URL — but whether the server performs IdP single-logout, and what
`LOGOUT_URI` per provider actually does, is undetermined here. Also undetermined: whether
`redirectTo` should be validated against an allow-list (it is fed straight into
`window.location.href`, so an unvalidated server-controlled value is an open-redirect surface).

### F-6. SSO provider URI shapes

`WHITELIST_URLS` references `AzureSSO.LOGIN_URI / LOGOUT_URI / CALLBACK_URI` and the same triple for
Google, Auth0 and Github (`packages/server/src/utils/constants.ts:46-57`), but the constants
themselves live outside the Apache-2.0 scope. The UI only pins the **login** path shape:
`/api/v1/<provider>/login` (`packages/ui/src/views/auth/signIn.jsx:165`).

**Decision required:** the concrete callback and logout paths. Suggested symmetric scheme:
`/api/v1/<provider>/callback` and `/api/v1/<provider>/logout`. Also undetermined: OAuth state/PKCE
handling, IdP→local account linking (match on email? auto-provision? which workspace and role does
a first-time SSO user land in?), and what happens when an SSO identity's email collides with an
existing local account.

### F-7. The `redirectUrl` double-nesting on login 401

`packages/ui/src/views/auth/signIn.jsx:90-92` **guards** on `error.response.data.redirectUrl` but
**reads** `error.response.data.data.redirectUrl`. Only one of the two can be the intended contract.

**Decision required:** emit both keys (`{ redirectUrl, data: { redirectUrl } }`) to satisfy the
shipped client, and fix the client in the reimplementation. Note this is a *third* redirect field
name, alongside `redirectUrl` used by the SSO 401 path (`signIn.jsx:139-141`) and `redirectTo` used
by the generic 401 handler (`ErrorContext.jsx:42-48`). Consider unifying on one name.

### F-8. Organization display name

`Organization.name` is accepted at first-run setup (`packages/ui/src/views/organization/index.jsx:128-130`)
but the breadcrumb ignores it, rendering `` `${owner.name || owner.email}'s Organization` ``
(`OrgWorkspaceBreadcrumbs/index.jsx:226`).

**Decision required:** return `name` on the `?userId=` org list and render it, falling back to the
derived label only when null. As written, the stored org name is effectively write-only.

### F-9. Endpoints with no observable consumer

Defined in the Apache-2.0 API modules but never called from `packages/ui/src`, so their
request/response shapes are **completely undetermined**:

| Endpoint | Definition |
|---|---|
| `GET /auth/roles/:id` | `packages/ui/src/api/role.js:4` |
| `GET /auth/roles/name/:name` | `packages/ui/src/api/role.js:7` |
| `POST /workspace/link-users/:id` | `packages/ui/src/api/workspace.js:8` |
| `POST /workspace/unlink-users/:id` | `packages/ui/src/api/workspace.js:7` |
| `GET /organization/plan-proration` | `packages/ui/src/api/user.js:23-24` |
| `POST /organization/update-subscription-plan` | `packages/ui/src/api/user.js:25-26` |
| `GET /user/test` | whitelisted at `packages/server/src/utils/constants.ts:40` |
| `POST /oauth2-credential/authorize/:id`, `/refresh/:id`, `GET /callback` | `packages/ui/src/api/oauth2.js:3,5,7` — credential OAuth, adjacent to but distinct from user identity |

Additionally, the entire seats/proration dialog cluster is dead code in the shipped UI (§A.6), so
`customer-default-source`, `additional-seats-proration` and `update-additional-seats` have shapes
derived from *rendering code that never executes*. Treat those shapes as advisory.

**Decision required:** implement, stub, or omit. The two `link-users`/`unlink-users` endpoints are
the most likely to be genuinely needed (bulk workspace membership); the UI currently achieves the
same effect with N× `DELETE /workspaceuser` (`WorkspaceUsers.jsx:208`).

### F-10. Permission-cache staleness

Permissions reach the client only at login / SSO-success / workspace-switch (§E.6). A role edit does
not reach an active session.

**Decision required:** accept the staleness (server checks remain authoritative — the only real
consequence is that the UI briefly offers actions that will 403), or add a revalidation mechanism
(short-lived permission cache with an `ETag`-style probe, a `GET /auth/me`, or push). Nothing in the
Apache-2.0 sources implies such a mechanism exists.

### F-11. Password-policy authority

The only policy expressed anywhere in the Apache-2.0 sources is the **client-side** zod schema
(`passwordSchema` in `packages/ui/src/utils/validation.js`, imported at
`packages/ui/src/views/auth/register.jsx:25` and used at `resetPassword.jsx:93`): min 8, max 128,
≥1 lowercase, ≥1 uppercase, ≥1 digit, ≥1 special.

**Decision required:** the server MUST enforce at least this (client validation is bypassable), and
must independently decide hashing algorithm and parameters, password history/reuse rules, and
whether `GeneralErrorMessage.INVALID_PASSWORD` (`packages/server/src/utils/constants.ts:73`) is
returned for a policy violation or only for a failed `oldPassword` check.

### F-12. Registration → organization/workspace bootstrap

`POST /account/register` with an `organization` key creates an org
(`packages/ui/src/views/organization/index.jsx:127-131`), and every user must end up with an
`activeWorkspaceId` or login fails with `'No Workspace Assigned'`
(`packages/ui/src/store/constant.js:37`, audit code `-4`).

**Decision required (all undetermined):**
- Does org creation auto-create a `'Default Workspace'` (the name is special-cased at
  `packages/ui/src/views/workspace/index.jsx:130`)?
- What role does the org owner receive, and is a built-in owner/admin role seeded — or is
  `isOrganizationAdmin` purely a flag that bypasses roles entirely (as
  `packages/server/src/controllers/chatflows/index.ts:71` suggests)?
- What is the `'personal workspace'` role (`workspace/index.jsx:193`) and when is it assigned?
- Is a set of default roles seeded per organization, and if so with which permission sets?
- `existingWorkspaceId` on `POST /workspace` is documented as *"used to inherit the current role"*
  (`AddEditWorkspaceDialog.jsx:102`) — exact inheritance semantics (copy the role assignment? copy
  the role definition? by name or by id?) are undetermined.

### F-13. Invite lifecycle

`POST /account/invite` takes `{user:{email,createdBy}, workspace:{id}, role:{id}}`
(`InviteUsersDialog.jsx:312-336`) and users appear with `status: 'invited'`
(`users/index.jsx:155`).

**Decision required:** invite expiry, resend/revoke semantics (the UI offers "Update Invite" —
`users/index.jsx:295` — but sends the same `POST /account/invite`, so re-inviting must be
idempotent), what happens when an invited email already has an account in another org, and whether
accepting an invite consumes the `tempToken` (§F-3).

### F-14. `'********'` sentinel robustness

The SSO config save transmits the literal `'********'` when a secret is unchanged
(`packages/ui/src/views/auth/ssoConfig.jsx:155`, `:164`, `:174`, `:183`) and the server must
interpret it as "retain stored value" (§A.9).

**Decision required:** this collides with any real secret equal to eight asterisks. Preferred fix is
a dedicated boolean (e.g. `clientSecretUnchanged: true`) plus a client change; if the shipped client
must be supported unchanged, the sentinel is mandatory and the collision must be documented.

### F-15. Known client-side defects to repair rather than reproduce

Recorded so an implementer does not mistake them for contract:

1. `packages/ui/src/views/auth/ssoConfig.jsx:248` cases on the misspelling `'Gtihub'` while
   `getSelectedProviderName()` returns `'Github'` (`:338`) — GitHub fields are never validated
   before a test call.
2. `packages/ui/src/views/auth/loginActivity.jsx:184-189` sends only `{pageNo:1}` on mount, ignoring
   the date range already shown in the pickers.
3. Selecting the "Unknown Activity" filter sends `activityCodes: [-99]`
   (`loginActivity.jsx:180`), a code never stored.
4. Unguarded `error.response.data` dereferences in catch blocks throw a secondary `TypeError` on
   network failures — `packages/ui/src/views/account/index.jsx:275`, `:352`, `:399`;
   `packages/ui/src/views/auth/ssoConfig.jsx:219`, `:296`; and `client.js:19` reads
   `error.response.status` unguarded.
5. `packages/ui/src/views/users/EditUserDialog.jsx:103` references an undefined identifier `err`
   inside the catch block.
6. `packages/ui/src/views/roles/CreateEditRoleDialog.jsx:77-78` and `:84-85` destructure
   `[permissionKey, isEnabled]` from the output of `Object.keys(...)` (strings, not entries) — the
   auto-enable-view coupling rule is effectively inert.
7. Credentials are persisted in plaintext localStorage under `username` / `password`
   (`client.js:30-31`; written at `packages/ui/src/views/organization/index.jsx:194`).

---

## Appendix: quick reference

**Endpoints:** 53 · **Permissions:** 82 (61 route-enforced, 21 UI-only) · **Feature flags:** 11 ·
**Entities:** 12

**Non-negotiable invariants**

1. `x-request-from: internal` selects session auth; its absence selects API-key auth
   (`packages/server/src/index.ts:239`).
2. Cookies carry the session — no bearer header exists anywhere in the UI
   (`packages/ui/src/api/client.js:11`).
3. `req.user.permissions` is a flat `string[]`; `checkAnyPermission` is any-of over a
   comma-separated list (`packages/ui/src/hooks/useAuth.jsx:16-18`).
4. `isOrganizationAdmin` bypasses all permission evaluation
   (`packages/server/src/controllers/chatflows/index.ts:71`; `packages/ui/src/hooks/useAuth.jsx:12`).
5. 401 = authentication failure (client logs out); 403 = authorization failure (client shows
   Forbidden). The split drives client routing (`packages/ui/src/store/context/ErrorContext.jsx:35-55`).
6. `POST /workspace/switch` re-issues the **entire** login payload — permissions are workspace-scoped
   (`packages/ui/src/store/reducers/authSlice.js:36-38`).
7. Role `permissions` is a JSON **string**; API-key `permissions` is a native **array**
   (`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:232` vs
   `packages/ui/src/views/apikey/APIKeyDialog.jsx:224`).
8. The permission-catalog category name must prefix its own keys (`` `${category}:view` ``), with
   `templates` as the sole exception
   (`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:69-75`).
9. `401 { message: 'Token Expired', retry: true }` is the only refresh trigger
   (`packages/ui/src/api/client.js:21`).
10. Open-source deployments grant every permission unconditionally
    (`packages/ui/src/hooks/useAuth.jsx:12`).
