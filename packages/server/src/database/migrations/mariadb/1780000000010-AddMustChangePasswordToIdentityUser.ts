import { MigrationInterface, QueryRunner } from 'typeorm'
import { hasColumn } from '../../../utils/database.util'

/**
 * Forced password change (REQUIREMENTS-MIGRATION.md §6, §4). See the sqlite copy for the rationale
 * behind the `0` default; only the DDL dialect differs here.
 */
export class AddMustChangePasswordToIdentityUser1780000000010 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await hasColumn(queryRunner, 'identity_user', 'mustChangePassword'))) {
            await queryRunner.query(`ALTER TABLE \`identity_user\` ADD COLUMN \`mustChangePassword\` tinyint(1) NOT NULL DEFAULT 0;`)
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`identity_user\` DROP COLUMN \`mustChangePassword\`;`)
    }
}
