import { Kysely, Migration, MigrationProvider } from 'kysely'

export class ChatMigrationProvider implements MigrationProvider {
  constructor(
    private migrations: Record<string, ChatMigration>,
  ) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const result: Record<string, Migration> = {}
    Object.entries(this.migrations).forEach(([name, migration]) => {
      result[name] = {
        up: async (db) => await migration.up(db),
        down: async (db) => await migration.down?.(db),
      }
    })
    return result
  }
}

export interface ChatMigration {
  up(db: Kysely<unknown>): Promise<void>
  down?(db: Kysely<unknown>): Promise<void>
}
