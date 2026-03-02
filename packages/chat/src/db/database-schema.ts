import { Kysely } from 'kysely'
import * as actorSetting from './tables/actor-setting'
import * as conversation from './tables/conversation'
import * as conversationMember from './tables/conversation-member'
import * as message from './tables/message'
import * as messageDeletion from './tables/message-deletion'
import * as profile from './tables/profile'
import * as pushToken from './tables/push-token'
import * as reaction from './tables/reaction'
import * as userEvent from './tables/user-event'
import * as userLastRev from './tables/user-last-rev'

export type DatabaseSchemaType = conversation.PartialDB &
  conversationMember.PartialDB &
  message.PartialDB &
  reaction.PartialDB &
  messageDeletion.PartialDB &
  userEvent.PartialDB &
  userLastRev.PartialDB &
  pushToken.PartialDB &
  profile.PartialDB &
  actorSetting.PartialDB

export type DatabaseSchema = Kysely<DatabaseSchemaType>
