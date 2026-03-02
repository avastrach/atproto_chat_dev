import { sql } from 'kysely'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { Database } from '../db'
import {
  DeletedMessageView,
  MessageRow,
  MessageView,
  ViewBuilder,
} from '../views'

export interface ActorMetadataPeriod {
  messagesSent: number
  messagesReceived: number
  convos: number
  convosStarted: number
}

export interface ActorMetadata {
  day: ActorMetadataPeriod
  month: ActorMetadataPeriod
  all: ActorMetadataPeriod
}

export class ModerationService {
  constructor(
    private db: Database,
    private viewBuilder: ViewBuilder,
  ) {}

  /**
   * Get chat activity metadata for an actor, aggregated by time period.
   *
   * Returns counts of messages sent, messages received, conversations
   * participated in, and conversations started, for the last 24 hours,
   * last 30 days, and all time.
   */
  async getActorMetadata(actorDid: string): Promise<ActorMetadata> {
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const monthAgo = new Date(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString()

    // Messages sent by actor, aggregated by time period
    const sentResult = await sql<{
      allTime: number
      day: number
      month: number
    }>`
      SELECT
        COUNT(*) AS "allTime",
        COUNT(CASE WHEN "sentAt" >= ${dayAgo} THEN 1 END) AS "day",
        COUNT(CASE WHEN "sentAt" >= ${monthAgo} THEN 1 END) AS "month"
      FROM "message"
      WHERE "senderDid" = ${actorDid}
    `.execute(this.db.db)

    const sent = sentResult.rows[0] ?? { allTime: 0, day: 0, month: 0 }

    // Messages received by actor (messages in conversations where actor
    // is a member, sent by other users)
    const receivedResult = await sql<{
      allTime: number
      day: number
      month: number
    }>`
      SELECT
        COUNT(*) AS "allTime",
        COUNT(CASE WHEN m."sentAt" >= ${dayAgo} THEN 1 END) AS "day",
        COUNT(CASE WHEN m."sentAt" >= ${monthAgo} THEN 1 END) AS "month"
      FROM "message" m
      INNER JOIN "conversation_member" cm
        ON cm."convoId" = m."convoId"
        AND cm."memberDid" = ${actorDid}
      WHERE m."senderDid" != ${actorDid}
    `.execute(this.db.db)

    const received = receivedResult.rows[0] ?? {
      allTime: 0,
      day: 0,
      month: 0,
    }

    // Conversations the actor is a member of
    const convosResult = await sql<{
      allTime: number
      day: number
      month: number
    }>`
      SELECT
        COUNT(*) AS "allTime",
        COUNT(CASE WHEN c."createdAt" >= ${dayAgo} THEN 1 END) AS "day",
        COUNT(CASE WHEN c."createdAt" >= ${monthAgo} THEN 1 END) AS "month"
      FROM "conversation_member" cm
      INNER JOIN "conversation" c ON c."id" = cm."convoId"
      WHERE cm."memberDid" = ${actorDid}
    `.execute(this.db.db)

    const convos = convosResult.rows[0] ?? { allTime: 0, day: 0, month: 0 }

    // Conversations started by actor: conversations where the first
    // message was sent by this actor
    const convosStartedResult = await sql<{
      allTime: number
      day: number
      month: number
    }>`
      SELECT
        COUNT(*) AS "allTime",
        COUNT(CASE WHEN c."createdAt" >= ${dayAgo} THEN 1 END) AS "day",
        COUNT(CASE WHEN c."createdAt" >= ${monthAgo} THEN 1 END) AS "month"
      FROM "conversation_member" cm
      INNER JOIN "conversation" c ON c."id" = cm."convoId"
      WHERE cm."memberDid" = ${actorDid}
        AND (
          SELECT m."senderDid"
          FROM "message" m
          WHERE m."convoId" = c."id"
          ORDER BY m."sentAt" ASC
          LIMIT 1
        ) = ${actorDid}
    `.execute(this.db.db)

    const convosStarted = convosStartedResult.rows[0] ?? {
      allTime: 0,
      day: 0,
      month: 0,
    }

    return {
      day: {
        messagesSent: Number(sent.day) || 0,
        messagesReceived: Number(received.day) || 0,
        convos: Number(convos.day) || 0,
        convosStarted: Number(convosStarted.day) || 0,
      },
      month: {
        messagesSent: Number(sent.month) || 0,
        messagesReceived: Number(received.month) || 0,
        convos: Number(convos.month) || 0,
        convosStarted: Number(convosStarted.month) || 0,
      },
      all: {
        messagesSent: Number(sent.allTime) || 0,
        messagesReceived: Number(received.allTime) || 0,
        convos: Number(convos.allTime) || 0,
        convosStarted: Number(convosStarted.allTime) || 0,
      },
    }
  }

  /**
   * Get messages surrounding a specific message for moderation context.
   *
   * Does NOT apply per-user deletion filtering -- moderators see all messages
   * including those that individual users may have deleted for themselves.
   *
   * If convoId is not provided, it is looked up from the message itself.
   */
  async getMessageContext(
    messageId: string,
    convoId?: string,
    before = 5,
    after = 5,
  ): Promise<{ messages: (MessageView | DeletedMessageView)[] }> {
    // If convoId not supplied, look it up from the message
    let resolvedConvoId = convoId
    if (!resolvedConvoId) {
      const msg = await this.db.db
        .selectFrom('message')
        .where('id', '=', messageId)
        .select('convoId')
        .executeTakeFirst()

      if (!msg) {
        throw new InvalidRequestError('Message not found')
      }
      resolvedConvoId = msg.convoId
    }

    // Find the target message to establish ordering position
    const targetMessage = await this.db.db
      .selectFrom('message')
      .where('id', '=', messageId)
      .where('convoId', '=', resolvedConvoId)
      .selectAll()
      .executeTakeFirst()

    if (!targetMessage) {
      throw new InvalidRequestError('Message not found')
    }

    // Get messages before the target (older messages, ordered descending then reversed)
    const beforeMessages =
      before > 0
        ? await this.db.db
            .selectFrom('message')
            .where('convoId', '=', resolvedConvoId)
            .where('id', '<', messageId)
            .orderBy('id', 'desc')
            .limit(before)
            .select([
              'id',
              'convoId',
              'senderDid',
              'text',
              'facets',
              'embed',
              'rev',
              'sentAt',
              'deletedAt',
            ])
            .execute()
        : []

    // Get messages after the target (newer messages)
    const afterMessages =
      after > 0
        ? await this.db.db
            .selectFrom('message')
            .where('convoId', '=', resolvedConvoId)
            .where('id', '>', messageId)
            .orderBy('id', 'asc')
            .limit(after)
            .select([
              'id',
              'convoId',
              'senderDid',
              'text',
              'facets',
              'embed',
              'rev',
              'sentAt',
              'deletedAt',
            ])
            .execute()
        : []

    // Combine: before (reversed to chronological order) + target + after
    const allRows = [
      ...beforeMessages.reverse(),
      targetMessage,
      ...afterMessages,
    ]

    // Build views -- moderator sees all, including soft-deleted messages
    const messages: (MessageView | DeletedMessageView)[] = allRows.map(
      (row) => {
        if (row.deletedAt) {
          return this.viewBuilder.buildDeletedMessageView(row as MessageRow)
        }
        return this.viewBuilder.buildMessageView(row as MessageRow)
      },
    )

    return { messages }
  }

  /**
   * Update chat access for an actor.
   *
   * Sets or clears the chatDisabled flag on the actor's profile.
   * Upserts the profile record if it does not exist.
   */
  async updateActorAccess(
    actorDid: string,
    allowAccess: boolean,
    _ref?: string,
  ): Promise<void> {
    const chatDisabled = !allowAccess

    // Upsert profile: if the profile exists, update chatDisabled.
    // If it does not exist, create a minimal profile with the flag set.
    await this.db.db
      .insertInto('profile')
      .values({
        did: actorDid,
        handle: null,
        displayName: null,
        avatar: null,
        chatDisabled,
      })
      .onConflict((oc) =>
        oc.column('did').doUpdateSet({
          chatDisabled,
          updatedAt: new Date().toISOString(),
        }),
      )
      .execute()
  }
}
