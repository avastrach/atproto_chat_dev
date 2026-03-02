import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Event log E2E tests.
 *
 * Covers:
 * - Events are generated for chat actions
 * - Correct $type values for each event type
 * - Cursor-based pagination through events
 * - Self-only events (mute/read) are only visible to the acting user
 * - Leave events are visible to all members (per errata E1)
 *
 * References:
 * - PRD 16.7.1 (Opening Messages List - initial getLog)
 * - Errata E1 (10 event types, logLeaveConvo is fanned out to ALL members)
 * - Errata E5 (logMuteConvo payload: only rev and convoId)
 * - Service: event-log.ts (EVENT_TYPE_TO_LEXICON mapping)
 *
 * The 10 valid event $types per errata E1:
 *   chat.bsky.convo.defs#logBeginConvo
 *   chat.bsky.convo.defs#logAcceptConvo
 *   chat.bsky.convo.defs#logLeaveConvo
 *   chat.bsky.convo.defs#logMuteConvo
 *   chat.bsky.convo.defs#logUnmuteConvo
 *   chat.bsky.convo.defs#logCreateMessage
 *   chat.bsky.convo.defs#logDeleteMessage
 *   chat.bsky.convo.defs#logReadMessage
 *   chat.bsky.convo.defs#logAddReaction
 *   chat.bsky.convo.defs#logRemoveReaction
 */

// Type helpers
interface ConvoView {
  id: string
  members: Array<{ did: string }>
}

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface LogEntry {
  $type: string
  rev: string
  convoId: string
  [key: string]: unknown
}

