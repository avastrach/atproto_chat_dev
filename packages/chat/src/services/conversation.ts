import { TID } from '@atproto/common-web'
import { sql } from 'kysely'
import {
  InvalidRequestError,
} from '@atproto/xrpc-server'
import { Database } from '../db'
import { ConvoView, ViewBuilder } from '../views'
import { generateConvoId } from './convo-id'
import { EventLogService } from './event-log'
import { PrivacyService } from './privacy'

export interface ListConvosOpts {
  limit?: number
  cursor?: string
  readState?: string
  status?: string
}

export interface ListConvosResult {
  convos: ConvoView[]
  cursor?: string
}

export class ConversationService {
  constructor(
    private db: Database,
    private eventLog: EventLogService,
    private viewBuilder: ViewBuilder,
    private privacy: PrivacyService,
  ) {}

  /**
   * Get or create a conversation for the given members.
   *
   * Per errata E9: members array must have length >= 1 and <= 10.
   *
   * Semantics:
   * 1. Compute deterministic conversation ID from sorted member DIDs
   * 2. If the conversation already exists:
   *    - If the caller has status='left', rejoin them (set status='request')
   *    - Otherwise return the existing conversation
   * 3. If the conversation does not exist, create it:
   *    - The caller gets status='accepted' (they initiated)
   *    - Other members get status='request'
   *    - A convo_begin event is fanned out to all members
   */
  async getConvoForMembers(
    callerDid: string,
    memberDids: string[],
  ): Promise<ConvoView> {
    // Validate members array (per errata E9)
    if (memberDids.length < 1 || memberDids.length > 10) {
      throw new InvalidRequestError(
        `Invalid members count: ${memberDids.length}. Must be between 1 and 10.`,
      )
    }

    // Ensure caller is included in the members list
    const allMembers = memberDids.includes(callerDid)
      ? [...memberDids]
      : [callerDid, ...memberDids]

    // De-duplicate
    const uniqueMembers = [...new Set(allMembers)]

    if (uniqueMembers.length > 10) {
      throw new InvalidRequestError(
        'Too many members. Maximum is 10 (including yourself).',
      )
    }

    const convoId = generateConvoId(uniqueMembers)

    return this.db.transaction(async (dbTxn) => {
      // Check if conversation already exists
      const existing = await dbTxn.db
        .selectFrom('conversation')
        .where('id', '=', convoId)
        .select('id')
        .executeTakeFirst()

      if (existing) {
        // Conversation exists. Handle rejoin if caller left.
        const callerMember = await dbTxn.db
          .selectFrom('conversation_member')
          .where('convoId', '=', convoId)
          .where('memberDid', '=', callerDid)
          .select('status')
          .executeTakeFirst()

        if (callerMember?.status === 'left') {
          // Rejoin: set status back to 'request', reset unread count,
          // and record rejoinedAt so getMessages filters out pre-leave history
          await dbTxn.db
            .updateTable('conversation_member')
            .set({
              status: 'request',
              unreadCount: 0,
              leftAt: null,
              rejoinedAt: new Date().toISOString(),
            })
            .where('convoId', '=', convoId)
            .where('memberDid', '=', callerDid)
            .execute()

          // Emit convo_begin event for the rejoining user
          const revs = await this.eventLog.fanOutEvent(
            dbTxn,
            convoId,
            'convo_begin',
            { convoId },
            { selfOnly: callerDid },
          )

          // Update conversation rev
          const callerRev = revs.get(callerDid)
          if (callerRev) {
            await dbTxn.db
              .updateTable('conversation')
              .set({ rev: callerRev })
              .where('id', '=', convoId)
              .execute()
          }
        }

        return this.viewBuilder.buildConvoView(dbTxn, convoId, callerDid)
      }

      // Block check: verify caller is not blocked by (or blocking) any other member
      for (const memberDid of uniqueMembers) {
        if (memberDid === callerDid) continue
        const privacyResult = await this.privacy.checkCanInitiateConvo(
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

      // Create new conversation
      const initialRev = TID.nextStr()

      await dbTxn.db
        .insertInto('conversation')
        .values({
          id: convoId,
          rev: initialRev,
        })
        .execute()

      // Insert members
      // rejoinedAt is null for initial creation -- null means "show all messages"
      // (the member was present from the start, no history filtering needed)
      for (const memberDid of uniqueMembers) {
        const isCaller = memberDid === callerDid
        await dbTxn.db
          .insertInto('conversation_member')
          .values({
            convoId,
            memberDid,
            status: isCaller ? 'accepted' : 'request',
            acceptedAt: isCaller ? new Date().toISOString() : null,
            rejoinedAt: null,
          })
          .execute()
      }

      // Fan out convo_begin event to all members
      const revs = await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'convo_begin',
        { convoId },
      )

      // Update conversation rev with the latest rev from the fan-out
      const latestRev = [...revs.values()].sort().pop()
      if (latestRev) {
        await dbTxn.db
          .updateTable('conversation')
          .set({ rev: latestRev })
          .where('id', '=', convoId)
          .execute()
      }

      return this.viewBuilder.buildConvoView(dbTxn, convoId, callerDid)
    })
  }

  /**
   * Get a single conversation by ID.
   *
   * Verifies the caller is a member of the conversation.
   */
  async getConvo(callerDid: string, convoId: string): Promise<ConvoView> {
    // Verify caller is a member
    const membership = await this.db.db
      .selectFrom('conversation_member')
      .where('convoId', '=', convoId)
      .where('memberDid', '=', callerDid)
      .select('status')
      .executeTakeFirst()

    if (!membership) {
      throw new InvalidRequestError('Convo not found')
    }

    return this.viewBuilder.buildConvoView(this.db, convoId, callerDid)
  }

  /**
   * List conversations for the caller with pagination.
   *
   * Sorted by lastMessageAt DESC (most recent activity first).
   *
   * Filters:
   * - status: 'request' | 'accepted' - filter by caller's membership status
   * - readState: 'unread' - only return conversations with unread messages
   *
   * Pagination: cursor-based using lastMessageAt timestamp.
   * Per errata E3: limit range is 1-100 (not 20-100).
   */
  async listConvos(
    callerDid: string,
    opts: ListConvosOpts = {},
  ): Promise<ListConvosResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)

