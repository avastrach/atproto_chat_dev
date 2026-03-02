import { Database } from '../db'
import { EventLogService } from './event-log'
import { ViewBuilder, MessageRow } from '../views'

/**
 * Callback function for streaming JSONL lines.
 */
export type WriteLineFn = (obj: Record<string, unknown>) => void

export class AccountService {
  constructor(
    private db: Database,
    private eventLog: EventLogService,
    private viewBuilder: ViewBuilder,
  ) {}

  /**
   * Delete all chat data for a user account.
   *
   * Performs a cascading delete within a single transaction:
   * 1. Delete user_event rows
   * 2. Delete user_last_rev rows
   * 3. Delete message_deletion rows
   * 4. Delete reaction rows
   * 5. Soft-delete messages (set deletedAt)
   * 6. Update conversation_member status to 'left'
   * 7. Delete push_token rows
   * 8. Delete actor_setting rows
   * 9. Delete profile row
   *
   * Also fans out logDeleteMessage and logLeaveConvo events to remaining
   * conversation members so their clients can update.
   */
  async deleteAccount(callerDid: string): Promise<void> {
    // Find all conversations the user belongs to before entering the transaction,
    // so we can fan out events to remaining members.
    const memberships = await this.db.db
      .selectFrom('conversation_member')
      .where('memberDid', '=', callerDid)
      .select(['convoId', 'status'])
      .execute()

    await this.db.transaction(async (dbTxn) => {
      // For each conversation, soft-delete messages and fan out events
      for (const membership of memberships) {
        const convoId = membership.convoId

        // Find messages sent by the user that are not yet deleted
        const userMessages = await dbTxn.db
          .selectFrom('message')
          .where('convoId', '=', convoId)
          .where('senderDid', '=', callerDid)
          .where('deletedAt', 'is', null)
          .selectAll()
          .execute()

        // Soft-delete the user's messages
        if (userMessages.length > 0) {
          const now = new Date().toISOString()
          await dbTxn.db
            .updateTable('message')
            .set({ deletedAt: now })
            .where('convoId', '=', convoId)
            .where('senderDid', '=', callerDid)
            .where('deletedAt', 'is', null)
            .execute()

          // Fan out message_delete events to remaining members
          for (const msg of userMessages) {
            const deletedView = this.viewBuilder.buildDeletedMessageView(
              msg as MessageRow,
            )
            await this.eventLog.fanOutEvent(
              dbTxn,
              convoId,
              'message_delete',
              { convoId, message: deletedView },
              { excludeUser: callerDid },
            )
          }
        }

        // Fan out convo_leave event to remaining members
        await this.eventLog.fanOutEvent(
          dbTxn,
          convoId,
          'convo_leave',
          { convoId },
          { excludeUser: callerDid },
        )
      }

      // 1. Delete user_event rows
      await dbTxn.db
        .deleteFrom('user_event')
        .where('userDid', '=', callerDid)
        .execute()

      // 2. Delete user_last_rev rows
      await dbTxn.db
        .deleteFrom('user_last_rev')
        .where('userDid', '=', callerDid)
        .execute()

      // 3. Delete message_deletion rows
      await dbTxn.db
        .deleteFrom('message_deletion')
        .where('userDid', '=', callerDid)
        .execute()

      // 4. Delete reaction rows
      await dbTxn.db
        .deleteFrom('reaction')
        .where('senderDid', '=', callerDid)
        .execute()

      // 5. Messages already soft-deleted above (in the per-convo loop)

      // 6. Update conversation_member status to 'left'
      await dbTxn.db
        .updateTable('conversation_member')
        .set({
          status: 'left',
          leftAt: new Date().toISOString(),
        })
        .where('memberDid', '=', callerDid)
        .execute()

      // 7. Delete push_token rows
      await dbTxn.db
        .deleteFrom('push_token')
        .where('userDid', '=', callerDid)
        .execute()

      // 8. Delete actor_setting rows
      await dbTxn.db
        .deleteFrom('actor_setting')
        .where('did', '=', callerDid)
        .execute()

      // 9. Delete profile row
      await dbTxn.db
        .deleteFrom('profile')
        .where('did', '=', callerDid)
        .execute()
    })
  }

  /**
   * Export all chat data for a user account as JSONL.
   *
   * Calls the writeLine callback for each record, with a $type discriminator.
   * Includes: actor settings, conversations, messages, reactions.
   */
  async exportAccountData(
    callerDid: string,
    writeLine: WriteLineFn,
  ): Promise<void> {
    // 1. Export actor settings
    const settings = await this.db.db
      .selectFrom('actor_setting')
      .where('did', '=', callerDid)
      .selectAll()
      .executeTakeFirst()

    if (settings) {
      writeLine({
        $type: 'chat.bsky.actor.declaration',
        allowIncoming: settings.allowIncoming,
      })
    }

    // 2. Export conversations the user is a member of
    const memberships = await this.db.db
      .selectFrom('conversation_member')
      .where('memberDid', '=', callerDid)
      .innerJoin(
        'conversation',
        'conversation.id',
        'conversation_member.convoId',
      )
      .select([
        'conversation.id as convoId',
        'conversation.rev',
        'conversation.createdAt',
        'conversation.lastMessageId',
        'conversation.lastMessageAt',
        'conversation_member.status',
        'conversation_member.muted',
        'conversation_member.unreadCount',
        'conversation_member.lastReadRev',
      ])
      .orderBy('conversation.createdAt', 'desc')
      .execute()

    for (const membership of memberships) {
      // Build a convo view for this conversation
      const convoView = await this.viewBuilder.buildConvoView(
        this.db,
        membership.convoId,
        callerDid,
      )

      writeLine({
        $type: 'chat.bsky.convo.defs#convoView',
        ...convoView,
      })

      // 3. Export all messages in this conversation
      let messageCursor: string | undefined
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let query = this.db.db
          .selectFrom('message')
          .where('convoId', '=', membership.convoId)
          .orderBy('id', 'asc')
          .limit(100)
          .selectAll()

        if (messageCursor) {
          query = query.where('id', '>', messageCursor)
        }

        const messages = await query.execute()

        if (messages.length === 0) break

        for (const msg of messages) {
          if (msg.deletedAt) {
            writeLine({
              ...this.viewBuilder.buildDeletedMessageView(msg as MessageRow),
            })
          } else {
            writeLine({
              ...this.viewBuilder.buildMessageView(msg as MessageRow),
            })
          }
        }

        messageCursor = messages[messages.length - 1].id
        if (messages.length < 100) break
      }
    }

    // 4. Export all reactions by the user
    const reactions = await this.db.db
      .selectFrom('reaction')
      .where('senderDid', '=', callerDid)
      .selectAll()
      .orderBy('createdAt', 'asc')
      .execute()

    for (const reaction of reactions) {
      writeLine({
        $type: 'chat.bsky.convo.defs#reactionView',
        value: reaction.value,
        sender: { did: reaction.senderDid },
        createdAt: reaction.createdAt,
        messageId: reaction.messageId,
        convoId: reaction.convoId,
      })
    }
  }
}
