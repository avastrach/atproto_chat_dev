import { Generated } from 'kysely'

export const tableName = 'user_last_rev'

export interface UserLastRev {
  userDid: string
  lastRev: string
  updatedAt: Generated<string>
}

export type PartialDB = { [tableName]: UserLastRev }
