import { Generated } from 'kysely'

export const tableName = 'conversation_member'

export interface ConversationMember {
  convoId: string
  memberDid: string
  status: Generated<'request' | 'accepted' | 'left'>
  muted: Generated<boolean>
  unreadCount: Generated<number>
  lastReadRev: string | null
  joinedAt: Generated<string>
  acceptedAt: string | null
  leftAt: string | null
}

export type PartialDB = { [tableName]: ConversationMember }
