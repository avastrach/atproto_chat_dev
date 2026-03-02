import { TID } from '@atproto/common-web'
import { Database } from '../db'
import { UserEventType } from '../db/tables/user-event'

export interface FanOutOptions {
  /** If set, exclude this user DID from receiving the event */
  excludeUser?: string
  /** If set, only write the event for this specific user DID */
  selfOnly?: string
}

export interface LogEntry {
  $type: string
  rev: string
  convoId: string
  [key: string]: unknown
}

export interface GetLogResult {
  cursor?: string
  logs: LogEntry[]
}

/**
 * Maps internal UserEventType values to lexicon $type strings.
 */
const EVENT_TYPE_TO_LEXICON: Record<UserEventType, string> = {
  convo_begin: 'chat.bsky.convo.defs#logBeginConvo',
  convo_accept: 'chat.bsky.convo.defs#logAcceptConvo',
  convo_leave: 'chat.bsky.convo.defs#logLeaveConvo',
  convo_mute: 'chat.bsky.convo.defs#logMuteConvo',
  convo_unmute: 'chat.bsky.convo.defs#logUnmuteConvo',
  message_create: 'chat.bsky.convo.defs#logCreateMessage',
  message_delete: 'chat.bsky.convo.defs#logDeleteMessage',
  message_read: 'chat.bsky.convo.defs#logReadMessage',
  reaction_add: 'chat.bsky.convo.defs#logAddReaction',
  reaction_remove: 'chat.bsky.convo.defs#logRemoveReaction',
}

export class EventLogService {
  /**
   * Generate a monotonically increasing TID rev for a user.
   *
   * Uses the user_last_rev table to ensure revs are always increasing.
   * The new rev is guaranteed to be greater than the user's previous rev.
   *
   * Must be called within a transaction for atomicity.
   */
  async generateRevForUser(db: Database, userDid: string): Promise<string> {
    db.assertTransaction()

    // Get the user's current last rev (if any)
    const existing = await db.db
      .selectFrom('user_last_rev')
      .where('userDid', '=', userDid)
      .select('lastRev')
      .executeTakeFirst()

    // Generate a new TID that is strictly greater than the previous one
    const newRev = existing
      ? TID.nextStr(existing.lastRev)
      : TID.nextStr()

    // Upsert the user's last rev
    await db.db
      .insertInto('user_last_rev')
      .values({
        userDid,
        lastRev: newRev,
      })
      .onConflict((oc) =>
        oc.column('userDid').doUpdateSet({
          lastRev: newRev,
        }),
      )
      .execute()

    return newRev
  }

  /**
   * Fan out an event to all active members of a conversation.
   *
   * For each target member, generates a new per-user rev and writes
   * an event row to the user_events table.
   *
   * Options:
   * - excludeUser: Skip writing the event for this user (e.g. the sender of a message)
   * - selfOnly: Only write the event for this specific user (e.g. for read receipts)
   *
   * Must be called within a transaction.
   */
  async fanOutEvent(
    db: Database,
    convoId: string,
    eventType: UserEventType,
    payload: Record<string, unknown>,
    options?: FanOutOptions,
  ): Promise<Map<string, string>> {
    db.assertTransaction()

    // Get active members (status != 'left') for this conversation
    let membersQuery = db.db
      .selectFrom('conversation_member')
      .where('convoId', '=', convoId)
      .where('status', '!=', 'left')
      .select('memberDid')

    if (options?.selfOnly) {
      membersQuery = membersQuery.where('memberDid', '=', options.selfOnly)
    }

    const members = await membersQuery.execute()

    const revsByUser = new Map<string, string>()

    for (const member of members) {
      if (options?.excludeUser && member.memberDid === options.excludeUser) {
        continue
      }

      const rev = await this.generateRevForUser(db, member.memberDid)

      await db.db
        .insertInto('user_event')
        .values({
          userDid: member.memberDid,
          rev,
          convoId,
          eventType,
          payload: JSON.stringify(payload),
        })
        .execute()

      revsByUser.set(member.memberDid, rev)
    }

    return revsByUser
  }

  /**
   * Retrieve the event log for a user, with cursor-based pagination.
   *
   * Returns events ordered by rev ascending. If a cursor is provided,
   * only events with rev strictly greater than the cursor are returned.
   *
   * Limit is clamped to [1, 100] per errata E3.
   */
  async getLog(
    db: Database,
    userDid: string,
    cursor?: string,
    limit?: number,
  ): Promise<GetLogResult> {
    // Clamp limit to [1, 100], default 100
    const clampedLimit = Math.max(1, Math.min(100, limit ?? 100))

    let query = db.db
      .selectFrom('user_event')
      .where('userDid', '=', userDid)
      .orderBy('rev', 'asc')
      .limit(clampedLimit + 1) // fetch one extra to determine if there are more
      .select(['rev', 'convoId', 'eventType', 'payload'])

    if (cursor) {
      query = query.where('rev', '>', cursor)
    }

    const rows = await query.execute()

    // Determine pagination cursor
    const hasMore = rows.length > clampedLimit
    const resultRows = hasMore ? rows.slice(0, clampedLimit) : rows

    const logs: LogEntry[] = resultRows.map((row) => {
      const $type = EVENT_TYPE_TO_LEXICON[row.eventType as UserEventType]
      const parsedPayload = row.payload
        ? typeof row.payload === 'string'
          ? JSON.parse(row.payload)
          : row.payload
        : {}

      return {
        $type,
        rev: row.rev,
        convoId: row.convoId,
        ...parsedPayload,
      }
    })

    const result: GetLogResult = { logs }
    if (hasMore && resultRows.length > 0) {
      result.cursor = resultRows[resultRows.length - 1].rev
    }

    return result
  }
}
