import { Generated } from 'kysely'

export const tableName = 'profile'

export interface Profile {
  did: string
  handle: string | null
  displayName: string | null
  avatar: string | null
  chatDisabled: Generated<boolean>
  updatedAt: Generated<string>
}

export type PartialDB = { [tableName]: Profile }
