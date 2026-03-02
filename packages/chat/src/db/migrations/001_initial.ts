import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // conversations
  await db.schema
    .createTable('conversation')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('createdAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addColumn('lastMessageId', 'text')
    .addColumn('lastMessageAt', 'timestamptz')
    .addColumn('lastMessageSenderDid', 'text')
    .addColumn('lastMessageText', 'text')
    .addColumn('lastReactionMessageId', 'text')
    .addColumn('lastReactionValue', 'text')
    .addColumn('lastReactionSenderDid', 'text')
    .addColumn('lastReactionAt', 'timestamptz')
    .addColumn('rev', 'text', (col) => col.notNull())
    .addColumn('updatedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .execute()

  await db.schema
    .createIndex('idx_conversations_updated')
    .on('conversation')
    .expression(sql`"updatedAt" DESC`)
    .execute()

  // conversation_members
  await db.schema
    .createTable('conversation_member')
    .addColumn('convoId', 'text', (col) =>
      col.notNull().references('conversation.id').onDelete('cascade'),
    )
    .addColumn('memberDid', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('request')
        .check(sql`status IN ('request', 'accepted', 'left')`),
    )
    .addColumn('muted', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('unreadCount', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('lastReadRev', 'text')
    .addColumn('joinedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addColumn('acceptedAt', 'timestamptz')
    .addColumn('leftAt', 'timestamptz')
    .addPrimaryKeyConstraint('conversation_member_pkey', [
      'convoId',
      'memberDid',
    ])
    .execute()

  await db.schema
    .createIndex('idx_conv_members_did_status')
    .on('conversation_member')
    .columns(['memberDid', 'status'])
    .execute()

  // messages
  await db.schema
    .createTable('message')
    .addColumn('convoId', 'text', (col) => col.notNull())
    .addColumn('id', 'text', (col) => col.notNull())
    .addColumn('senderDid', 'text', (col) => col.notNull())
    .addColumn('text', 'text', (col) =>
      col.check(sql`LENGTH(text) <= 10000`),
    )
    .addColumn('facets', 'jsonb')
    .addColumn('embed', 'jsonb')
    .addColumn('rev', 'text', (col) => col.notNull())
    .addColumn('sentAt', 'timestamptz', (col) => col.notNull())
    .addColumn('deletedAt', 'timestamptz')
    .addPrimaryKeyConstraint('message_pkey', ['convoId', 'id'])
    .execute()

  await db.schema
    .createIndex('idx_messages_convo_sent')
    .on('message')
    .expression(sql`"convoId", "sentAt" DESC`)
    .execute()

  await db.schema
    .createIndex('idx_messages_convo_rev')
    .on('message')
    .expression(sql`"convoId", rev DESC`)
    .execute()

  // reactions
  await db.schema
    .createTable('reaction')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('convoId', 'text', (col) => col.notNull())
    .addColumn('messageId', 'text', (col) => col.notNull())
    .addColumn('senderDid', 'text', (col) => col.notNull())
    .addColumn('value', 'text', (col) =>
      col.notNull().check(sql`LENGTH(value) <= 64`),
    )
    .addColumn('createdAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addUniqueConstraint('reaction_unique_per_user', [
      'convoId',
      'messageId',
      'senderDid',
      'value',
    ])
    .execute()

  await db.schema
    .createIndex('idx_reactions_message')
    .on('reaction')
    .columns(['convoId', 'messageId'])
    .execute()

  // message_deletions
  await db.schema
    .createTable('message_deletion')
    .addColumn('messageId', 'text', (col) => col.notNull())
    .addColumn('userDid', 'text', (col) => col.notNull())
    .addColumn('deletedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addPrimaryKeyConstraint('message_deletion_pkey', ['messageId', 'userDid'])
    .execute()

  // user_events
  await db.schema
    .createTable('user_event')
    .addColumn('userDid', 'text', (col) => col.notNull())
    .addColumn('rev', 'text', (col) => col.notNull())
    .addColumn('convoId', 'text', (col) => col.notNull())
    .addColumn('eventType', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`"eventType" IN ('convo_begin', 'convo_accept', 'convo_leave', 'convo_mute', 'convo_unmute', 'message_create', 'message_delete', 'message_read', 'reaction_add', 'reaction_remove')`,
        ),
    )
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('createdAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addPrimaryKeyConstraint('user_event_pkey', ['userDid', 'rev'])
    .execute()

  await db.schema
    .createIndex('idx_user_events_created')
    .on('user_event')
    .column('createdAt')
    .execute()

  // user_last_rev
  await db.schema
    .createTable('user_last_rev')
    .addColumn('userDid', 'text', (col) => col.primaryKey())
    .addColumn('lastRev', 'text', (col) => col.notNull())
    .addColumn('updatedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .execute()

  // push_tokens
  await db.schema
    .createTable('push_token')
    .addColumn('userDid', 'text', (col) => col.notNull())
    .addColumn('deviceId', 'text', (col) => col.notNull())
    .addColumn('platform', 'text', (col) =>
      col
        .notNull()
        .check(sql`platform IN ('ios', 'android', 'web')`),
    )
    .addColumn('token', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addColumn('lastUsedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .addPrimaryKeyConstraint('push_token_pkey', ['userDid', 'deviceId'])
    .execute()

  // profiles
  await db.schema
    .createTable('profile')
    .addColumn('did', 'text', (col) => col.primaryKey())
    .addColumn('handle', 'text')
    .addColumn('displayName', 'text')
    .addColumn('avatar', 'text')
    .addColumn('chatDisabled', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('updatedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .execute()

  await sql`CREATE INDEX "idx_profiles_handle" ON "profile" ("handle") WHERE "handle" IS NOT NULL`.execute(
    db,
  )

  // actor_settings
  await db.schema
    .createTable('actor_setting')
    .addColumn('did', 'text', (col) => col.primaryKey())
    .addColumn('allowIncoming', 'text', (col) =>
      col
        .notNull()
        .defaultTo('following')
        .check(sql`"allowIncoming" IN ('all', 'following', 'none')`),
    )
    .addColumn('updatedAt', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`NOW()`),
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('actor_setting').execute()
  await db.schema.dropTable('profile').execute()
  await db.schema.dropTable('push_token').execute()
  await db.schema.dropTable('user_last_rev').execute()
  await db.schema.dropTable('user_event').execute()
  await db.schema.dropTable('message_deletion').execute()
  await db.schema.dropTable('reaction').execute()
  await db.schema.dropTable('message').execute()
  await db.schema.dropTable('conversation_member').execute()
  await db.schema.dropTable('conversation').execute()
}
