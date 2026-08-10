import { StatusCodes } from 'http-status-codes'
import { omit } from 'lodash'
import { ICredentialReturnResponse } from '../../Interface'
import { Credential } from '../../database/entities/Credential'
import { WorkspaceShared } from '../../database/entities/identity'
import { WorkspaceService } from '../../identity/services/WorkspaceService'
import { getWorkspaceSearchOptions } from '../../identity/tenancy/ControllerServiceUtils'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { decryptCredentialData, transformToCredentialEntity, REDACTED_CREDENTIAL_VALUE } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const createCredential = async (requestBody: any) => {
    try {
        const appServer = getRunningExpressApp()
        const newCredential = await transformToCredentialEntity(requestBody)

        if (requestBody.id) {
            newCredential.id = requestBody.id
        }

        const credential = await appServer.AppDataSource.getRepository(Credential).create(newCredential)
        const dbResponse = await appServer.AppDataSource.getRepository(Credential).save(credential)
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: credentialsService.createCredential - ${getErrorMessage(error)}`
        )
    }
}

// Delete all credentials from chatflowid
/**
 * Does this credential belong to this workspace?
 *
 * A membership test, deliberately returning a boolean rather than the credential: the callers that
 * need this are decrypting the credential for their own use and must not be tempted to take the row
 * from here and skip their own scoping.
 *
 * Exists because `getCredentialData` in packages/components resolves `findOneBy({ id })` with no
 * workspace predicate — correct for its own callers, which have already established scope, and a
 * cross-tenant IDOR for any caller that has not. GHSA-8gj2-2cvc-6xx7 was exactly that: an
 * unauthenticated endpoint passing a body-supplied id straight through.
 */
const credentialBelongsToWorkspace = async (credentialId: string, workspaceId: string): Promise<boolean> => {
    if (!credentialId || !workspaceId) return false
    try {
        const appServer = getRunningExpressApp()
        const found = await appServer.AppDataSource.getRepository(Credential).findOneBy({
            id: credentialId,
            workspaceId
        })
        return !!found
    } catch (error) {
        // Fail closed: an error here means ownership is indeterminate.
        return false
    }
}

const deleteCredentials = async (credentialId: string, workspaceId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(Credential).delete({ id: credentialId, workspaceId: workspaceId })
        if (!dbResponse) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: credentialsService.deleteCredential - ${getErrorMessage(error)}`
        )
    }
}

const getAllCredentials = async (paramCredentialName: any, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        let dbResponse: any[] = []
        if (paramCredentialName) {
            if (Array.isArray(paramCredentialName)) {
                for (let i = 0; i < paramCredentialName.length; i += 1) {
                    const name = paramCredentialName[i] as string
                    const searchOptions = {
                        credentialName: name,
                        ...getWorkspaceSearchOptions(workspaceId)
                    }
                    const credentials = await appServer.AppDataSource.getRepository(Credential).findBy(searchOptions)
                    dbResponse.push(...credentials.map((c) => omit(c, ['encryptedData'])))
                }
            } else {
                const searchOptions = {
                    credentialName: paramCredentialName,
                    ...getWorkspaceSearchOptions(workspaceId)
                }
                const credentials = await appServer.AppDataSource.getRepository(Credential).findBy(searchOptions)
                dbResponse = credentials.map((c) => omit(c, ['encryptedData']))
            }
            // get shared credentials
            if (workspaceId) {
                const workspaceService = new WorkspaceService()
                const sharedItems = (await workspaceService.getSharedItemsForWorkspace(workspaceId, 'credential')) as Credential[]
                if (sharedItems.length) {
                    for (const sharedItem of sharedItems) {
                        // Check if paramCredentialName is array
                        if (Array.isArray(paramCredentialName)) {
                            for (let i = 0; i < paramCredentialName.length; i += 1) {
                                const name = paramCredentialName[i] as string
                                if (sharedItem.credentialName === name) {
                                    // @ts-ignore
                                    sharedItem.shared = true
                                    dbResponse.push(omit(sharedItem, ['encryptedData']))
                                }
                            }
                        } else {
                            if (sharedItem.credentialName === paramCredentialName) {
                                // @ts-ignore
                                sharedItem.shared = true
                                dbResponse.push(omit(sharedItem, ['encryptedData']))
                            }
                        }
                    }
                }
            }
        } else {
            const credentials = await appServer.AppDataSource.getRepository(Credential).findBy(getWorkspaceSearchOptions(workspaceId))
            for (const credential of credentials) {
                dbResponse.push(omit(credential, ['encryptedData']))
            }

            // get shared credentials
            if (workspaceId) {
                const workspaceService = new WorkspaceService()
                const sharedItems = (await workspaceService.getSharedItemsForWorkspace(workspaceId, 'credential')) as Credential[]
                if (sharedItems.length) {
                    for (const sharedItem of sharedItems) {
                        // @ts-ignore
                        sharedItem.shared = true
                        dbResponse.push(omit(sharedItem, ['encryptedData']))
                    }
                }
            }
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: credentialsService.getAllCredentials - ${getErrorMessage(error)}`
        )
    }
}

const getCredentialById = async (credentialId: string, workspaceId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const credential = await appServer.AppDataSource.getRepository(Credential).findOneBy({
            id: credentialId,
            workspaceId: workspaceId
        })
        if (!credential) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
        }
        // Decrpyt credentialData
        const decryptedCredentialData = await decryptCredentialData(
            credential.encryptedData,
            credential.credentialName,
            appServer.nodesPool.componentCredentials
        )
        // SECURITY (assessment finding N7, 2026-08-07): this used to return the DECRYPTED values.
        //
        // The route requires `credentials:create` or `credentials:update`, which four of the six
        // system roles hold — including `org-admin` and `user`. Both are explicitly designed NOT to
        // see credential VALUES: BootstrapService documents org-admin as "Credential RECORDS but
        // never their values — the §3 credential-value split", and `credentials:reveal` exists as a
        // separate admin-only grant for exactly that reason. It was enforced on no route at all, so
        // the split was documented and never implemented.
        //
        // Values are redacted here. `GET /:id/reveal` is the one path that discloses them, and it
        // now requires `credentials:reveal` and writes an audit record.
        const redactedDataObj: Record<string, any> = { ...decryptedCredentialData }
        for (const key of Object.keys(redactedDataObj)) {
            redactedDataObj[key] = REDACTED_CREDENTIAL_VALUE
        }
        const returnCredential: ICredentialReturnResponse = {
            ...credential,
            plainDataObj: redactedDataObj
        }
        const dbResponse: any = omit(returnCredential, ['encryptedData'])
        if (workspaceId) {
            const shared = await appServer.AppDataSource.getRepository(WorkspaceShared).count({
                where: {
                    workspaceId: workspaceId,
                    sharedItemId: credentialId,
                    itemType: 'credential'
                }
            })
            if (shared > 0) {
                dbResponse.shared = true
            }
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: credentialsService.createCredential - ${getErrorMessage(error)}`
        )
    }
}

