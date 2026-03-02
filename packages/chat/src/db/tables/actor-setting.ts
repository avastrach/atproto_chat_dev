import { Generated } from 'kysely'

export const tableName = 'actor_setting'

export interface ActorSetting {
  did: string
  allowIncoming: Generated<'all' | 'following' | 'none'>
  updatedAt: Generated<string>
}

export type PartialDB = { [tableName]: ActorSetting }
