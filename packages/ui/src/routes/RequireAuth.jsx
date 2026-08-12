import RouteErrorBoundary from '@/routes/RouteErrorBoundary'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/store/context/ConfigContext'
import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'
import { Navigate } from 'react-router'
import { useLocation } from 'react-router-dom'

/**
 * Flow-Wiser has ONE tier, and that is why this guard no longer branches on one.
 *
 * Upstream shipped three deployment types — open source, cloud, enterprise — and the `display`
 * prop named a licence-gated feature. The open-source branch read:
 *
 *     if (isOpenSource) return !display ? children : <Navigate to='/unauthorized' />
 *
 * so EVERY route carrying a `display` flag was redirected, unconditionally, on an open-source
 * deployment. That was correct upstream: those features were commercial and genuinely absent.
 *
 * It is wrong here. Users, roles, workspaces, SSO configuration, login activity and audit are
 * exactly the surfaces this fork reimplemented from scratch under Apache 2.0 — they are the point
 * of the fork. Leaving the upstream gate in place meant Flow-Wiser hid its own features from its
 * own administrators and told them they were "unauthorized", which was not true: they held every
 * permission. The server reports `PLATFORM_TYPE: "open source"`, so this fired for every route with
 * a `display` prop on every deployment.
 *
 * Authorisation is decided by permission, and the server enforces it independently — this guard is
 * a navigation convenience, never the control. A page that a user should not reach is denied by the
 * API regardless of what the client renders.
 *
 * `display` is still accepted so the route table does not have to change, and is deliberately
 * ignored. Three of the routes it used to hide (`/users`, `/roles`, `/login-activity`) sit on
 * endpoints that answer 501 in this build; they now load and report that honestly instead of
 * claiming a permission problem that does not exist. See docs/STATUS.md.
 */
export const RequireAuth = ({ permission, children }) => {
    const location = useLocation()
    const { loading } = useConfig()
    const { hasPermission } = useAuth()
    const isGlobal = useSelector((state) => state.auth.isGlobal)
    const currentUser = useSelector((state) => state.auth.user)

    // Wait for config to load
    if (loading) {
        return null
    }

    // Authentication: not signed in is a login problem, not an authorisation one.
    if (!currentUser) {
        return <Navigate to='/login' replace state={{ path: location.pathname }} />
    }

    // Authorisation: organisation admins bypass, everyone else needs the permission.
    if (permission && !isGlobal && !hasPermission(permission)) {
        return <Navigate to='/unauthorized' replace />
    }

    // Every protected route already passes through here, which makes it the one place that can
    // guarantee a boundary without each route remembering to add one. A view that throws during
    // render or in an effect now costs that view, not the whole application — see UI-02, where an
    // unguarded `.find()` on an empty API response blanked the entire UI.
    return <RouteErrorBoundary>{children}</RouteErrorBoundary>
}

RequireAuth.propTypes = {
    permission: PropTypes.string,
    // Accepted and ignored: an upstream licence-tier flag. Kept so the route table does not need
    // to change, and so removing it is a separate, reviewable commit.
    display: PropTypes.string,
    children: PropTypes.element
}