const updateCredential = async (credentialId: string, requestBody: any, workspaceId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const credential = await appServer.AppDataSource.getRepository(Credential).findOneBy({
            id: credentialId,
            workspaceId: workspaceId
        })
        if (!credential) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
        }
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const incomingData = requestBody.plainDataObj ?? {}
        requestBody.plainDataObj = { ...decryptedCredentialData, ...incomingData }
        const updateCredential = await transformToCredentialEntity(requestBody)
        updateCredential.workspaceId = workspaceId
        await appServer.AppDataSource.getRepository(Credential).merge(credential, updateCredential)
        const dbResponse = await appServer.AppDataSource.getRepository(Credential).save(credential)
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: credentialsService.updateCredential - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Confirms a credential exists and belongs to (or is shared with) the given workspace.
 * Does NOT decrypt or return credential material — only used for authorization checks.
 * Throws 400 when workspaceId is missing (prevents unscoped lookup), 404 when the
 * credential does not belong to the workspace or is not shared with it.
 */
const assertCredentialInWorkspace = async (credentialId: string, workspaceId: string | undefined): Promise<void> => {
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Workspace ID is required`)
    }
    const appServer = getRunningExpressApp()
    const owned = await appServer.AppDataSource.getRepository(Credential).findOneBy({
        id: credentialId,
        workspaceId: workspaceId
    })
    if (owned) return

    const shared = await appServer.AppDataSource.getRepository(WorkspaceShared).count({
        where: {
            workspaceId: workspaceId,
            sharedItemId: credentialId,
            itemType: 'credential'
        }
    })
    if (shared > 0) return

    throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
}

const revealCredentialById = async (credentialId: string, workspaceId: string): Promise<any> => {
    try {
        const appServer = getRunningExpressApp()
        const credential = await appServer.AppDataSource.getRepository(Credential).findOneBy({
            id: credentialId,
            workspaceId: workspaceId
        })
        if (!credential) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
        }
        const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
        const componentCredentials = appServer.nodesPool.componentCredentials
        const inputs = componentCredentials[credential.credentialName]?.inputs ?? []
        // N7: this function REDACTED everything except url-typed inputs, despite being the
        // endpoint named "reveal" — while the plain GET returned full plaintext. The two were
        // inverted. `reveal` now does what it says, gated on `credentials:reveal` at the route and
        // recorded in the audit trail, because disclosing a secret to a human is exactly the event
        // §10 requires to be auditable.
        void inputs
        return { plainDataObj: decryptedCredentialData }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: credentialsService.revealCredentialById - ${getErrorMessage(error)}`
        )
    }
}

export default {
    credentialBelongsToWorkspace,
    createCredential,
    deleteCredentials,
    getAllCredentials,
    getCredentialById,
    revealCredentialById,
    updateCredential,
    assertCredentialInWorkspace
}