    let query = this.db.db
      .selectFrom('conversation_member')
      .innerJoin('conversation', 'conversation.id', 'conversation_member.convoId')
      .where('conversation_member.memberDid', '=', callerDid)
      .where('conversation_member.status', '!=', 'left')
      .select([
        'conversation.id as convoId',
        'conversation.lastMessageAt',
        'conversation.updatedAt',
      ])

    // Filter by status
    if (opts.status) {
      query = query.where(
        'conversation_member.status',
        '=',
        opts.status as 'request' | 'accepted',
      )
    }

    // Filter by read state
    if (opts.readState === 'unread') {
      query = query.where('conversation_member.unreadCount', '>', 0)
    }

    // Cursor-based pagination: cursor is the lastMessageAt/updatedAt of the last result.
    // We order by COALESCE(lastMessageAt, updatedAt) DESC so conversations
    // with no messages yet still appear.
    if (opts.cursor) {
      const cursorVal = opts.cursor
      query = query.where(
        sql`COALESCE(conversation."lastMessageAt", conversation."updatedAt")`,
        '<',
        cursorVal,
      )
    }

    query = query
      .orderBy(
        sql`COALESCE(conversation."lastMessageAt", conversation."updatedAt") DESC`,
      )
      .limit(limit + 1) // Fetch one extra to determine if there's a next page

    const rows = await query.execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    // Build ConvoView for each conversation
    const convos: ConvoView[] = []
    for (const row of pageRows) {
      const convo = await this.viewBuilder.buildConvoView(
        this.db,
        row.convoId,
        callerDid,
      )
      convos.push(convo)
    }

    // Compute next cursor from the last row's timestamp
    let cursor: string | undefined
    if (hasMore && pageRows.length > 0) {
      const lastRow = pageRows[pageRows.length - 1]
      cursor = lastRow.lastMessageAt ?? lastRow.updatedAt
    }

