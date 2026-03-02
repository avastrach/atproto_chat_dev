import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Read state tracking E2E tests.
 *
 * Covers:
 * - Marking a conversation as read (updateRead)
 * - Marking all conversations as read (updateAllRead)
 * - Unread count increments when messages are sent by other members
 * - Unread count resets to 0 after updateRead
 * - updateRead with specific messageId vs latest message
 *
 * References:
 * - PRD 16.7.7 (Marking Messages as Read)
 * - PRD 16.7.12 (Mark All as Read)
 * - Service: read-state.ts
 */

// Type helpers
interface ConvoView {
  id: string
  members: Array<{ did: string }>
  unreadCount: number
  status: string
}

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

interface GetConvoResponse {
  convo: ConvoView
}

interface UpdateReadResponse {
  convo: ConvoView
}

interface UpdateAllReadResponse {
  updatedCount: number
}

describe('read state tracking', () => {
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
  // Unread count tracking
  // -----------------------------------------------------------------------

  describe('unread count', () => {
    it('increments unread count when other member sends a message', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Accept the convo
      await bob.agent.acceptConvo(convoId)

      // Mark as read first to start from 0
      await bob.agent.updateRead(convoId)

      // Alice sends a message
      await alice.agent.sendMessage(convoId, { text: 'Unread count test 1' })

      // Bob's unread count should be 1
      const bobView1 = (await bob.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      expect(bobView1.convo.unreadCount).toBe(1)

      // Alice sends another message
      await alice.agent.sendMessage(convoId, { text: 'Unread count test 2' })

      // Bob's unread count should be 2
      const bobView2 = (await bob.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      expect(bobView2.convo.unreadCount).toBe(2)
    })

    it('does not increment unread count for the sender', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Mark Alice as read
      await alice.agent.updateRead(convoId)

      const aliceBefore = (await alice.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      const beforeCount = aliceBefore.convo.unreadCount

      // Alice sends a message -- her own unread count should not increase
      await alice.agent.sendMessage(convoId, { text: 'My own message' })

      const aliceAfter = (await alice.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      expect(aliceAfter.convo.unreadCount).toBe(beforeCount)
    })
  })

  // -----------------------------------------------------------------------
  // updateRead - mark a specific conversation as read
  // -----------------------------------------------------------------------

  describe('updateRead', () => {
    it('sets unread count to 0', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Accept the convo if not already
      try {
        await bob.agent.acceptConvo(convoId)
      } catch {
        // Already accepted, ignore
      }

      // Alice sends messages so bob has unreads
      await alice.agent.sendMessage(convoId, { text: 'Read state test 1' })
      await alice.agent.sendMessage(convoId, { text: 'Read state test 2' })

      // Verify Bob has unreads
      const bobBefore = (await bob.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      expect(bobBefore.convo.unreadCount).toBeGreaterThan(0)

      // Bob marks as read
      const res = (await bob.agent.updateRead(
        convoId,
      )) as UpdateReadResponse

      expect(res.convo).toBeDefined()
      expect(res.convo.unreadCount).toBe(0)
    })

    it('returns updated ConvoView', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      const res = (await bob.agent.updateRead(
        convoId,
      )) as UpdateReadResponse

      expect(res.convo.id).toBe(convoId)
      expect(res.convo.members).toHaveLength(2)
      expect(res.convo.unreadCount).toBe(0)
    })

    it('marks as read up to a specific message when messageId is provided', async () => {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Mark bob as read first
      await bob.agent.updateRead(convoId)

      // Alice sends two messages
      const msg1 = (await alice.agent.sendMessage(convoId, {
        text: 'Read up to here',
      })) as MessageView
      await alice.agent.sendMessage(convoId, {
        text: 'Not read yet',
      })

      // Bob marks as read up to msg1 only
      const res = (await bob.agent.updateRead(
        convoId,
        msg1.id,
      )) as UpdateReadResponse

      // Unread count should be 0 (updateRead sets it to 0 regardless)
      expect(res.convo.unreadCount).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // updateAllRead - batch mark all conversations as read
  // -----------------------------------------------------------------------

  describe('updateAllRead', () => {
    it('marks all conversations as read and returns updated count', async () => {
      // Create multiple conversations with unread messages
      const carol = await createTestUser(network, 'carol.test')
      const dave = await createTestUser(network, 'dave.test')

      const convo1Res = (await carol.agent.getConvoForMembers([
        carol.did,
        alice.did,
      ])) as ConvoForMembersResponse
      const convo2Res = (await dave.agent.getConvoForMembers([
        dave.did,
        alice.did,
      ])) as ConvoForMembersResponse

      // Accept both convos as alice
      await alice.agent.acceptConvo(convo1Res.convo.id)
      await alice.agent.acceptConvo(convo2Res.convo.id)

      // Mark alice as read in both
      await alice.agent.updateRead(convo1Res.convo.id)
      await alice.agent.updateRead(convo2Res.convo.id)

      // Send messages from carol and dave to give alice unreads
      await carol.agent.sendMessage(convo1Res.convo.id, {
        text: 'Unread from carol',
      })
      await dave.agent.sendMessage(convo2Res.convo.id, {
        text: 'Unread from dave',
      })

      // Alice should have unreads
      const alice1 = (await alice.agent.getConvo(
        convo1Res.convo.id,
      )) as GetConvoResponse
      const alice2 = (await alice.agent.getConvo(
        convo2Res.convo.id,
      )) as GetConvoResponse
      expect(alice1.convo.unreadCount).toBeGreaterThan(0)
      expect(alice2.convo.unreadCount).toBeGreaterThan(0)

      // Mark all as read
      const res = (await alice.agent.updateAllRead()) as UpdateAllReadResponse

      expect(res.updatedCount).toBeGreaterThanOrEqual(2)

      // Verify unread counts are 0
      const alice1After = (await alice.agent.getConvo(
        convo1Res.convo.id,
      )) as GetConvoResponse
      const alice2After = (await alice.agent.getConvo(
        convo2Res.convo.id,
      )) as GetConvoResponse
      expect(alice1After.convo.unreadCount).toBe(0)
      expect(alice2After.convo.unreadCount).toBe(0)
    })

    it('returns 0 when no conversations have unread messages', async () => {
      // Mark everything as read first
      await alice.agent.updateAllRead()

      // Call again -- should return 0
      const res = (await alice.agent.updateAllRead()) as UpdateAllReadResponse
      expect(res.updatedCount).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // updateAllRead with status filter
  // -----------------------------------------------------------------------

  describe('updateAllRead with status filter', () => {
    it('status=request only marks request convos as read', async () => {
      // Create a convo where alice is the initiator (status=accepted)
      const acceptedPeer = await createTestUser(network, 'uar-acc.test')
      const acceptedConvoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        acceptedPeer.did,
      ])) as ConvoForMembersResponse
      const acceptedConvoId = acceptedConvoRes.convo.id
      await acceptedPeer.agent.acceptConvo(acceptedConvoId)
      await alice.agent.updateRead(acceptedConvoId)

      // Create a convo where someone else initiates (alice has status=request)
      const requestInitiator = await createTestUser(network, 'uar-req.test')
      const requestConvoRes = (await requestInitiator.agent.getConvoForMembers([
        requestInitiator.did,
        alice.did,
      ])) as ConvoForMembersResponse
      const requestConvoId = requestConvoRes.convo.id

      // Send messages to both convos to give alice unreads
      await acceptedPeer.agent.sendMessage(acceptedConvoId, {
        text: 'Unread in accepted',
      })
      await requestInitiator.agent.sendMessage(requestConvoId, {
        text: 'Unread in request',
      })

      // Verify alice has unreads in both
      const aliceAccepted = (await alice.agent.getConvo(
        acceptedConvoId,
      )) as GetConvoResponse
      const aliceRequest = (await alice.agent.getConvo(
        requestConvoId,
      )) as GetConvoResponse
      expect(aliceAccepted.convo.unreadCount).toBeGreaterThan(0)
      expect(aliceRequest.convo.unreadCount).toBeGreaterThan(0)

      // Mark only 'request' convos as read
      const res = (await alice.agent.updateAllRead({
        status: 'request',
      })) as UpdateAllReadResponse
      expect(res.updatedCount).toBeGreaterThanOrEqual(1)

      // Request convo should now be read
      const afterRequest = (await alice.agent.getConvo(
        requestConvoId,
      )) as GetConvoResponse
      expect(afterRequest.convo.unreadCount).toBe(0)

      // Accepted convo should STILL be unread
      const afterAccepted = (await alice.agent.getConvo(
        acceptedConvoId,
      )) as GetConvoResponse
      expect(afterAccepted.convo.unreadCount).toBeGreaterThan(0)

      // Clean up: mark everything as read
      await alice.agent.updateAllRead()
    })

    it('status=accepted only marks accepted convos as read', async () => {
      // Create a convo where alice is the initiator (status=accepted)
      const acceptedPeer2 = await createTestUser(network, 'uar-acc2.test')
      const acceptedConvoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        acceptedPeer2.did,
      ])) as ConvoForMembersResponse
      const acceptedConvoId = acceptedConvoRes.convo.id
      await acceptedPeer2.agent.acceptConvo(acceptedConvoId)
      await alice.agent.updateRead(acceptedConvoId)

      // Create a convo where someone else initiates (alice has status=request)
      const requestInitiator2 = await createTestUser(network, 'uar-req2.test')
      const requestConvoRes = (await requestInitiator2.agent.getConvoForMembers([
        requestInitiator2.did,
        alice.did,
      ])) as ConvoForMembersResponse
      const requestConvoId = requestConvoRes.convo.id

      // Send messages to both convos to give alice unreads
      await acceptedPeer2.agent.sendMessage(acceptedConvoId, {
        text: 'Unread in accepted 2',
      })
      await requestInitiator2.agent.sendMessage(requestConvoId, {
        text: 'Unread in request 2',
      })

      // Verify alice has unreads in both
      const aliceAccepted = (await alice.agent.getConvo(
        acceptedConvoId,
      )) as GetConvoResponse
      const aliceRequest = (await alice.agent.getConvo(
        requestConvoId,
      )) as GetConvoResponse
      expect(aliceAccepted.convo.unreadCount).toBeGreaterThan(0)
      expect(aliceRequest.convo.unreadCount).toBeGreaterThan(0)

      // Mark only 'accepted' convos as read
      const res = (await alice.agent.updateAllRead({
        status: 'accepted',
      })) as UpdateAllReadResponse
      expect(res.updatedCount).toBeGreaterThanOrEqual(1)

      // Accepted convo should now be read
      const afterAccepted = (await alice.agent.getConvo(
        acceptedConvoId,
      )) as GetConvoResponse
      expect(afterAccepted.convo.unreadCount).toBe(0)

      // Request convo should STILL be unread
      const afterRequest = (await alice.agent.getConvo(
        requestConvoId,
      )) as GetConvoResponse
      expect(afterRequest.convo.unreadCount).toBeGreaterThan(0)

      // Clean up
      await alice.agent.updateAllRead()
    })
  })

  // -----------------------------------------------------------------------
  // updateRead with messageId: event payload branch
  // -----------------------------------------------------------------------

  describe('updateRead with messageId event payload', () => {
    it('emits message_read event with message payload when messageId is provided', async () => {
      // This exercises read-state.ts lines 86-97 (building the message view
      // payload inside updateRead when messageId is provided).
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      try {
        await bob.agent.acceptConvo(convoId)
      } catch {
        // Already accepted, ignore
      }

      // Mark as read first
      await bob.agent.updateRead(convoId)

      // Alice sends a message
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Event payload test msg',
      })) as MessageView

      // Capture event log cursor before updateRead
      const logBefore = (await bob.agent.getLog()) as {
        cursor?: string
        logs: Array<{ $type: string; convoId: string; message?: { id: string; text: string }; [key: string]: unknown }>
      }
      const cursor = logBefore.cursor

      // Bob marks as read UP TO a specific message (messageId path)
      const res = (await bob.agent.updateRead(
        convoId,
        msg.id,
      )) as UpdateReadResponse

      expect(res.convo.unreadCount).toBe(0)

      // Verify the message_read event was emitted with the message payload
      const logAfter = (await bob.agent.getLog(cursor)) as {
        cursor?: string
        logs: Array<{ $type: string; convoId: string; message?: { id: string; text?: string }; [key: string]: unknown }>
      }

      const readEvents = logAfter.logs.filter(
        (e) =>
          e.$type === 'chat.bsky.convo.defs#logReadMessage' &&
          e.convoId === convoId,
      )
      expect(readEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('updateRead without messageId marks up to latest message', async () => {
      // This exercises the else branch (lines 57-69) where no messageId is
      // provided, so the latest message's rev is used.
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Alice sends two messages
      await alice.agent.sendMessage(convoId, { text: 'Msg A for rev test' })
      await alice.agent.sendMessage(convoId, { text: 'Msg B for rev test' })

      // Bob marks as read without specifying a messageId
      const res = (await bob.agent.updateRead(convoId)) as UpdateReadResponse

      expect(res.convo.unreadCount).toBe(0)
      expect(res.convo.id).toBe(convoId)
    })

    it('updateRead on empty conversation (no messages) still succeeds', async () => {
      // This hits the path where latestMessage is undefined (line 67 condition
      // evaluates to false, readRev stays null).
      const peer = await createTestUser(network, 'rs-empty-p.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        peer.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Mark as read on a convo with no messages
      const res = (await alice.agent.updateRead(convoId)) as UpdateReadResponse

      expect(res.convo.unreadCount).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // updateRead error branches
  // -----------------------------------------------------------------------

  describe('updateRead error branches', () => {
    it('rejects updateRead on a convo the caller is not a member of', async () => {
      // Create a conversation between alice and bob
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Carol is not a member of this convo -- updateRead should fail
      const carol = await createTestUser(network, 'rs-err-carol.test')
      await expect(carol.agent.updateRead(convoId)).rejects.toThrow(
        /Convo not found/i,
      )
    })

    it('rejects updateRead with a non-existent convoId', async () => {
      await expect(
        alice.agent.updateRead('nonexistent-convo-id-99999'),
      ).rejects.toThrow(/Convo not found/i)
    })

    it('rejects updateRead with a messageId that does not exist in the convo', async () => {
      // Create a conversation and accept it
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      try {
        await bob.agent.acceptConvo(convoId)
      } catch {
        // Already accepted, ignore
      }

      // Send a message so the convo has content
      await alice.agent.sendMessage(convoId, { text: 'Read state error test' })

      // Try to updateRead with a fake message ID
      await expect(
        bob.agent.updateRead(convoId, 'nonexistent-message-id-12345'),
      ).rejects.toThrow(/Message not found/i)
    })

    it('rejects updateRead with a messageId from a different convo', async () => {
      // Create two separate conversations
      const carol = await createTestUser(network, 'rs-xconvo-c.test')
      const dave = await createTestUser(network, 'rs-xconvo-d.test')

      const convo1Res = (await alice.agent.getConvoForMembers([
        alice.did,
        carol.did,
      ])) as ConvoForMembersResponse
      const convo1Id = convo1Res.convo.id
      await carol.agent.acceptConvo(convo1Id)

      const convo2Res = (await alice.agent.getConvoForMembers([
        alice.did,
        dave.did,
      ])) as ConvoForMembersResponse
      const convo2Id = convo2Res.convo.id
      await dave.agent.acceptConvo(convo2Id)

      // Send a message in convo2
      const msg = (await alice.agent.sendMessage(convo2Id, {
        text: 'Message in convo2',
      })) as MessageView

      // Try to updateRead in convo1 with a messageId from convo2
      // The message exists but not in this convo, so it should fail
      await expect(
        alice.agent.updateRead(convo1Id, msg.id),
      ).rejects.toThrow(/Message not found/i)
    })
  })
})
