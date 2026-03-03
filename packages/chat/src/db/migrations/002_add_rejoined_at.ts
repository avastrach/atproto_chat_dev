import { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('conversation_member')
    .addColumn('rejoinedAt', 'timestamptz')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('conversation_member')
    .dropColumn('rejoinedAt')
    .execute()
}
