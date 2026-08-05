/* eslint-disable */
/**
 * Apache-2.0 identity / RBAC data layer (docs/SPEC-AUTH-RBAC.md §D).
 *
 * Ten entities, all mapped to `identity_`-prefixed tables so this schema is disjoint from the one
 * the outgoing stack created and both can coexist during cut-over.
 *
 * Registration: these are exported as `identityEntities` and are NOT yet merged into the global
 * `entities` map in `../index.ts`. That map still binds the names User/Organization/Role/… to the
 * outgoing entities; merging both sets would bind the same class names twice. The cut-over commit
 * that removes the outgoing stack replaces those imports with `...identityEntities` here.
 */
import { User } from './User'
import { Organization } from './Organization'
import { OrganizationUser } from './OrganizationUser'
import { Workspace } from './Workspace'
import { WorkspaceUser } from './WorkspaceUser'
import { Role } from './Role'
import { LoginMethod } from './LoginMethod'
import { LoginActivity } from './LoginActivity'
import { Session } from './Session'
import { Token } from './Token'

export { User } from './User'
export { Organization } from './Organization'
export { OrganizationUser, MemberStatus } from './OrganizationUser'
export { Workspace, DEFAULT_WORKSPACE_NAME } from './Workspace'
export { WorkspaceUser } from './WorkspaceUser'
export { Role, PERSONAL_WORKSPACE_ROLE_NAME } from './Role'
export { LoginMethod, LoginMethodProvider, LoginMethodStatus } from './LoginMethod'
export { LoginActivity, LoginActivityCode } from './LoginActivity'
export { Session, SessionRevokeReason } from './Session'
export { Token, TokenPurpose } from './Token'

export const identityEntities = {
    User,
    Organization,
    OrganizationUser,
    Workspace,
    WorkspaceUser,
    Role,
    LoginMethod,
    LoginActivity,
    Session,
    Token
}
