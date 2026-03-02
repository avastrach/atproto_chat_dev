import { Generated } from 'kysely'

export const tableName = 'push_token'

export interface PushToken {
  userDid: string
  deviceId: string
  platform: 'ios' | 'android' | 'web'
  token: string
  createdAt: Generated<string>
  lastUsedAt: Generated<string>
}

export type PartialDB = { [tableName]: PushToken }
