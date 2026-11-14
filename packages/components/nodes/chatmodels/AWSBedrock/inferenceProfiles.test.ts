/**
 * Inference-profile discovery must not remember a failure.
 *
 * The result is cached per region for the life of the process. It used to cache the EMPTY result of
 * a failed call too, so one failure — credentials not ready at startup, a throttled request — meant
 * no inference profile was ever applied in that region again, and Bedrock rejected models that
 * need one until the server was restarted.
 */
const send = jest.fn()

jest.mock('@aws-sdk/client-bedrock', () => ({
    BedrockClient: jest.fn().mockImplementation(() => ({ send })),
    ListInferenceProfilesCommand: jest.fn().mockImplementation((input: unknown) => ({ input }))
}))

import { _resetRegionProfileCache, discoverInferenceProfiles } from './utils'

const page = (ids: string[], nextToken?: string) => ({
    inferenceProfileSummaries: ids.map((inferenceProfileId) => ({ inferenceProfileId })),
    nextToken
})

describe('discoverInferenceProfiles', () => {
    let errors: jest.SpyInstance

    beforeEach(() => {
        send.mockReset()
        _resetRegionProfileCache()
        errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })
    afterEach(() => errors.mockRestore())

    // NEGATIVE test: the original defect.
    it('asks again after a failure instead of remembering an empty result', async () => {
        send.mockRejectedValueOnce(new Error('credentials are not available yet'))
        expect((await discoverInferenceProfiles('eu-west-1')).size).toBe(0)

        send.mockResolvedValueOnce(page(['eu.amazon.nova-pro-v1:0']))
        expect([...(await discoverInferenceProfiles('eu-west-1'))]).toEqual(['eu.amazon.nova-pro-v1:0'])
        expect(send).toHaveBeenCalledTimes(2)
    })

    it('says that discovery failed, naming the region', async () => {
        send.mockRejectedValueOnce(new Error('AccessDenied'))
        await discoverInferenceProfiles('us-east-1')
        expect(errors).toHaveBeenCalledTimes(1)
        expect(String(errors.mock.calls[0][0])).toContain('us-east-1')
    })

    it('asks again after an empty answer, which may only mean "not yet"', async () => {
        send.mockResolvedValueOnce(page([]))
        expect((await discoverInferenceProfiles('ap-south-1')).size).toBe(0)
        send.mockResolvedValueOnce(page(['apac.amazon.nova-lite-v1:0']))
        expect((await discoverInferenceProfiles('ap-south-1')).size).toBe(1)
    })

    it('still caches a real answer: one request per region, however often it is asked', async () => {
        send.mockResolvedValueOnce(page(['us.amazon.nova-pro-v1:0']))
        await discoverInferenceProfiles('us-west-2')
        await discoverInferenceProfiles('us-west-2')
        await discoverInferenceProfiles('us-west-2')
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('keeps regions apart', async () => {
        send.mockResolvedValueOnce(page(['us.a'])).mockResolvedValueOnce(page(['eu.b']))
        expect([...(await discoverInferenceProfiles('us-east-1'))]).toEqual(['us.a'])
        expect([...(await discoverInferenceProfiles('eu-west-1'))]).toEqual(['eu.b'])
    })

    it('follows pagination to the end', async () => {
        send.mockResolvedValueOnce(page(['us.a'], 'more')).mockResolvedValueOnce(page(['us.b']))
        expect([...(await discoverInferenceProfiles('us-east-2'))].sort()).toEqual(['us.a', 'us.b'])
        expect(send).toHaveBeenCalledTimes(2)
    })
})
