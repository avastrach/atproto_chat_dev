import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  createTestNetwork,
  createTestUser,
  createBlock,
} from './_util'

/**
 * Coverage gaps batch 2 — E2E API tests for gaps #6, #8, #12, #13.
 *
 * Sections:
 * A. Mark as Read — updateRead and updateAllRead (Gap #6)
 * B. Message Send Failure / Error Paths (Gap #8)
 * C. RichText Links / Facets (Gap #12)
 * D. Reject and Block from Chat Requests (Gap #13)
 *
 * References:
 * - docs/plans/chat-e2e-coverage-gaps.md
 * - PRD 16.7.7 (Marking Messages as Read)
 * - PRD 16.7.12 (Mark All as Read)
 * - PRD 16.7.3 (Sending a Message)
 * - PRD 16.7.10 (Leaving a Conversation)
 * - Service: read-state.ts, message.ts
 */

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

interface ConvoView {
  id: string
  rev: string
  members: Array<{ did: string }>
  status: string
  unreadCount: number
  lastMessage?: MessageView
}

interface MessageView {
  id: string
  rev: string
  text: string
  sender: { did: string }
  sentAt: string
  $type?: string
  facets?: unknown[]
  embed?: unknown
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

interface GetConvoResponse {
  convo: ConvoView
}

interface ListConvosResponse {
  convos: ConvoView[]
  cursor?: string
}

interface UpdateReadResponse {
  convo: ConvoView
}

interface UpdateAllReadResponse {
  updatedCount: number
}

interface GetMessagesResponse {
  messages: MessageView[]
  cursor?: string
}

// =========================================================================
// SECTION A: Mark as Read — updateRead and updateAllRead (Gap #6)
// =========================================================================

describe('coverage gaps batch 2 — mark as read (gap #6)', () => {
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

  it('updateRead marks specific conversation as read — unreadCount goes to 0', async () => {
    // Create convo and accept it
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

    // Mark as read first to start clean
    await bob.agent.updateRead(convoId)

    // Alice sends a message to Bob
    await alice.agent.sendMessage(convoId, {
      text: 'Gap6 updateRead test message',
    })

    // Bob's listConvos should show unreadCount > 0
    const bobListBefore = (await bob.agent.listConvos()) as ListConvosResponse
    const bobConvoBefore = bobListBefore.convos.find((c) => c.id === convoId)
    expect(bobConvoBefore).toBeDefined()
    expect(bobConvoBefore!.unreadCount).toBeGreaterThan(0)

    // Bob calls updateRead(convoId)
    const updateRes = (await bob.agent.updateRead(
      convoId,
    )) as UpdateReadResponse
    expect(updateRes.convo.unreadCount).toBe(0)

    // Bob's listConvos should now show unreadCount = 0
    const bobListAfter = (await bob.agent.listConvos()) as ListConvosResponse
    const bobConvoAfter = bobListAfter.convos.find((c) => c.id === convoId)
    expect(bobConvoAfter).toBeDefined()
    expect(bobConvoAfter!.unreadCount).toBe(0)
  })

  it('updateAllRead marks all conversations as read', async () => {
    // Create 3 convos with unread messages for bob
    const carol = await createTestUser(network, 'g6-carol.test')
    const dave = await createTestUser(network, 'g6-dave.test')
    const eve = await createTestUser(network, 'g6-eve.test')

    const convo1Res = (await carol.agent.getConvoForMembers([
      carol.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convo2Res = (await dave.agent.getConvoForMembers([
      dave.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convo3Res = (await eve.agent.getConvoForMembers([
      eve.did,
      bob.did,
    ])) as ConvoForMembersResponse

    // Bob accepts all convos
    await bob.agent.acceptConvo(convo1Res.convo.id)
    await bob.agent.acceptConvo(convo2Res.convo.id)
    await bob.agent.acceptConvo(convo3Res.convo.id)

    // Mark all as read first
    await bob.agent.updateRead(convo1Res.convo.id)
    await bob.agent.updateRead(convo2Res.convo.id)
    await bob.agent.updateRead(convo3Res.convo.id)

    // Send messages from each user to give bob unreads in all 3 convos
    await carol.agent.sendMessage(convo1Res.convo.id, {
      text: 'Gap6 unread from carol',
    })
    await dave.agent.sendMessage(convo2Res.convo.id, {
      text: 'Gap6 unread from dave',
    })
    await eve.agent.sendMessage(convo3Res.convo.id, {
      text: 'Gap6 unread from eve',
    })

    // Verify bob has unreads in all 3 convos
    const bob1 = (await bob.agent.getConvo(
      convo1Res.convo.id,
    )) as GetConvoResponse
    const bob2 = (await bob.agent.getConvo(
      convo2Res.convo.id,
    )) as GetConvoResponse
    const bob3 = (await bob.agent.getConvo(
      convo3Res.convo.id,
    )) as GetConvoResponse
    expect(bob1.convo.unreadCount).toBeGreaterThan(0)
    expect(bob2.convo.unreadCount).toBeGreaterThan(0)
    expect(bob3.convo.unreadCount).toBeGreaterThan(0)

    // Bob calls updateAllRead()
    const res = (await bob.agent.updateAllRead()) as UpdateAllReadResponse
    expect(res.updatedCount).toBeGreaterThanOrEqual(3)

    // Verify all 3 convos now have unreadCount = 0
    const bob1After = (await bob.agent.getConvo(
      convo1Res.convo.id,
    )) as GetConvoResponse
    const bob2After = (await bob.agent.getConvo(
      convo2Res.convo.id,
    )) as GetConvoResponse
    const bob3After = (await bob.agent.getConvo(
      convo3Res.convo.id,
    )) as GetConvoResponse
    expect(bob1After.convo.unreadCount).toBe(0)
    expect(bob2After.convo.unreadCount).toBe(0)
    expect(bob3After.convo.unreadCount).toBe(0)
  })

  it('updateAllRead with status=request only marks request convos as read', async () => {
    // Create an accepted convo for bob (bob is the initiator, so status=accepted)
    const acceptedPeer = await createTestUser(network, 'g6-acc.test')
    const acceptedConvoRes = (await bob.agent.getConvoForMembers([
      bob.did,
      acceptedPeer.did,
    ])) as ConvoForMembersResponse
    const acceptedConvoId = acceptedConvoRes.convo.id

    // Accept the convo from acceptedPeer's side
    await acceptedPeer.agent.acceptConvo(acceptedConvoId)
    await bob.agent.updateRead(acceptedConvoId)

    // Create a request convo for bob (someone else initiates, bob has status=request)
    const requestInitiator = await createTestUser(network, 'g6-req.test')
    const requestConvoRes = (await requestInitiator.agent.getConvoForMembers([
      requestInitiator.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const requestConvoId = requestConvoRes.convo.id

    // Verify bob's status is 'request' for the request convo
    const bobRequestView = (await bob.agent.getConvo(
      requestConvoId,
    )) as GetConvoResponse
    expect(bobRequestView.convo.status).toBe('request')

    // Send messages to both convos to give bob unreads
    await acceptedPeer.agent.sendMessage(acceptedConvoId, {
      text: 'Gap6 unread in accepted convo',
    })
    await requestInitiator.agent.sendMessage(requestConvoId, {
      text: 'Gap6 unread in request convo',
    })

    // Verify bob has unreads in both
    const bobAccBefore = (await bob.agent.getConvo(
      acceptedConvoId,
    )) as GetConvoResponse
    const bobReqBefore = (await bob.agent.getConvo(
      requestConvoId,
    )) as GetConvoResponse
    expect(bobAccBefore.convo.unreadCount).toBeGreaterThan(0)
    expect(bobReqBefore.convo.unreadCount).toBeGreaterThan(0)

    // Bob calls updateAllRead({ status: 'request' })
    const res = (await bob.agent.updateAllRead({
      status: 'request',
    })) as UpdateAllReadResponse
    expect(res.updatedCount).toBeGreaterThanOrEqual(1)

    // Request convo should be read
    const bobReqAfter = (await bob.agent.getConvo(
      requestConvoId,
    )) as GetConvoResponse
    expect(bobReqAfter.convo.unreadCount).toBe(0)

    // Accepted convo should STILL be unread
    const bobAccAfter = (await bob.agent.getConvo(
      acceptedConvoId,
    )) as GetConvoResponse
    expect(bobAccAfter.convo.unreadCount).toBeGreaterThan(0)

    // Clean up
    await bob.agent.updateAllRead()
  })
})

// =========================================================================
// SECTION B: Message Send Failure / Error Paths (Gap #8)
// =========================================================================

describe('coverage gaps batch 2 — message send errors (gap #8)', () => {
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

  it('sendMessage to non-existent convoId returns error', async () => {
    try {
      await alice.agent.sendMessage('nonexistent123', {
        text: 'This should fail',
      })
      fail('Expected sendMessage to throw')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/Convo not found/i)
    }
  })

  it('sendMessage with text exceeding 10000 bytes returns error', async () => {
    // Create a convo for the test
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

    // Use multi-byte characters to exceed 10000 bytes.
    // 4-byte emoji repeated 2501 times = 10004 bytes > 10000 limit.
    // This will also exceed the 1000 grapheme limit, so validation should
    // fail on either the byte or grapheme check.
    const oversizedText = '\u{1F600}'.repeat(2501)

    try {
      await alice.agent.sendMessage(convoId, { text: oversizedText })
      fail('Expected sendMessage to throw for oversized text')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/exceeds maximum/i)
    }
  })

  it('sendMessage with text exceeding 1000 graphemes returns error', async () => {
    // Create a convo for the test
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    // 1001 single-char graphemes = 1001 graphemes > 1000 limit but only 1001 bytes
    const longText = 'a'.repeat(1001)

    try {
      await alice.agent.sendMessage(convoId, { text: longText })
      fail('Expected sendMessage to throw for too many graphemes')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/exceeds maximum/i)
    }
  })
})

// =========================================================================
// SECTION C: RichText Links / Facets (Gap #12)
// =========================================================================

describe('coverage gaps batch 2 — richtext facets (gap #12)', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')

    // Create and accept a conversation
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)
  })

  afterAll(async () => {
    await network.close()
  })

  it('sendMessage with URL facets — facets are stored and returned', async () => {
    const text = 'Visit https://bsky.app for details'
    const facets = [
      {
        index: { byteStart: 6, byteEnd: 22 },
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: 'https://bsky.app',
          },
        ],
      },
    ]

    // Send the message with facets
    const sentMsg = (await alice.agent.sendMessage(convoId, {
      text,
      facets,
    })) as MessageView

    expect(sentMsg.id).toBeTruthy()
    expect(sentMsg.text).toBe(text)
    expect(sentMsg.facets).toBeDefined()
    expect(Array.isArray(sentMsg.facets)).toBe(true)
    expect(sentMsg.facets!.length).toBe(1)

    // Verify facets are returned in getMessages
    const msgs = (await bob.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const found = msgs.messages.find((m) => m.id === sentMsg.id)
    expect(found).toBeDefined()
    expect(found!.facets).toBeDefined()
    expect(found!.facets!.length).toBe(1)

    const facet = found!.facets![0] as {
      index: { byteStart: number; byteEnd: number }
      features: Array<{ $type: string; uri?: string }>
    }
    expect(facet.index.byteStart).toBe(6)
    expect(facet.index.byteEnd).toBe(22)
    expect(facet.features[0].$type).toBe('app.bsky.richtext.facet#link')
    expect(facet.features[0].uri).toBe('https://bsky.app')
  })

  it('sendMessage with mention facet — facet is stored', async () => {
    const text = '@Bob check this out'
    const facets = [
      {
        index: { byteStart: 0, byteEnd: 4 },
        features: [
          {
            $type: 'app.bsky.richtext.facet#mention',
            did: bob.did,
          },
        ],
      },
    ]

    // Send the message with mention facet
    const sentMsg = (await alice.agent.sendMessage(convoId, {
      text,
      facets,
    })) as MessageView

    expect(sentMsg.id).toBeTruthy()
    expect(sentMsg.text).toBe(text)
    expect(sentMsg.facets).toBeDefined()
    expect(sentMsg.facets!.length).toBe(1)

    // Verify facet is returned in getMessages
    const msgs = (await bob.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const found = msgs.messages.find((m) => m.id === sentMsg.id)
    expect(found).toBeDefined()
    expect(found!.facets).toBeDefined()
    expect(found!.facets!.length).toBe(1)

    const facet = found!.facets![0] as {
      index: { byteStart: number; byteEnd: number }
      features: Array<{ $type: string; did?: string }>
    }
    expect(facet.features[0].$type).toBe('app.bsky.richtext.facet#mention')
    expect(facet.features[0].did).toBe(bob.did)
  })
})

// =========================================================================
// SECTION D: Reject and Block from Chat Requests (Gap #13)
// =========================================================================

describe('coverage gaps batch 2 — reject and block from requests (gap #13)', () => {
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

  it('leaveConvo removes conversation from user list', async () => {
    // Create a convo and have alice send a message
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

    await alice.agent.sendMessage(convoId, { text: 'Gap13 leave test msg' })

    // Bob calls leaveConvo
    await bob.agent.leaveConvo(convoId)

    // Bob listConvos should no longer include the convo
    const bobList = (await bob.agent.listConvos()) as ListConvosResponse
    const bobConvoIds = bobList.convos.map((c) => c.id)
    expect(bobConvoIds).not.toContain(convoId)

    // Alice listConvos should still include the convo
    const aliceList = (await alice.agent.listConvos()) as ListConvosResponse
    const aliceConvoIds = aliceList.convos.map((c) => c.id)
    expect(aliceConvoIds).toContain(convoId)
  })

  it('leaveConvo + block — both convo removed and user blocked', async () => {
    // Create fresh users for a clean block test
    const blocker = await createTestUser(network, 'g13-blkr.test')
    const blocked = await createTestUser(network, 'g13-blkd.test')

    // Create convo: blocked initiates with blocker
    const convoRes = (await blocked.agent.getConvoForMembers([
      blocked.did,
      blocker.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    await blocker.agent.acceptConvo(convoId)
    await blocked.agent.sendMessage(convoId, {
      text: 'Gap13 block test msg',
    })

    // Blocker leaves the convo
    await blocker.agent.leaveConvo(convoId)

    // Blocker blocks the other user
    await createBlock(network, blocker, blocked)

    // Verify: blocker's convo list is empty for this convo
    const blockerList = (await blocker.agent.listConvos()) as ListConvosResponse
    const blockerConvoIds = blockerList.convos.map((c) => c.id)
    expect(blockerConvoIds).not.toContain(convoId)

    // Verify: blocked user cannot start new convo with blocker
    // (getConvoAvailability should return canChat=false)
    const availRes = (await blocked.agent.getConvoAvailability([
      blocker.did,
    ])) as { canChat: boolean }
    expect(availRes.canChat).toBe(false)
  })

  it('leaveConvo on request status convo — delete without accept', async () => {
    // Create fresh users for a clean request-leave test
    const sender = await createTestUser(network, 'g13-snd.test')
    const receiver = await createTestUser(network, 'g13-rcv.test')

    // Sender creates convo with receiver by sending a message
    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      receiver.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    await sender.agent.sendMessage(convoId, {
      text: 'Gap13 request leave test msg',
    })

    // Verify receiver has status=request
    const receiverView = (await receiver.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(receiverView.convo.status).toBe('request')

    // Receiver calls leaveConvo directly (without accepting first)
    await receiver.agent.leaveConvo(convoId)

    // Verify: convo removed from receiver's list
    const receiverList =
      (await receiver.agent.listConvos()) as ListConvosResponse
    const receiverConvoIds = receiverList.convos.map((c) => c.id)
    expect(receiverConvoIds).not.toContain(convoId)
  })
})
