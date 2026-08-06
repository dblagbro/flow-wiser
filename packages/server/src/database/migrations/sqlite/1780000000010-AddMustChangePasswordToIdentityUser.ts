import { MigrationInterface, QueryRunner } from 'typeorm'
import { hasColumn } from '../../../utils/database.util'

/**
 * Forced password change (REQUIREMENTS-MIGRATION.md §6, §4).
 *
 * Additive and guarded, like 1780000000002: `identity_user` already exists on any deployment that
 * has run 1780000000000, and re-running this must be a no-op.
 *
 * DEFAULT 0 rather than 1: existing rows were not provisioned by the bootstrap and have not been
 * shown to anyone as a printed password, so flagging them would force a change nobody asked for.
 * The bootstrap sets the flag explicitly on the accounts it creates, and the §5 migration path sets
 * it explicitly on the accounts it carries across.
 */
export class AddMustChangePasswordToIdentityUser1780000000010 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, 'identity_user', 'mustChangePassword'))) {
            await queryRunner.query(`ALTER TABLE "identity_user" ADD COLUMN "mustChangePassword" boolean NOT NULL DEFAULT 0;`)
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "identity_user" DROP COLUMN "mustChangePassword";`)
    }
}
