import { useSelector } from 'react-redux'
import { useConfig } from '@/store/context/ConfigContext'

export const useAuth = () => {
    const { isOpenSource } = useConfig()
    const permissions = useSelector((state) => state.auth.permissions)
    const isGlobal = useSelector((state) => state.auth.isGlobal)
    const currentUser = useSelector((state) => state.auth.user)

    const hasPermission = (permissionId) => {
        if (isOpenSource || isGlobal) {
            return true
        }
        if (!permissionId) return false
        const permissionIds = permissionId.split(',')
        if (permissions && permissions.length) {
            return permissionIds.some((permissionId) => permissions.includes(permissionId))
        }
        return false
    }

    const hasAssignedWorkspace = (workspaceId) => {
        if (isOpenSource || isGlobal) {
            return true
        }
        const activeWorkspaceId = currentUser?.activeWorkspaceId || ''
        if (workspaceId === activeWorkspaceId) {
            return true
        }
        return false
    }

    /**
     * `display` was upstream's licence-tier flag, and this returned false whenever the server sent
     * no feature map — which it never does here, because Flow-Wiser has no licence tiers. The effect
     * was that the sidebar hid Users, Roles, Workspaces, SSO configuration and Login activity: the
     * surfaces this fork reimplemented under Apache 2.0, hidden from the administrators who own them.
     *
     * It is kept as a function rather than deleted so the call sites stay readable and removing the
     * flag from the menu definitions is a separate, reviewable change. Visibility is decided by
     * permission (`hasPermission`), and the server enforces access independently of both.
     */
    const hasDisplay = () => true

    return { hasPermission, hasAssignedWorkspace, hasDisplay }
}
