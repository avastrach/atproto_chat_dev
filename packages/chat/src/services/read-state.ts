import { InvalidRequestError } from '@atproto/xrpc-server'
import { Database } from '../db'
import { EventLogService } from './event-log'
import { ConvoView, MessageRow, ViewBuilder } from '../views'

export class ReadStateService {
  constructor(
    private db: Database,
    private eventLog: EventLogService,
    private viewBuilder: ViewBuilder,
  ) {}

  /**
   * Mark a conversation as read for the caller.
   *
   * If messageId is provided, the read state is set to that message's rev.
   * Otherwise, reads up to the latest message in the conversation.
   *
   * Sets unread_count to 0 and updates last_read_rev.
   * Fans out message_read event to SELF ONLY.
   * Returns the updated ConvoView.
   */
  async updateRead(
    callerDid: string,
    convoId: string,
    messageId?: string,
  ): Promise<ConvoView> {
    return this.db.transaction(async (dbTxn) => {
      // Verify membership
      const membership = await dbTxn.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .select(['status', 'lastReadRev'])
        .executeTakeFirst()

      if (!membership) {
        throw new InvalidRequestError('Convo not found')
      }

      // Determine the rev to set as last_read_rev
      let readRev: string | null = null

      if (messageId) {
        // Get the specified message's rev
        const message = await dbTxn.db
          .selectFrom('message')
          .where('id', '=', messageId)
          .where('convoId', '=', convoId)
          .select('rev')
          .executeTakeFirst()

        if (!message) {
          throw new InvalidRequestError('Message not found')
        }
        readRev = message.rev
      } else {
        // Get the latest message's rev in the conversation
        const latestMessage = await dbTxn.db
          .selectFrom('message')
          .where('convoId', '=', convoId)
          .select('rev')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst()

        if (latestMessage) {
          readRev = latestMessage.rev
        }
      }

      // Update conversation_member: set last_read_rev, unread_count = 0
      await dbTxn.db
        .updateTable('conversation_member')
        .set({
          lastReadRev: readRev,
          unreadCount: 0,
        })
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .execute()

      // Build a message view for the event payload (if there is a message)
      let messagePayload: Record<string, unknown> = { convoId }
      if (messageId) {
        const msg = await dbTxn.db
          .selectFrom('message')
          .where('id', '=', messageId)
          .where('convoId', '=', convoId)
          .selectAll()
          .executeTakeFirst()

        if (msg) {
          const msgView = this.viewBuilder.buildMessageView(msg as MessageRow)
          messagePayload = { convoId, message: msgView }
        }
      }

      // Fan out message_read event to SELF ONLY
      await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'message_read',
        messagePayload,
        { selfOnly: callerDid },
      )

      return this.viewBuilder.buildConvoView(dbTxn, convoId, callerDid)
    })
  }

  /**
   * Mark all conversations as read for the caller.
   *
   * Optionally filter by membership status ('request' or 'accepted').
   * Sets unread_count to 0 for all matched conversation memberships.
   * Returns the count of updated conversations.
   */
  async updateAllRead(
    callerDid: string,
    status?: string,
  ): Promise<{ updatedCount: number }> {
    let query = this.db.db
      .updateTable('conversation_member')
      .set({ unreadCount: 0 })
      .where('memberDid', '=', callerDid)
      .where('status', '!=', 'left')
      .where('unreadCount', '>', 0)

    if (status) {
      query = query.where(
        'status',
        '=',
        status as 'request' | 'accepted',
      )
    }

    const result = await query.execute()

    // Kysely returns an array of results; numUpdatedRows is a bigint
    const updatedCount = result.reduce(
      (sum, r) => sum + Number(r.numUpdatedRows),
      0,
    )

    return { updatedCount }
  }
}
