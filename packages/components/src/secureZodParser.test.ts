import { SecureZodSchemaParser } from './secureZodParser'

/**
 * Regression tests for upstream FlowiseAI/Flowise#6672 by Osamaali313, adopted here.
 *
 * `parseZodSchema` builds a Zod schema from a string supplied in a tool definition. The `min` and
 * `max` modifiers were applied to `ZodString` and `ZodArray` but not to `ZodNumber` — while `int`
 * immediately above them did handle it. A schema declaring `z.number().min(1).max(10)` therefore
 * produced a plain `z.number()`: the bounds were parsed, accepted, and silently discarded.
 *
 * That fails open. A tool advertising a bounded numeric argument would accept any number an LLM
 * produced — negative, zero, or arbitrarily large — with no error and nothing in a log to show the
 * constraint had been dropped. The schema still *looked* correct everywhere it was displayed.
 *
 * These tests fail against the pre-#6672 parser and pass after it. `AGENTS.md §6` requires a fix to
 * ship the test that distinguishes those two states; the adoption did not carry one, so it is added
 * here rather than left to the next reader to discover the gap the same way.
 */
describe('SecureZodSchemaParser — numeric min/max are enforced (#6672)', () => {
    describe('max on a number', () => {
        it('rejects a value above the maximum', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().max(10) })')
            expect(schema.safeParse({ qty: 11 }).success).toBe(false)
        })

        it('accepts a value at and below the maximum', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().max(10) })')
            expect(schema.safeParse({ qty: 10 }).success).toBe(true)
            expect(schema.safeParse({ qty: 3 }).success).toBe(true)
        })
    })

    describe('min on a number', () => {
        it('rejects a value below the minimum', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().min(5) })')
            expect(schema.safeParse({ qty: 4 }).success).toBe(false)
        })

        it('rejects a negative value where a positive minimum is declared', () => {
            // The case that motivates the fix: an unbounded number reaching business logic that
            // assumed the declared floor held.
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().min(1) })')
            expect(schema.safeParse({ qty: -100 }).success).toBe(false)
        })

        it('accepts a value at and above the minimum', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().min(5) })')
            expect(schema.safeParse({ qty: 5 }).success).toBe(true)
            expect(schema.safeParse({ qty: 50 }).success).toBe(true)
        })
    })

    describe('min and max together', () => {
        it('enforces both ends of the range', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().min(1).max(10) })')
            expect(schema.safeParse({ qty: 0 }).success).toBe(false)
            expect(schema.safeParse({ qty: 11 }).success).toBe(false)
            expect(schema.safeParse({ qty: 1 }).success).toBe(true)
            expect(schema.safeParse({ qty: 10 }).success).toBe(true)
        })

        it('composes with int, which was already handled', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ qty: z.number().int().min(1).max(10) })')
            expect(schema.safeParse({ qty: 5.5 }).success).toBe(false)
            expect(schema.safeParse({ qty: 5 }).success).toBe(true)
        })
    })

    describe('the string and array cases that already worked keep working', () => {
        it('still bounds a string', () => {
            const schema = SecureZodSchemaParser.parseZodSchema('z.object({ name: z.string().min(2).max(4) })')
            expect(schema.safeParse({ name: 'a' }).success).toBe(false)
            expect(schema.safeParse({ name: 'abcde' }).success).toBe(false)
            expect(schema.safeParse({ name: 'abc' }).success).toBe(true)
        })
    })
})