interface GetLogResponse {
  cursor?: string
  logs: LogEntry[]
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

describe('event log', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // Events generated for various actions
  // -----------------------------------------------------------------------

  describe('event generation', () => {
    it('generates logBeginConvo when a conversation is created', async () => {
      // Capture initial log state
      const initialLog = (await alice.agent.getLog()) as GetLogResponse
      const initialCursor = initialLog.cursor

      // Create a new conversation
      const carol = await createTestUser(network, 'carol.test')
      await alice.agent.getConvoForMembers([alice.did, carol.did])

      // Fetch new events after the initial cursor
      const newLog = (await alice.agent.getLog(
        initialCursor,
      )) as GetLogResponse

      const beginEvents = newLog.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logBeginConvo',
      )
      expect(beginEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('generates logCreateMessage when a message is sent', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id
      await bob.agent.acceptConvo(convoId)

      // Get log before sending
      const beforeLog = (await bob.agent.getLog()) as GetLogResponse
      const cursor = beforeLog.cursor

      // Alice sends a message
      await alice.agent.sendMessage(convoId, { text: 'Event log test' })

      // Bob should see a logCreateMessage event
      const afterLog = (await bob.agent.getLog(cursor)) as GetLogResponse
      const createEvents = afterLog.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logCreateMessage',
      )
      expect(createEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('generates logAcceptConvo when a conversation is accepted', async () => {
      const dave = await createTestUser(network, 'dave.test')
      await alice.agent.getConvoForMembers([alice.did, dave.did])
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        dave.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Get log before accepting
      const beforeLog = (await dave.agent.getLog()) as GetLogResponse
      const cursor = beforeLog.cursor

      // Dave accepts
      await dave.agent.acceptConvo(convoId)

      // Dave should see a logAcceptConvo event
      const afterLog = (await dave.agent.getLog(cursor)) as GetLogResponse
      const acceptEvents = afterLog.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logAcceptConvo',
      )
      expect(acceptEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('generates logLeaveConvo when a user leaves', async () => {
      const eve = await createTestUser(network, 'eve.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        eve.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Get log before leaving
      const beforeLog = (await alice.agent.getLog()) as GetLogResponse
      const cursor = beforeLog.cursor

      // Alice leaves
      await alice.agent.leaveConvo(convoId)

      // Alice should see a logLeaveConvo event
      const afterLog = (await alice.agent.getLog(cursor)) as GetLogResponse
      const leaveEvents = afterLog.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logLeaveConvo',
      )
      expect(leaveEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('generates logAddReaction and logRemoveReaction for reactions', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Reaction event test',
      })) as MessageView

      // Get log before reacting
      const beforeLog = (await bob.agent.getLog()) as GetLogResponse
      const cursor = beforeLog.cursor

      // Alice adds a reaction
      await alice.agent.addReaction(convoId, msg.id, '\u2764\uFE0F')

      // Bob should see logAddReaction
      const afterAdd = (await bob.agent.getLog(cursor)) as GetLogResponse
      const addEvents = afterAdd.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logAddReaction',
      )
      expect(addEvents.length).toBeGreaterThanOrEqual(1)

      const cursor2 = afterAdd.cursor ?? cursor

      // Alice removes the reaction
      await alice.agent.removeReaction(convoId, msg.id, '\u2764\uFE0F')

      // Bob should see logRemoveReaction
      const afterRemove = (await bob.agent.getLog(cursor2)) as GetLogResponse
      const removeEvents = afterRemove.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logRemoveReaction',
      )
      expect(removeEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // Event types correctness
  // -----------------------------------------------------------------------

  describe('event types', () => {
    it('all event $types use chat.bsky.convo.defs# prefix', async () => {
      const log = (await alice.agent.getLog()) as GetLogResponse

      for (const entry of log.logs) {
        expect(entry.$type).toMatch(/^chat\.bsky\.convo\.defs#/)
      }
    })

    it('each event has a rev and convoId', async () => {
      const log = (await alice.agent.getLog()) as GetLogResponse

      for (const entry of log.logs) {
        expect(entry.rev).toBeTruthy()
        expect(entry.convoId).toBeTruthy()
      }
    })
  })

  // -----------------------------------------------------------------------
  // Cursor-based pagination
  // -----------------------------------------------------------------------

  describe('cursor pagination', () => {
    it('returns events after cursor (ascending order)', async () => {
      // Get initial log to establish cursor
      const initial = (await alice.agent.getLog()) as GetLogResponse

      if (!initial.cursor || initial.logs.length === 0) {
        // No events yet, create some
        await alice.agent.getConvoForMembers([
          alice.did,
          (await createTestUser(network, 'pag1.test')).did,
        ])
      }

      const log1 = (await alice.agent.getLog()) as GetLogResponse
      expect(log1.logs.length).toBeGreaterThan(0)

      // Events should be in ascending rev order
      for (let i = 1; i < log1.logs.length; i++) {
        expect(log1.logs[i].rev > log1.logs[i - 1].rev).toBe(true)
      }
    })

    it('returns empty logs when cursor is at the end', async () => {
      const log = (await alice.agent.getLog()) as GetLogResponse

      if (log.cursor) {
        // Use the last cursor -- should get no new events (unless there are more)
        const nextLog = (await alice.agent.getLog(
          log.cursor,
        )) as GetLogResponse

        // If there is no cursor in the response, we've reached the end
        if (!nextLog.cursor) {
          expect(nextLog.logs.length).toBe(0)
        }
      }
    })

    it('can paginate through all events from the beginning', async () => {
      // Get all events from the start (no cursor)
      const allEvents: LogEntry[] = []
      let cursor: string | undefined

      // Paginate until no more events
      let iterations = 0
      do {
        const res = (await alice.agent.getLog(cursor)) as GetLogResponse
        allEvents.push(...res.logs)
        cursor = res.cursor
        iterations++
      } while (cursor && iterations < 10)

      // We should have at least some events from previous tests
      expect(allEvents.length).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Self-only events (mute, read)
  // -----------------------------------------------------------------------

  describe('self-only events', () => {
    it('mute event is only visible to the muting user', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Get Bob's log cursor
      const bobBefore = (await bob.agent.getLog()) as GetLogResponse
      const bobCursor = bobBefore.cursor

      // Alice mutes the conversation
      const aliceBefore = (await alice.agent.getLog()) as GetLogResponse
      const aliceCursor = aliceBefore.cursor

      await alice.agent.muteConvo(convoId)

      // Alice should see the mute event
      const aliceAfter = (await alice.agent.getLog(
        aliceCursor,
      )) as GetLogResponse
      const aliceMuteEvents = aliceAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logMuteConvo',
      )
      expect(aliceMuteEvents.length).toBeGreaterThanOrEqual(1)

      // Bob should NOT see the mute event
      const bobAfter = (await bob.agent.getLog(bobCursor)) as GetLogResponse
      const bobMuteEvents = bobAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logMuteConvo',
      )
      expect(bobMuteEvents.length).toBe(0)

      // Clean up
      await alice.agent.unmuteConvo(convoId)
    })

    it('unmute event is only visible to the unmuting user', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Alice mutes and then unmutes
      await alice.agent.muteConvo(convoId)

      const bobBefore = (await bob.agent.getLog()) as GetLogResponse
      const bobCursor = bobBefore.cursor

      const aliceBefore = (await alice.agent.getLog()) as GetLogResponse
      const aliceCursor = aliceBefore.cursor

      await alice.agent.unmuteConvo(convoId)

      // Alice should see the unmute event
      const aliceAfter = (await alice.agent.getLog(
        aliceCursor,
      )) as GetLogResponse
      const aliceUnmuteEvents = aliceAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logUnmuteConvo',
      )
      expect(aliceUnmuteEvents.length).toBeGreaterThanOrEqual(1)

      // Bob should NOT see the unmute event
      const bobAfter = (await bob.agent.getLog(bobCursor)) as GetLogResponse
      const bobUnmuteEvents = bobAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logUnmuteConvo',
      )
      expect(bobUnmuteEvents.length).toBe(0)
    })

    it('read event is only visible to the reading user', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Alice sends a message so Bob has something to mark as read
      await alice.agent.sendMessage(convoId, {
        text: 'Read event visibility test',
      })

      // Get cursors
      const aliceBefore = (await alice.agent.getLog()) as GetLogResponse
      const aliceCursor = aliceBefore.cursor

      const bobBefore = (await bob.agent.getLog()) as GetLogResponse
      const bobCursor = bobBefore.cursor

      // Bob marks as read
      await bob.agent.updateRead(convoId)

      // Bob should see the read event (self-only)
      const bobAfter = (await bob.agent.getLog(bobCursor)) as GetLogResponse
      const bobReadEvents = bobAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logReadMessage',
      )
      expect(bobReadEvents.length).toBeGreaterThanOrEqual(1)

      // Alice should NOT see Bob's read event
      const aliceAfter = (await alice.agent.getLog(
        aliceCursor,
      )) as GetLogResponse
      const aliceReadEvents = aliceAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logReadMessage',
      )
      expect(aliceReadEvents.length).toBe(0)
    })

    it('deleteMessageForSelf event is only visible to the deleting user', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Delete event visibility test',
      })) as MessageView

      // Get cursors
      const aliceBefore = (await alice.agent.getLog()) as GetLogResponse
      const aliceCursor = aliceBefore.cursor

      const bobBefore = (await bob.agent.getLog()) as GetLogResponse
      const bobCursor = bobBefore.cursor

      // Alice deletes the message for herself
      await alice.agent.deleteMessageForSelf(convoId, msg.id)

      // Alice should see the delete event
      const aliceAfter = (await alice.agent.getLog(
        aliceCursor,
      )) as GetLogResponse
      const aliceDeleteEvents = aliceAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logDeleteMessage',
      )
      expect(aliceDeleteEvents.length).toBeGreaterThanOrEqual(1)

      // Bob should NOT see Alice's delete event
      const bobAfter = (await bob.agent.getLog(bobCursor)) as GetLogResponse
      const bobDeleteEvents = bobAfter.logs.filter(
        (e) => e.$type === 'chat.bsky.convo.defs#logDeleteMessage',
      )
      expect(bobDeleteEvents.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Leave events are visible to ALL members (per errata E1)
  // -----------------------------------------------------------------------

  describe('leave event fan-out', () => {
    it('logLeaveConvo is visible to both the leaver and the remaining member', async () => {
      const frank = await createTestUser(network, 'frank.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        frank.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      await frank.agent.acceptConvo(convoId)

      // Get cursors
      const aliceBefore = (await alice.agent.getLog()) as GetLogResponse
      const aliceCursor = aliceBefore.cursor

      const frankBefore = (await frank.agent.getLog()) as GetLogResponse
      const frankCursor = frankBefore.cursor

      // Frank leaves
      await frank.agent.leaveConvo(convoId)

      // Frank (the leaver) should see the leave event
      const frankAfter = (await frank.agent.getLog(
        frankCursor,
      )) as GetLogResponse
      const frankLeaveEvents = frankAfter.logs.filter(
        (e) =>
          e.$type === 'chat.bsky.convo.defs#logLeaveConvo' &&
          e.convoId === convoId,
      )
      expect(frankLeaveEvents.length).toBeGreaterThanOrEqual(1)

      // Alice (remaining member) should ALSO see the leave event
      const aliceAfter = (await alice.agent.getLog(
        aliceCursor,
      )) as GetLogResponse
      const aliceLeaveEvents = aliceAfter.logs.filter(
        (e) =>
          e.$type === 'chat.bsky.convo.defs#logLeaveConvo' &&
          e.convoId === convoId,
      )
      expect(aliceLeaveEvents.length).toBeGreaterThanOrEqual(1)
    })
  })
})
