import { TID } from '@atproto/common-web'
import { sql } from 'kysely'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { Database } from '../db'
import { EventLogService } from './event-log'
import { PrivacyService } from './privacy'
import {
  DeletedMessageView,
  MessageRow,
  MessageView,
  ViewBuilder,
} from '../views'

export interface MessageInput {
  text: string
  facets?: unknown[]
  embed?: unknown
}

export interface GetMessagesOpts {
  limit?: number
  cursor?: string
}

export interface GetMessagesResult {
  messages: (MessageView | DeletedMessageView)[]
  cursor?: string
}

/**
 * Maximum number of reactions a single user can place on a single message.
 */
const MAX_REACTIONS_PER_USER_PER_MESSAGE = 5

/**
 * Maximum text length in graphemes.
 *
 * Per lexicon: maxGraphemes: 1000.
 * We use the Intl.Segmenter API for accurate grapheme counting.
 */
const MAX_TEXT_GRAPHEMES = 1000

/**
 * Maximum text length in bytes (UTF-8).
 *
 * Per lexicon: maxLength: 10000.
 */
const MAX_TEXT_BYTES = 10000

/**
 * Maximum number of items in a sendMessageBatch request.
 */
const MAX_BATCH_ITEMS = 100

/**
 * Count graphemes in a string.
 *
 * Uses Intl.Segmenter when available (Node 16+), otherwise falls back
 * to Array.from which splits on code points (close approximation).
 */
function countGraphemes(text: string): number {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    let count = 0
    for (const _seg of segmenter.segment(text)) {
      count++
    }
    return count
  }
  // Fallback: code point count (approximation)
  return Array.from(text).length
}

/**
 * Validate that a reaction value is exactly 1 grapheme.
 *
 * Per lexicon: maxGraphemes: 1, minGraphemes: 1.
 * Throws InvalidRequestError with 'ReactionInvalidValue' error name if invalid.
 */
function validateReactionValue(value: string): void {
  if (!value || value.length === 0) {
    throw new InvalidRequestError(
      'Reaction value is required',
      'ReactionInvalidValue',
    )
  }
  const graphemeCount = countGraphemes(value)
  if (graphemeCount !== 1) {
    throw new InvalidRequestError(
      'Reaction must be exactly 1 emoji',
      'ReactionInvalidValue',
    )
  }
}

/**
 * Validate message text per lexicon constraints.
 *
 * - Text must be present and non-empty
 * - Max 1000 graphemes
 * - Max 10000 bytes (UTF-8)
 */
function validateMessageText(text: string): void {
  if (!text || text.length === 0) {
    throw new InvalidRequestError('Message text is required')
  }
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength > MAX_TEXT_BYTES) {
    throw new InvalidRequestError(
      `Message text exceeds maximum byte length of ${MAX_TEXT_BYTES}`,
    )
  }
  const graphemeCount = countGraphemes(text)
  if (graphemeCount > MAX_TEXT_GRAPHEMES) {
    throw new InvalidRequestError(
      `Message text exceeds maximum of ${MAX_TEXT_GRAPHEMES} graphemes`,
    )
  }
}

export class MessageService {
  constructor(
    private db: Database,
    private eventLog: EventLogService,
    private viewBuilder: ViewBuilder,
    private privacy: PrivacyService,
  ) {}

