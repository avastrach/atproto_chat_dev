export const tableName = 'message'

export interface Message {
  convoId: string
  id: string
  senderDid: string
  text: string | null
  facets: string | null // JSONB stored as string
  embed: string | null // JSONB stored as string
  rev: string
  sentAt: string
  deletedAt: string | null
}

export type PartialDB = { [tableName]: Message }
