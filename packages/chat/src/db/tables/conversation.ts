import { Generated } from 'kysely'

export const tableName = 'conversation'

export interface Conversation {
  id: string
  createdAt: Generated<string>
  lastMessageId: string | null
  lastMessageAt: string | null
  lastMessageSenderDid: string | null
  lastMessageText: string | null
  lastReactionMessageId: string | null
  lastReactionValue: string | null
  lastReactionSenderDid: string | null
  lastReactionAt: string | null
  rev: string
  updatedAt: Generated<string>
}

export type PartialDB = { [tableName]: Conversation }
