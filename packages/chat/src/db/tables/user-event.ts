import { Generated } from 'kysely'

export const tableName = 'user_event'

export type UserEventType =
  | 'convo_begin'
  | 'convo_accept'
  | 'convo_leave'
  | 'convo_mute'
  | 'convo_unmute'
  | 'message_create'
  | 'message_delete'
  | 'message_read'
  | 'reaction_add'
  | 'reaction_remove'

export interface UserEvent {
  userDid: string
  rev: string
  convoId: string
  eventType: UserEventType
  payload: string // JSONB stored as string
  createdAt: Generated<string>
}

export type PartialDB = { [tableName]: UserEvent }