  /**
   * Send a message to a conversation.
   *
   * Validates the caller is a member with status 'accepted' or 'request'.
   * If the caller's status is 'request', auto-accepts and emits convo_accept event.
   * Inserts the message, updates conversation denormalized fields,
   * increments unread count for other members, and fans out message_create event.
   */
  async sendMessage(
    callerDid: string,
    convoId: string,
    message: MessageInput,
  ): Promise<MessageView> {
    // Validate text before entering transaction
    validateMessageText(message.text)

    // Check if caller's chat is disabled via actor_setting / profile
    const callerProfile = await this.db.db
      .selectFrom('profile')
      .where('did', '=', callerDid)
      .select('chatDisabled')
      .executeTakeFirst()

    if (callerProfile?.chatDisabled) {
      throw new InvalidRequestError('Account is disabled')
    }

    return this.db.transaction(async (dbTxn) => {
      // Verify caller is a member with status accepted or request
      const membership = await dbTxn.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .select('status')
        .executeTakeFirst()

      if (!membership) {
        throw new InvalidRequestError('Convo not found')
      }

      if (membership.status === 'left') {
        throw new InvalidRequestError(
          'Cannot send a message to a conversation you have left',
        )
      }

      // Block check: verify caller is not blocked by (or blocking) any other member
      const otherMembers = await dbTxn.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '!=', callerDid)
        .where('status', '!=', 'left')
        .select('memberDid')
        .execute()

      for (const { memberDid } of otherMembers) {
        // Use checkCanSendToMember (not checkCanInitiateConvo) because
        // allowIncoming only applies to new conversation creation, not
        // to sending messages in existing conversations per PRD.
        const privacyResult = await this.privacy.checkCanSendToMember(
          dbTxn,
          callerDid,
          memberDid,
        )
        if (!privacyResult.canChat) {
          throw new InvalidRequestError(
            privacyResult.reason ?? 'block between recipient and sender',
          )
        }
      }

      // Auto-accept: if caller's status is 'request', change to 'accepted'
      // and emit convo_accept event
      if (membership.status === 'request') {
        await dbTxn.db
          .updateTable('conversation_member')
          .set({
            status: 'accepted',
            acceptedAt: new Date().toISOString(),
          })
          .where('convoId', '=', convoId)
          .where('memberDid', '=', callerDid)
          .execute()

        await this.eventLog.fanOutEvent(
          dbTxn,
          convoId,
          'convo_accept',
          { convoId },
        )
      }

      // Generate TID for message ID
      const messageId = TID.nextStr()
      const now = new Date().toISOString()

      // Generate rev for this message
      const rev = await this.eventLog.generateRevForUser(dbTxn, callerDid)

      // Insert message row
      await dbTxn.db
        .insertInto('message')
        .values({
          id: messageId,
          convoId,
          senderDid: callerDid,
          text: message.text,
          facets: message.facets ? JSON.stringify(message.facets) : null,
          embed: message.embed ? JSON.stringify(message.embed) : null,
          rev,
          sentAt: now,
        })
        .execute()

      // Update conversation denormalized fields
      await dbTxn.db
        .updateTable('conversation')
        .set({
          lastMessageId: messageId,
          lastMessageAt: now,
          lastMessageSenderDid: callerDid,
          lastMessageText: message.text,
          rev,
        })
        .where('id', '=', convoId)
        .execute()

      // Increment unread_count for other members (not the sender)
      await dbTxn.db
        .updateTable('conversation_member')
        .set({
          unreadCount: sql`"unreadCount" + 1`,
        })
        .where('convoId', '=', convoId)
        .where('memberDid', '!=', callerDid)
        .where('status', '!=', 'left')
        .execute()

      // Build the message view for the event payload
      const messageRow: MessageRow = {
        id: messageId,
        convoId,
        senderDid: callerDid,
        text: message.text,
        facets: message.facets ? JSON.stringify(message.facets) : null,
        embed: message.embed ? JSON.stringify(message.embed) : null,
        rev,
        sentAt: now,
        deletedAt: null,
      }

      const messageView = this.viewBuilder.buildMessageView(messageRow)

      // Fan out message_create event to all active members
      await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'message_create',
        { convoId, message: messageView },
      )

      return messageView
    })
  }

  /**
   * Send multiple messages in a batch.
   *
   * Validates ALL items first before any inserts.
   * Processes each within the same transaction.
   * Max 100 items per batch.
   */
  async sendMessageBatch(
    callerDid: string,
    items: Array<{ convoId: string; message: MessageInput }>,
  ): Promise<MessageView[]> {
    // Validate batch size
    if (items.length === 0) {
      throw new InvalidRequestError('At least one item is required')
    }
    if (items.length > MAX_BATCH_ITEMS) {
      throw new InvalidRequestError(
        `Batch size exceeds maximum of ${MAX_BATCH_ITEMS} items`,
      )
    }

    // Validate ALL items first before any inserts
    for (const item of items) {
      if (!item.convoId || typeof item.convoId !== 'string') {
        throw new InvalidRequestError('Each item must have a convoId')
      }
      if (!item.message || !item.message.text) {
        throw new InvalidRequestError('Each item must have a message with text')
      }
      validateMessageText(item.message.text)
    }

    // Check if caller's chat is disabled via profile
    const callerProfile = await this.db.db
      .selectFrom('profile')
      .where('did', '=', callerDid)
      .select('chatDisabled')
      .executeTakeFirst()

    if (callerProfile?.chatDisabled) {
      throw new InvalidRequestError('Account is disabled')
    }

    return this.db.transaction(async (dbTxn) => {
      const results: MessageView[] = []

      for (const item of items) {
        // Verify caller is a member with status accepted or request
        const membership = await dbTxn.db
          .selectFrom('conversation_member')
          .where('convoId', '=', item.convoId)
          .where('memberDid', '=', callerDid)
          .select('status')
          .executeTakeFirst()

        if (!membership) {
          throw new InvalidRequestError(
            `Convo not found`,
          )
        }

        if (membership.status === 'left') {
          throw new InvalidRequestError(
            `Cannot send a message to a conversation you have left`,
          )
        }

        // Block check: verify caller is not blocked by (or blocking) any other member
        const otherMembers = await dbTxn.db
          .selectFrom('conversation_member')
          .where('convoId', '=', item.convoId)
          .where('memberDid', '!=', callerDid)
          .where('status', '!=', 'left')
          .select('memberDid')
          .execute()

        for (const { memberDid } of otherMembers) {
          // Use checkCanSendToMember (not checkCanInitiateConvo) because
          // allowIncoming only applies to new conversation creation, not
          // to sending messages in existing conversations per PRD.
          const privacyResult = await this.privacy.checkCanSendToMember(
            dbTxn,
            callerDid,
            memberDid,
          )
          if (!privacyResult.canChat) {
            throw new InvalidRequestError(
              privacyResult.reason ?? 'block between recipient and sender',
            )
          }
        }

        // Auto-accept if status is 'request'
        if (membership.status === 'request') {
          await dbTxn.db
            .updateTable('conversation_member')
            .set({
              status: 'accepted',
              acceptedAt: new Date().toISOString(),
            })
            .where('convoId', '=', item.convoId)
            .where('memberDid', '=', callerDid)
            .execute()

          await this.eventLog.fanOutEvent(
            dbTxn,
            item.convoId,
            'convo_accept',
            { convoId: item.convoId },
          )
        }

        // Generate TID for message ID
        const messageId = TID.nextStr()
        const now = new Date().toISOString()

        // Generate rev
        const rev = await this.eventLog.generateRevForUser(dbTxn, callerDid)

        // Insert message row
        await dbTxn.db
          .insertInto('message')
          .values({
            id: messageId,
            convoId: item.convoId,
            senderDid: callerDid,
            text: item.message.text,
            facets: item.message.facets
              ? JSON.stringify(item.message.facets)
              : null,
            embed: item.message.embed
              ? JSON.stringify(item.message.embed)
              : null,
            rev,
            sentAt: now,
          })
          .execute()

        // Update conversation denormalized fields
        await dbTxn.db
          .updateTable('conversation')
          .set({
            lastMessageId: messageId,
            lastMessageAt: now,
            lastMessageSenderDid: callerDid,
            lastMessageText: item.message.text,
            rev,
          })
          .where('id', '=', item.convoId)
          .execute()

        // Increment unread_count for other members
        await dbTxn.db
          .updateTable('conversation_member')
          .set({
            unreadCount: sql`"unreadCount" + 1`,
          })
          .where('convoId', '=', item.convoId)
          .where('memberDid', '!=', callerDid)
          .where('status', '!=', 'left')
          .execute()

        // Build message view
        const messageRow: MessageRow = {
          id: messageId,
          convoId: item.convoId,
          senderDid: callerDid,
          text: item.message.text,
          facets: item.message.facets
            ? JSON.stringify(item.message.facets)
            : null,
          embed: item.message.embed
            ? JSON.stringify(item.message.embed)
            : null,
          rev,
          sentAt: now,
          deletedAt: null,
        }

        const messageView = this.viewBuilder.buildMessageView(messageRow)

        // Fan out message_create event
        await this.eventLog.fanOutEvent(
          dbTxn,
          item.convoId,
          'message_create',
          { convoId: item.convoId, message: messageView },
        )

        results.push(messageView)
      }

      return results
    })
  }

  /**
   * Get messages for a conversation with cursor-based pagination.
   *
   * Returns messages in reverse chronological order (newest first).
   * Filters out per-user deletions via LEFT JOIN on message_deletions.
   * Batch-fetches reactions for returned messages.
   *
   * Per errata E3: limit range is 1-100.
   */
  async getMessages(
    callerDid: string,
    convoId: string,
    opts: GetMessagesOpts = {},
  ): Promise<GetMessagesResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)

    // Verify membership and fetch rejoinedAt for history filtering
    const membership = await this.db.db
      .selectFrom('conversation_member')
      .where('convoId', '=', convoId)
      .where('memberDid', '=', callerDid)
      .select(['status', 'rejoinedAt'])
      .executeTakeFirst()

    if (!membership) {
      throw new InvalidRequestError('Convo not found')
    }

    // Query messages, filtering out per-user deletions
    let query = this.db.db
      .selectFrom('message')
      .leftJoin('message_deletion', (join) =>
        join
          .onRef('message_deletion.messageId', '=', 'message.id')
          .on('message_deletion.userDid', '=', callerDid),
      )
      .where('message.convoId', '=', convoId)
      .where('message_deletion.messageId', 'is', null) // Exclude deleted-for-self
      .select([
        'message.id',
        'message.convoId',
        'message.senderDid',
        'message.text',
        'message.facets',
        'message.embed',
        'message.rev',
        'message.sentAt',
        'message.deletedAt',
      ])

    // Leave-clears-history: if the caller has rejoined (rejoinedAt is not null),
    // only show messages sent at or after the rejoin timestamp. A null rejoinedAt
    // means the member was there from the start and should see all messages.
    if (membership.rejoinedAt) {
      query = query.where('message.sentAt', '>=', membership.rejoinedAt)
    }

    // Cursor-based pagination using message ID
    if (opts.cursor) {
      query = query.where('message.id', '<', opts.cursor)
    }

    query = query
      .orderBy('message.id', 'desc')
      .limit(limit + 1) // Fetch one extra to determine if there's a next page

    const rows = await query.execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    // Batch-fetch reactions for returned messages
    const messageIds = pageRows.map((r) => r.id)
    let reactionsByMessage = new Map<
      string,
      Array<{ id: string; convoId: string; messageId: string; senderDid: string; value: string; createdAt: string }>
    >()
    if (messageIds.length > 0) {
      const reactions = await this.db.db
        .selectFrom('reaction')
        .where('messageId', 'in', messageIds)
        .selectAll()
        .orderBy('createdAt', 'asc')
        .execute()

      for (const reaction of reactions) {
        const existing = reactionsByMessage.get(reaction.messageId)
        if (existing) {
          existing.push(reaction)
        } else {
          reactionsByMessage.set(reaction.messageId, [reaction])
        }
      }
    }

    // Build message views
    const messages: (MessageView | DeletedMessageView)[] = pageRows.map(
      (row) => {
        if (row.deletedAt) {
          return this.viewBuilder.buildDeletedMessageView(row as MessageRow)
        }
        const reactions = reactionsByMessage.get(row.id)
        return this.viewBuilder.buildMessageView(row as MessageRow, reactions)
      },
    )

    // Compute next cursor
    let cursor: string | undefined
    if (hasMore && pageRows.length > 0) {
      cursor = pageRows[pageRows.length - 1].id
    }

    return { messages, cursor }
  }

  /**
   * Delete a message for self (per-user deletion).
   *
   * Does NOT modify the message itself. Instead inserts into message_deletions.
   * Idempotent with ON CONFLICT DO NOTHING.
   * Fans out message_delete event to SELF ONLY.
   */
  async deleteMessageForSelf(
    callerDid: string,
    convoId: string,
    messageId: string,
  ): Promise<DeletedMessageView> {
    return this.db.transaction(async (dbTxn) => {
      // Verify membership
      const membership = await dbTxn.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .select('status')
        .executeTakeFirst()

      if (!membership) {
        throw new InvalidRequestError('Convo not found')
      }

      // Verify message exists in conversation
      const message = await dbTxn.db
        .selectFrom('message')
        .where('id', '=', messageId)
        .where('convoId', '=', convoId)
        .selectAll()
        .executeTakeFirst()

      if (!message) {
        throw new InvalidRequestError('Message not found')
      }

      // Insert into message_deletions (idempotent)
      await dbTxn.db
        .insertInto('message_deletion')
        .values({
          messageId,
          userDid: callerDid,
        })
        .onConflict((oc) => oc.columns(['messageId', 'userDid']).doNothing())
        .execute()

      // Build deleted message view
      const deletedView = this.viewBuilder.buildDeletedMessageView(
        message as MessageRow,
      )

      // Fan out message_delete event to SELF ONLY
      await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'message_delete',
        { convoId, message: deletedView },
        { selfOnly: callerDid },
      )

      return deletedView
    })
  }

  /**
   * Add an emoji reaction to a message.
   *
   * Validates:
   * - Caller is a member of the conversation
   * - Message exists and is not deleted
   * - Reaction value is exactly 1 grapheme
   * - Max 5 reactions per user per message
   *
   * Idempotent: if the same reaction already exists, returns the message view
   * without creating a duplicate or emitting an event.
   *
   * On actual insert:
   * - Updates conversation last_reaction fields
   * - Updates conversation rev
   * - Fans out reaction_add event to all active members
   */
  async addReaction(
    callerDid: string,
    convoId: string,
    messageId: string,
    value: string,
  ): Promise<MessageView> {
    // Validate reaction value before entering transaction
    validateReactionValue(value)

    return this.db.transaction(async (dbTxn) => {
      // Verify caller is a member
      const membership = await dbTxn.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .select('status')
        .executeTakeFirst()

      if (!membership) {
        throw new InvalidRequestError('Convo not found')
      }

      // Check message exists in conversation
      const message = await dbTxn.db
        .selectFrom('message')
        .where('id', '=', messageId)
        .where('convoId', '=', convoId)
        .selectAll()
        .executeTakeFirst()

      if (!message) {
        throw new InvalidRequestError('Message not found')
      }

      if (message.deletedAt) {
        throw new InvalidRequestError(
          'Cannot react to deleted message',
          'ReactionMessageDeleted',
        )
      }

      // Check reaction limit (5 per user per message)
      const existingReactions = await dbTxn.db
        .selectFrom('reaction')
        .where('convoId', '=', convoId)
        .where('messageId', '=', messageId)
        .where('senderDid', '=', callerDid)
        .selectAll()
        .execute()

      const existingCount = existingReactions.length

      if (existingCount >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
        // Check if this exact reaction already exists (idempotent case)
        const alreadyExists = existingReactions.some(
          (r) => r.value === value,
        )
        if (!alreadyExists) {
          throw new InvalidRequestError(
            'Maximum 5 reactions per user per message',
            'ReactionLimitReached',
          )
        }
      }

      // Insert reaction (idempotent via ON CONFLICT DO NOTHING)
      const reactionId = TID.nextStr()
      const now = new Date().toISOString()

      const insertResult = await dbTxn.db
        .insertInto('reaction')
        .values({
          id: reactionId,
          convoId,
          messageId,
          senderDid: callerDid,
          value,
          createdAt: now,
        })
        .onConflict((oc) =>
          oc
            .columns(['convoId', 'messageId', 'senderDid', 'value'])
            .doNothing(),
        )
        .returning('id')
        .execute()

      const wasInserted = insertResult.length > 0

      // Fetch all reactions for this message to build the response
      const allReactions = await dbTxn.db
        .selectFrom('reaction')
        .where('convoId', '=', convoId)
        .where('messageId', '=', messageId)
        .selectAll()
        .orderBy('createdAt', 'asc')
        .execute()

      const messageView = this.viewBuilder.buildMessageView(
        message as MessageRow,
        allReactions,
      )

      // Skip fan-out and metadata update when reaction already existed (idempotent no-op)
      if (!wasInserted) {
        return messageView
      }

      // Update conversation's last reaction metadata and rev
      const rev = TID.nextStr()

      await dbTxn.db
        .updateTable('conversation')
        .set({
          lastReactionMessageId: messageId,
          lastReactionValue: value,
          lastReactionSenderDid: callerDid,
          lastReactionAt: now,
          rev,
        })
        .where('id', '=', convoId)
        .execute()

      // Fan out reaction_add event to all active members
      await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'reaction_add',
        {
          convoId,
          message: messageView,
          reaction: {
            value,
            sender: { did: callerDid },
            createdAt: now,
          },
        },
      )

      return messageView
    })
  }

  /**
   * Remove an emoji reaction from a message.
   *
   * Validates:
   * - Caller is a member of the conversation
   * - Message exists and is not deleted
   * - Reaction value is exactly 1 grapheme
   *
   * Idempotent: if the reaction doesn't exist, returns the message view
   * without emitting an event.
   *
   * On actual delete:
   * - Updates conversation rev
   * - Fans out reaction_remove event to all active members
   */
  async removeReaction(
    callerDid: string,
    convoId: string,
    messageId: string,
    value: string,
  ): Promise<MessageView> {
    // Validate reaction value before entering transaction
    validateReactionValue(value)

    return this.db.transaction(async (dbTxn) => {
      // Verify caller is a member
      const membership = await dbTxn.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .select('status')
        .executeTakeFirst()

      if (!membership) {
        throw new InvalidRequestError('Convo not found')
      }

      // Check message exists in conversation
      const message = await dbTxn.db
        .selectFrom('message')
        .where('id', '=', messageId)
        .where('convoId', '=', convoId)
        .selectAll()
        .executeTakeFirst()

      if (!message) {
        throw new InvalidRequestError('Message not found')
      }

      if (message.deletedAt) {
        throw new InvalidRequestError(
          'Cannot modify reactions on deleted message',
          'ReactionMessageDeleted',
        )
      }

      // Delete the reaction (idempotent - no error if not found)
      const deleteResult = await dbTxn.db
        .deleteFrom('reaction')
        .where('convoId', '=', convoId)
        .where('messageId', '=', messageId)
        .where('senderDid', '=', callerDid)
        .where('value', '=', value)
        .returning('id')
        .execute()

      const wasDeleted = deleteResult.length > 0

      // Fetch all remaining reactions for this message to build the response
      const allReactions = await dbTxn.db
        .selectFrom('reaction')
        .where('convoId', '=', convoId)
        .where('messageId', '=', messageId)
        .selectAll()
        .orderBy('createdAt', 'asc')
        .execute()

      const messageView = this.viewBuilder.buildMessageView(
        message as MessageRow,
        allReactions,
      )

      // Skip fan-out when no reaction was actually removed (idempotent no-op)
      if (!wasDeleted) {
        return messageView
      }

      // Update conversation rev
      const rev = TID.nextStr()

      await dbTxn.db
        .updateTable('conversation')
        .set({ rev })
        .where('id', '=', convoId)
        .execute()

      // Fan out reaction_remove event to all active members
      await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'reaction_remove',
        {
          convoId,
          message: messageView,
          reaction: {
            value,
            sender: { did: callerDid },
            createdAt: new Date().toISOString(),
          },
        },
      )

      return messageView
    })
  }
}
