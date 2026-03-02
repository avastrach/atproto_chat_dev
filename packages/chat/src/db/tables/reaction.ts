import { Generated } from 'kysely'

export const tableName = 'reaction'

export interface Reaction {
  id: string
  convoId: string
  messageId: string
  senderDid: string
  value: string
  createdAt: Generated<string>
}

export type PartialDB = { [tableName]: Reaction }
