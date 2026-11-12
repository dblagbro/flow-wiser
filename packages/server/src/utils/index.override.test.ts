import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import ts from 'typescript'

// Compile the actual self-contained helper, avoiding unrelated server startup
// imports. No second implementation, live graph or external service is used.
const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const statement = parsed.statements.find(
    (item) =>
        ts.isVariableStatement(item) &&
        item.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'replaceInputsWithConfig')
)
if (!statement) throw new Error('Cannot find the production override helper')
const compiled = ts.transpileModule(statement.getText(parsed), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const sandbox = { exports: {} as Record<string, any> }
runInNewContext(compiled, sandbox, { timeout: 1000 })
const replaceInputsWithConfig = sandbox.exports.replaceInputsWithConfig

const node = (inputs: Record<string, unknown> = { settings: { endpoint: 'https://trusted.invalid', keep: true } }) => ({
    id: 'example_0',
    name: 'example',
    label: 'Example',
    inputs
})
const allow = (enabled: boolean, name = 'settings') => ({ Example: [{ name, enabled }] })

describe('replaceInputsWithConfig parameter authorization', () => {
    it.each([
        ['unscoped object', { endpoint: 'https://untrusted.invalid' }],
        ['current-node object', { example_0: { endpoint: 'https://untrusted.invalid' } }],
        ['other-node object', { example_1: { endpoint: 'https://untrusted.invalid' } }],
        ['array', ['replacement']],
        ['string', 'replacement'],
        ['file marker string', 'FILE-STORAGE::synthetic'],
        ['number', 42],
        ['boolean', true],
        ['null', null]
    ])('does not change a disabled parameter using %s', (_label, value) => {
        const original = node()
        expect(replaceInputsWithConfig(original, { settings: value }, allow(false), []).inputs).toEqual(node().inputs)
    })

    it('does not accept an unlisted object parameter', () => {
        expect(replaceInputsWithConfig(node(), { settings: { changed: true } }, {}, []).inputs).toEqual(node().inputs)
    })

    it('does not inherit permission from another parameter', () => {
        expect(replaceInputsWithConfig(node(), { settings: { changed: true } }, allow(true, 'temperature'), []).inputs).toEqual(
            node().inputs
        )
    })

    it('does not inherit permission from another node label', () => {
        expect(
            replaceInputsWithConfig(node(), { settings: { changed: true } }, { Other: [{ name: 'settings', enabled: true }] }, []).inputs
        ).toEqual(node().inputs)
    })

    it('merges an explicitly enabled unscoped object', () => {
        const result = replaceInputsWithConfig(node(), { settings: { endpoint: 'https://allowed.invalid' } }, allow(true), [])
        expect(result.inputs.settings).toEqual({ endpoint: 'https://allowed.invalid', keep: true })
    })

    it('merges an enabled object into an existing JSON string', () => {
        const result = replaceInputsWithConfig(node({ settings: '{"keep":true}' }), { settings: { changed: true } }, allow(true), [])
        expect(result.inputs.settings).toEqual({ keep: true, changed: true })
    })

    it('applies an enabled node-specific object only to its node', () => {
        const value = { settings: { example_0: { changed: true } } }
        expect(replaceInputsWithConfig(node(), value, allow(true), []).inputs.settings).toEqual({
            endpoint: 'https://trusted.invalid',
            keep: true,
            changed: true
        })
        const other = { ...node(), id: 'example_1' }
        expect(replaceInputsWithConfig(other, value, allow(true), []).inputs).toEqual(node().inputs)
    })

    it('retains enabled array de-duplication', () => {
        expect(replaceInputsWithConfig(node({ settings: ['a'] }), { settings: ['a', 'b'] }, allow(true), []).inputs.settings).toEqual([
            'a',
            'b'
        ])
    })

    it('retains enabled scalar and boolean conversion', () => {
        expect(replaceInputsWithConfig(node(), { settings: 'false' }, allow(true), []).inputs.settings).toBe(false)
    })

    it('continues filtering variable overrides through their separate allowlist', () => {
        const result = replaceInputsWithConfig(node(), { vars: { allowed: 'yes', forbidden: 'no' } }, {}, [
            { name: 'allowed', enabled: true }
        ])
        expect(result.inputs.vars).toEqual({ allowed: 'yes' })
    })

    it('preserves the explicitly separate analytics behavior', () => {
        const result = replaceInputsWithConfig(node(), { analytics: { synthetic: true } }, {}, [])
        expect(result.inputs.analytics).toEqual({ synthetic: true })
    })
})
