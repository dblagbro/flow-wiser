#!/usr/bin/env node
/**
 * Assert that every declaration of the Node version agrees, and that the three
 * secret-ignore lists stay in step.
 *
 * Why this exists
 * ---------------
 * ADR-0004 was written because ten locations carried five different Node versions
 * (`20`, `20.20.2`, `22`, `24`, `24.15.0`), including a `.nvmrc` and an `engines.node`
 * asking for a version the project's own notes recorded as unbuildable. One of them —
 * `docker/worker/Dockerfile` — hardcoded a version with no build arg, so CI could not
 * override it and that image could not build at all.
 *
 * Those ten were aligned by hand. Nothing stopped them diverging again, and per
 * ADR-0003 aligning values is not a control: a control is something that fails when
 * the property stops holding. This is that control. See RM-11.
 *
 * The second half, the ignore lists, comes from RM-16: `pnpm lint` globbed `**\/*.json`,
 * matched a production credential export, and ESLint opened it — stopped only by a
 * root-owned 0600 file mode. `.gitignore` protects git and nothing else. Every tool that
 * walks the tree needs its own exclusion, and three separate lists now have to agree.
 * Nothing enforced that either.
 *
 * Usage:  node scripts/assert-version-parity.js
 * Exit:   0 all parity holds · 1 a mismatch (prints every one, not just the first)
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

const failures = []
const fail = (msg) => failures.push(msg)

/** Reduce any Node version spelling — `v22.23.2`, `^22`, `22.23.2`, `22` — to its major. */
function major(spec, where) {
    const m = String(spec).match(/(\d+)/)
    if (!m) {
        fail(`${where}: could not parse a Node version from ${JSON.stringify(spec)}`)
        return null
    }
    return m[1]
}

// ---------------------------------------------------------------------------
// 1. Node version parity
// ---------------------------------------------------------------------------

const nodeDeclarations = []
const declare = (where, spec) => {
    const maj = major(spec, where)
    if (maj) nodeDeclarations.push({ where, spec: String(spec).trim(), major: maj })
}

declare('.nvmrc', read('.nvmrc').trim())
declare('package.json → engines.node', JSON.parse(read('package.json')).engines.node)
declare('packages/server/package.json → engines.node', JSON.parse(read('packages/server/package.json')).engines.node)

for (const df of ['Dockerfile', 'docker/Dockerfile', 'docker/worker/Dockerfile']) {
    const m = read(df).match(/^ARG NODE_VERSION=(.+)$/m)
    if (!m) {
        // A hardcoded FROM with no build arg is the exact defect ADR-0004 found in
        // docker/worker/Dockerfile: CI cannot override it, so it silently diverges.
        fail(`${df}: no \`ARG NODE_VERSION=\` — the version cannot be overridden from CI`)
        continue
    }
    declare(`${df} → ARG NODE_VERSION`, m[1])
}

const mainYml = read('.github/workflows/main.yml')
const matrix = mainYml.match(/node-version:\s*\[([^\]]+)\]/)
if (matrix) declare('.github/workflows/main.yml → matrix', matrix[1])
else fail('.github/workflows/main.yml: no `node-version: [...]` matrix found')

for (const m of read('.github/workflows/publish-package.yml').matchAll(/node-version:\s*'([^']+)'/g)) {
    declare('.github/workflows/publish-package.yml → node-version', m[1])
}

for (const wf of ['docker-image-dockerhub.yml', 'docker-image-ecr.yml']) {
    const m = read(`.github/workflows/${wf}`).match(/node_version\s*\|\|\s*'(\d+)'/)
    if (m) declare(`.github/workflows/${wf} → default`, m[1])
    else fail(`.github/workflows/${wf}: no \`node_version || '<n>'\` default found`)
}

const majors = [...new Set(nodeDeclarations.map((d) => d.major))]
if (majors.length > 1) {
    fail(`Node major version disagrees across ${nodeDeclarations.length} declarations: ${majors.join(', ')}`)
    for (const d of nodeDeclarations) fail(`    ${d.major}  ←  ${d.where} (${d.spec})`)
}

// Where a full version is pinned, the pins must be identical — not merely the same major.
// A CI matrix on 22.1.0 while .nvmrc says 22.23.2 tests something nobody develops on.
const pinned = nodeDeclarations.filter((d) => /^v?\d+\.\d+\.\d+$/.test(d.spec))
const pinnedVersions = [...new Set(pinned.map((d) => d.spec.replace(/^v/, '')))]
if (pinnedVersions.length > 1) {
    fail(`Fully-pinned Node versions disagree: ${pinnedVersions.join(', ')}`)
    for (const d of pinned) fail(`    ${d.spec}  ←  ${d.where}`)
}

// ---------------------------------------------------------------------------
// 2. Secret-ignore parity (RM-16)
// ---------------------------------------------------------------------------

// Patterns that must be excluded from git AND from every tool that walks the tree.
// Spelling differs per tool, so match on a distinctive substring rather than a literal.
const SECRET_MARKERS = ['credentials-backup', 'sqlite', 'pem', 'key']

const lists = {
    '.gitignore': exists('.gitignore') ? read('.gitignore') : null,
    '.prettierignore': exists('.prettierignore') ? read('.prettierignore') : null,
    '.eslintrc.js (ignorePatterns)': exists('.eslintrc.js') ? read('.eslintrc.js') : null
}

for (const [name, body] of Object.entries(lists)) {
    if (body === null) {
        fail(`${name}: missing — secret patterns cannot be enforced for that tool`)
        continue
    }
    for (const marker of SECRET_MARKERS) {
        if (!body.includes(marker)) {
            fail(`${name}: no pattern mentioning "${marker}" — see RM-16, all three lists must agree`)
        }
    }
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error('\n✗ Parity check FAILED\n')
    for (const f of failures) console.error(`  ${f}`)
    console.error('\n  Node version is declared in every location listed above and they must move')
    console.error('  together. See docs/decisions/ADR-0004-node-version-conflict.md and RM-11.\n')
    process.exit(1)
}

console.info(`✓ Node version parity: ${nodeDeclarations.length} declarations, all major ${majors[0]}`)
if (pinnedVersions.length === 1) console.info(`✓ Pinned versions agree: ${pinnedVersions[0]}`)
console.info(`✓ Secret-ignore parity: ${Object.keys(lists).length} lists carry all ${SECRET_MARKERS.length} markers`)
