import client from './client'

// flow & prompt version history — see docs/REQUIREMENTS-VERSIONING.md
const getVersions = (id, params) => client.get(`/flow-versions/${id}`, { params })

const getVersionAt = (id, when) => client.get(`/flow-versions/${id}/at`, { params: { when } })

// `b` is optional — omitting it diffs against the flow's current saved state
const getDiff = (id, a, b, promptsOnly) =>
    client.get(`/flow-versions/${id}/diff`, { params: { a, ...(b ? { b } : {}), ...(promptsOnly ? { prompts: 'true' } : {}) } })

const tagVersion = (id, ref, label) => client.post(`/flow-versions/${id}/tag`, { ref, label })

const restoreVersion = (id, ref) => client.post(`/flow-versions/${id}/restore`, { ref })

export default {
    getVersions,
    getVersionAt,
    getDiff,
    tagVersion,
    restoreVersion
}
