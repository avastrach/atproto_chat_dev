import { Generated } from 'kysely'

export const tableName = 'message_deletion'

export interface MessageDeletion {
  messageId: string
  userDid: string
  deletedAt: Generated<string>
}

export type PartialDB = { [tableName]: MessageDeletion }
