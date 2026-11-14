#!/usr/bin/env node
/**
 * Report where this tree's dependencies differ from another line's.
 *
 * Why this exists
 * ---------------
 * The project keeps two long-lived lines, `main` and `apache2-only`. Automated dependency
 * updates only watch the default branch, so for three months every dependency fix landed on
 * `main` and none reached `apache2-only`: 39 security overrides, stricter versions for 21 more,
 * and newer direct dependencies. Nothing reported it, because the alert count describes the
 * default branch only. It was found by accident on 2026-11-14 (SEC-DEP-02, PROCESS-GAPS G14).
 *
 * The lines were then made identical: same dependency sections, same `pnpm.overrides`, same
 * lockfile. This script says whether that is still true.
 *
 * It is a report, not yet a gate. Run on every pull request it would fail each time one line
 * moves first, which is the normal way a change travels. Where it belongs — a scheduled run, or
 * a check on release — is a decision for the maintainer.
 *
 * Usage:  node scripts/report-dependency-drift.js [other-ref]     (default: origin/main)
 * Exit:   0 no drift · 1 drift (prints every difference) · 2 the other ref could not be read
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const other = process.argv[2] || 'origin/main'
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const here = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
const there = (file) => git(['show', `${other}:${file}`])

// A ref that cannot be read is not "no drift" and not "everything differs" — it is no answer.
try {
    git(['rev-parse', '--verify', '--quiet', `${other}^{commit}`])
} catch {
    console.error(`✗ could not read ${other}: not a commit this repository has. Fetch it first.`)
    process.exit(2)
}

const manifests = ['package.json'].concat(
    fs
        .readdirSync(path.join(root, 'packages'))
        .map((name) => `packages/${name}/package.json`)
        .filter((file) => fs.existsSync(path.join(root, file)))
)

const differences = []
const compareMaps = (label, mine = {}, theirs = {}) => {
    for (const name of [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort()) {
        if (mine[name] === theirs[name]) continue
        differences.push(`${label}: ${name} is ${mine[name] ?? '(absent)'} here, ${theirs[name] ?? '(absent)'} on ${other}`)
    }
}

try {
    for (const file of manifests) {
        const mine = JSON.parse(here(file))
        let theirs
        try {
            theirs = JSON.parse(there(file))
        } catch {
            differences.push(`${file}: exists here and not on ${other}`)
            continue
        }
        for (const section of SECTIONS) compareMaps(`${file} ${section}`, mine[section], theirs[section])
        if (file === 'package.json') compareMaps('pnpm.overrides', mine.pnpm?.overrides, theirs.pnpm?.overrides)
    }
    const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)
    const mine = digest(here('pnpm-lock.yaml'))
    const theirs = digest(there('pnpm-lock.yaml'))
    if (mine !== theirs) differences.push(`pnpm-lock.yaml: ${mine} here, ${theirs} on ${other}`)
} catch (error) {
    console.error(`✗ could not read ${other}: ${error.message.split('\n')[0]}`)
    process.exit(2)
}

if (differences.length > 0) {
    console.error(`✗ dependencies differ from ${other} in ${differences.length} place(s):`)
    for (const line of differences) console.error(`  ${line}`)
    process.exit(1)
}
// eslint-disable-next-line no-console
console.log(`✓ dependency sections, pnpm.overrides and pnpm-lock.yaml are identical to ${other}`)