    return { convos, cursor }
  }

  /**
   * Accept a conversation.
   *
   * Idempotent: if already accepted, returns no rev.
   * Sets the caller's membership status to 'accepted' and emits a convo_accept event.
   */
  async acceptConvo(
    callerDid: string,
    convoId: string,
  ): Promise<{ rev?: string }> {
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

      // Already accepted - idempotent return
      if (membership.status === 'accepted') {
        return {}
      }

      if (membership.status === 'left') {
        throw new InvalidRequestError(
          'Cannot accept a conversation you have left',
        )
      }

      // Update status to accepted
      await dbTxn.db
        .updateTable('conversation_member')
        .set({
          status: 'accepted',
          acceptedAt: new Date().toISOString(),
        })
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .execute()

      // Fan out convo_accept event to all active members
      const revs = await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'convo_accept',
        { convoId },
      )

      // Update conversation rev
      const latestRev = [...revs.values()].sort().pop()
      if (latestRev) {
        await dbTxn.db
          .updateTable('conversation')
          .set({ rev: latestRev })
          .where('id', '=', convoId)
          .execute()
      }

      const callerRev = revs.get(callerDid)
      return { rev: callerRev }
    })
  }

  /**
   * Leave a conversation.
   *
   * Sets the caller's membership status to 'left' and emits a convo_leave event
   * to ALL members (including remaining members). Per errata E1, there is no
   * separate 'member_leave' event - logLeaveConvo serves both purposes.
   */
  async leaveConvo(
    callerDid: string,
    convoId: string,
  ): Promise<{ convoId: string; rev: string }> {
    return this.db.transaction(async (dbTxn) => {
      // Verify caller is a member (and not already left)
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
        throw new InvalidRequestError('Already left this conversation')
      }

      // Fan out convo_leave event to ALL active members BEFORE marking as left.
      // Per errata E1: logLeaveConvo is fanned out to ALL members.
      const revs = await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        'convo_leave',
        { convoId },
      )

      // Now mark the caller as left
      await dbTxn.db
        .updateTable('conversation_member')
        .set({
          status: 'left',
          leftAt: new Date().toISOString(),
        })
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .execute()

      // Update conversation rev
      const latestRev = [...revs.values()].sort().pop()
      if (latestRev) {
        await dbTxn.db
          .updateTable('conversation')
          .set({ rev: latestRev })
          .where('id', '=', convoId)
          .execute()
      }

      const callerRev = revs.get(callerDid)
      if (!callerRev) {
        throw new Error('Failed to generate rev for leave event')
      }

      return { convoId, rev: callerRev }
    })
  }

  /**
   * Mute a conversation for the calling user.
   *
   * Sets the `muted` column to true on the caller's conversation_member row.
   * Emits a self-only convo_mute event (muting is a private action).
   * Returns a ConvoView.
   */
  async muteConvo(
    callerDid: string,
    convoId: string,
  ): Promise<ConvoView> {
    return this.setMuteState(callerDid, convoId, true)
  }

  /**
   * Unmute a conversation for the calling user.
   *
   * Sets the `muted` column to false on the caller's conversation_member row.
   * Emits a self-only convo_unmute event (unmuting is a private action).
   * Returns a ConvoView.
   */
  async unmuteConvo(
    callerDid: string,
    convoId: string,
  ): Promise<ConvoView> {
    return this.setMuteState(callerDid, convoId, false)
  }

  /**
   * Shared implementation for mute/unmute.
   *
   * Per PRD: mute/unmute events are self-only -- there is no fan-out to other
   * conversation members. The other party is never informed.
   * Per errata E5: logMuteConvo payload has only `rev` and `convoId` (no `mutedAt`).
   */
  private async setMuteState(
    callerDid: string,
    convoId: string,
    muted: boolean,
  ): Promise<ConvoView> {
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

      // Update muted state
      await dbTxn.db
        .updateTable('conversation_member')
        .set({ muted })
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .execute()

      // Self-only event: muting is a private action
      const eventType = muted ? 'convo_mute' : 'convo_unmute'
      await this.eventLog.fanOutEvent(
        dbTxn,
        convoId,
        eventType,
        { convoId },
        { selfOnly: callerDid },
      )

      return this.viewBuilder.buildConvoView(dbTxn, convoId, callerDid)
    })
  }

  /**
   * Check conversation availability for the given members.
   *
   * Returns whether the caller can chat with the specified members
   * and, if a conversation already exists, includes the ConvoView.
   *
   * This does NOT create a conversation (unlike getConvoForMembers).
   */
  async getConvoAvailability(
    callerDid: string,
    memberDids: string[],
  ): Promise<{ canChat: boolean; convo?: ConvoView }> {
    // Validate members array (per errata E9)
    if (memberDids.length < 1 || memberDids.length > 10) {
      throw new InvalidRequestError(
        `Invalid members count: ${memberDids.length}. Must be between 1 and 10.`,
      )
    }

    // Ensure caller is included
    const allMembers = memberDids.includes(callerDid)
      ? [...memberDids]
      : [callerDid, ...memberDids]
    const uniqueMembers = [...new Set(allMembers)]

    if (uniqueMembers.length > 10) {
      throw new InvalidRequestError(
        'Too many members. Maximum is 10 (including yourself).',
      )
    }

    // Check privacy/blocks for each non-caller member
    let canChat = true
    for (const memberDid of uniqueMembers) {
      if (memberDid === callerDid) continue
      const result = await this.privacy.checkCanInitiateConvo(
        this.db,
        callerDid,
        memberDid,
      )
      if (!result.canChat) {
        canChat = false
        break
      }
    }

    // Check if conversation already exists
    const convoId = generateConvoId(uniqueMembers)
    const existing = await this.db.db
      .selectFrom('conversation')
      .where('id', '=', convoId)
      .select('id')
      .executeTakeFirst()

    let convo: ConvoView | undefined
    if (existing) {
      // Check caller is actually a member
      const membership = await this.db.db
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', callerDid)
        .select('status')
        .executeTakeFirst()

      if (membership) {
        convo = await this.viewBuilder.buildConvoView(
          this.db,
          convoId,
          callerDid,
        )
      }
    }

    return { canChat, convo }
  }
}
