import textToSpeechService from '../../src/services/text-to-speech'
import credentialsService from '../../src/services/credentials'
import { getVoices } from 'flowise-components'

jest.mock('../../src/services/credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: jest.fn() }
}))
jest.mock('../../src/utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ AppDataSource: {} })
}))
jest.mock('../../src/utils', () => ({ databaseEntities: {} }))
jest.mock('flowise-components', () => ({ getVoices: jest.fn() }))

describe('TTS voice discovery credential isolation', () => {
    const assertAccess = credentialsService.assertCredentialInWorkspace as jest.Mock
    const listVoices = getVoices as jest.Mock

    beforeEach(() => {
        jest.resetAllMocks()
        listVoices.mockResolvedValue([{ id: 'synthetic-voice' }])
    })

    it('refuses a foreign credential before contacting a voice provider', async () => {
        assertAccess.mockRejectedValue(new Error('Credential is outside the active workspace'))
        await expect((textToSpeechService.getVoices as any)('openai', 'foreign-credential', 'workspace-a')).rejects.toThrow(
            'outside the active workspace'
        )
        expect(assertAccess).toHaveBeenCalledWith('foreign-credential', 'workspace-a')
        expect(listVoices).not.toHaveBeenCalled()
    })

    it('allows an authorized credential after the workspace check succeeds', async () => {
        assertAccess.mockResolvedValue(undefined)
        await expect((textToSpeechService.getVoices as any)('openai', 'owned-credential', 'workspace-a')).resolves.toEqual([
            { id: 'synthetic-voice' }
        ])
        expect(assertAccess).toHaveBeenCalledWith('owned-credential', 'workspace-a')
        expect(listVoices).toHaveBeenCalledTimes(1)
        expect(assertAccess.mock.invocationCallOrder[0]).toBeLessThan(listVoices.mock.invocationCallOrder[0])
    })

    it('does not call a provider when no credential was supplied', async () => {
        await expect((textToSpeechService.getVoices as any)('openai', undefined, 'workspace-a')).rejects.toThrow('Credential ID required')
        expect(listVoices).not.toHaveBeenCalled()
    })
})
