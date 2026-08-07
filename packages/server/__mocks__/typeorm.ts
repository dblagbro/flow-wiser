/**
 * Manual mock for 'typeorm'.
 * All decorator factories are replaced with no-ops so TypeORM entity classes
 * can be defined in tests without a real database connection.
 * Used by all server-package test files via jest.mock('typeorm').
 */

const decorator = (): (() => void) => () => {}

// Lightweight FindOperator-like factories. Real TypeORM returns instances of
// FindOperator with `type` and `value` fields; tests only assert on these,
// so a plain object with the same shape is sufficient.
const findOperator = (type: string) => (value: unknown, secondValue?: unknown) => ({
    type,
    value: secondValue === undefined ? value : [value, secondValue]
})

module.exports = {
    Column: decorator,
    Entity: decorator,
    PrimaryGeneratedColumn: decorator,
    PrimaryColumn: decorator,
    CreateDateColumn: decorator,
    UpdateDateColumn: decorator,
    Index: decorator,
    ManyToOne: decorator,
    OneToMany: decorator,
    OneToOne: decorator,
    JoinColumn: decorator,
    Unique: decorator,
    // Added 2026-08-07. `LoginActivity` is a database VIEW (it projects the audit trail through
    // the legacy sign-in shape), so it uses @ViewEntity/@ViewColumn. Their absence here did not
    // fail loudly — it made every suite that transitively imports `entities/identity/index.ts`
    // fail to LOAD, so `recovery-cli.test.ts` and its 30 tests silently never ran while the
    // summary line still read "844 passed". A mock missing an export is indistinguishable from a
    // passing suite unless you read the suite count.
    ViewEntity: decorator,
    ViewColumn: decorator,
    DataSource: jest.fn(),
    In: findOperator('in'),
    Between: findOperator('between'),
    MoreThanOrEqual: findOperator('moreThanOrEqual'),
    LessThanOrEqual: findOperator('lessThanOrEqual')
}
