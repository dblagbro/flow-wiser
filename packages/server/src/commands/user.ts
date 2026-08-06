import { Args } from '@oclif/core'
import { QueryRunner } from 'typeorm'
import * as DataSource from '../DataSource'
import { User } from '../database/entities/identity'
import { hash as hashPassword, validatePasswordOrThrow } from '../identity/crypto/passwords'
import logger from '../utils/logger'
import { BaseCommand } from './base'

export default class user extends BaseCommand {
    static args = {
        email: Args.string({
            description: 'Email address to search for in the user database'
        }),
        password: Args.string({
            description: 'New password for that user'
        })
    }

    async run(): Promise<void> {
        const { args } = await this.parse(user)

        let queryRunner: QueryRunner | undefined
        try {
            logger.info('Initializing DataSource')
            const dataSource = await DataSource.getDataSource()
            await dataSource.initialize()

            queryRunner = dataSource.createQueryRunner()
            await queryRunner.connect()

            if (args.email && args.password) {
                logger.info('Running resetPassword')
                await this.resetPassword(queryRunner, args.email, args.password)
            } else {
                logger.info('Running listUserEmails')
                await this.listUserEmails(queryRunner)
            }
        } catch (error) {
            logger.error(error)
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
            await this.gracefullyExit()
        }
    }

    async listUserEmails(queryRunner: QueryRunner) {
        logger.info('Listing all user emails')
        const users = await queryRunner.manager.find(User, {
            select: ['email']
        })

        const emails = users.map((user) => user.email)
        logger.info(`Email addresses: ${emails.join(', ')}`)
        logger.info(`Email count: ${emails.length}`)
        logger.info('To reset user password, run the following command: pnpm user --email "myEmail" --password "myPassword"')
    }

    async resetPassword(queryRunner: QueryRunner, email: string, password: string) {
        logger.info(`Finding user by email: ${email}`)
        const user = await queryRunner.manager.findOne(User, {
            where: { email }
        })
        if (!user) throw new Error(`User not found with email: ${email}`)

        // Rejects before the write, so a bad password never opens a transaction. Throws
        // PasswordPolicyError, which run()'s catch logs.
        validatePasswordOrThrow(password)

        // `getHash` in the outgoing tree was synchronous. The Apache-2.0 replacement is bcrypt at
        // cost 12 (identity/crypto/passwords.ts), which is deliberately expensive and therefore
        // async -- hashing on the event loop for ~250ms is not something to hide behind a
        // synchronous signature. The one call site is already inside an async method.
        user.credential = await hashPassword(password)
        await queryRunner.manager.save(user)
        logger.info(`Password reset for user: ${email}`)
    }
}
