/* eslint-disable */
import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryGeneratedColumn } from 'typeorm'
import { ChatflowType, IChatFlow } from '../../Interface'

export enum EnumChatflowType {
    CHATFLOW = 'CHATFLOW',
    AGENTFLOW = 'AGENTFLOW',
    MULTIAGENT = 'MULTIAGENT',
    ASSISTANT = 'ASSISTANT'
}

@Entity()
export class ChatFlow implements IChatFlow {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column()
    name: string

    /**
     * The flow definition, as a JSON string.
     *
     * The transformer exists because SQLite storage classes are per-VALUE, not per-column: a row
     * whose `flowData` was ever written as bytes is stored with storage class BLOB even though the
     * column is declared `text`, and the driver then hands back a Buffer. That Buffer serialises to
     * `{"type":"Buffer","data":[...]}` — an object — and every consumer does `JSON.parse(flowData)`,
     * which fails with `"[object Object]" is not valid JSON` and takes the whole canvas down.
     *
     * Found on a live instance: 24 of 25 rows were `text` and one was `blob`, so the canvas for that
     * single flow was unopenable while every other flow was fine. Declaring the column `text` does
     * not prevent it, and no migration can guarantee it never recurs — an import or a raw INSERT
     * binding a Buffer reintroduces it silently.
     *
     * Normalising on read is the only place that covers every path (find, findOne, query builder,
     * relations) and every future writer.
     */
    @Column({
        type: 'text',
        transformer: {
            to: (value: string) => value,
            from: (value: unknown) => (Buffer.isBuffer(value) ? value.toString('utf8') : (value as string))
        }
    })
    flowData: string

    @Column({ nullable: true })
    deployed?: boolean

    @Column({ nullable: true })
    isPublic?: boolean

    @Column({ nullable: true })
    apikeyid?: string

    @Column({ nullable: true, type: 'text' })
    chatbotConfig?: string

    @Column({ nullable: true, type: 'text' })
    apiConfig?: string

    @Column({ nullable: true, type: 'text' })
    analytic?: string

    @Column({ nullable: true, type: 'text' })
    speechToText?: string

    @Column({ nullable: true, type: 'text' })
    textToSpeech?: string

    @Column({ nullable: true, type: 'text' })
    followUpPrompts?: string

    @Column({ nullable: true, type: 'text' })
    category?: string

    @Column({ type: 'varchar', length: 20, default: EnumChatflowType.CHATFLOW })
    type?: ChatflowType

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date

    @Column({ nullable: true, type: 'text' })
    mcpServerConfig?: string

    @Column({ nullable: true, type: 'text', select: false })
    webhookSecret?: string | null

    @Column({ nullable: true, default: false })
    webhookSecretConfigured?: boolean

    @Column({ nullable: false, type: 'text' })
    workspaceId: string
}
