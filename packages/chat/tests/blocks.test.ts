import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  createTestNetwork,
  createTestUser,
  createBlock,
  removeBlock,
} from './_util'

/**
 * Block enforcement E2E tests.
 *
 * Covers:
 * - Blocked user cannot send a message
 * - Blocked user cannot create a new conversation
 * - Blocking user cannot send to the blocked user (bidirectional)
 * - Existing conversations remain accessible after a block
 * - Unblocking restores the ability to message
 * - Blocking one user does not affect conversations with other users
 * - Block applied during an active conversation prevents subsequent sends
 * - Batch send fails if any recipient is blocked
 *
 * References:
 * - PRD 17.7 (Authorization & Privacy Checks)
 * - PRD 17.7.1 (checkCanInitiateConvo -- block check)
 * - PRD 17.6.2 (sendMessage -- block check before insert)
 * - PRD 17.6.10 (sendMessageBatch -- block check per item)
 * - Error code 12: "block between recipient and sender"
 * - Frontend: agent.ts -- expects exact string "block between recipient and sender"
 */

// Type helpers for casting XRPC responses
interface ConvoView {
  id: string
  rev: string
  members: Array<{ did: string }>
  status: string
  unreadCount: number
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

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface SendMessageBatchResponse {
  items: MessageView[]
}

describe('block enforcement', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
    carol = await createTestUser(network, 'carol.test')
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // Blocked user cannot send message
  // -----------------------------------------------------------------------

  it('blocked user cannot send message', async () => {
    // Alice and Bob create a conversation and exchange a message
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    await bob.agent.acceptConvo(convoId)

    // Verify messaging works before the block
    const msg = (await bob.agent.sendMessage(convoId, {
      text: 'Before block',
    })) as MessageView
    expect(msg.id).toBeTruthy()

    // Alice blocks Bob
    const blockRef = await createBlock(network, alice, bob)

    // Bob (the blocked user) tries to send a message -- should fail
    await expect(
      bob.agent.sendMessage(convoId, { text: 'After block' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Clean up
    await removeBlock(network, alice, blockRef)
  })

  // -----------------------------------------------------------------------
  // Blocked user cannot create new conversation
  // -----------------------------------------------------------------------

  it('blocked user cannot create new conversation', async () => {
    // Create fresh users for isolation
    const dan = await createTestUser(network, 'dan.test')
    const eve = await createTestUser(network, 'eve.test')

    // Dan blocks Eve before any conversation exists
    const blockRef = await createBlock(network, dan, eve)

    // Eve (blocked) tries to start a conversation with Dan
    await expect(
      eve.agent.getConvoForMembers([eve.did, dan.did]),
    ).rejects.toThrow(/block between recipient and sender/)

    // Clean up
    await removeBlock(network, dan, blockRef)
  })

  // -----------------------------------------------------------------------
  // Blocking user cannot send to blocked (bidirectional)
  // -----------------------------------------------------------------------

  it('blocking user cannot send to blocked', async () => {
    // Create fresh users for isolation
    const frank = await createTestUser(network, 'frank.test')
    const grace = await createTestUser(network, 'grace.test')

    // Create a conversation and accept it
    const convoRes = (await frank.agent.getConvoForMembers([
      frank.did,
      grace.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await grace.agent.acceptConvo(convoId)

    // Frank blocks Grace
    const blockRef = await createBlock(network, frank, grace)

    // Frank (the blocker) also cannot send to Grace
    await expect(
      frank.agent.sendMessage(convoId, { text: 'Blocker trying to send' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Grace (the blocked) also cannot send to Frank
    await expect(
      grace.agent.sendMessage(convoId, { text: 'Blocked trying to send' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Clean up
    await removeBlock(network, frank, blockRef)
  })

  // -----------------------------------------------------------------------
  // Existing conversation still accessible after block
  // -----------------------------------------------------------------------

  it('existing conversation still accessible after block', async () => {
    // Alice and Bob already have a conversation from earlier tests
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    // Alice blocks Bob
    const blockRef = await createBlock(network, alice, bob)

    // Both users can still view the conversation via getConvo
    const aliceView = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceView.convo.id).toBe(convoId)
    expect(aliceView.convo.members).toHaveLength(2)

    const bobView = (await bob.agent.getConvo(convoId)) as GetConvoResponse
    expect(bobView.convo.id).toBe(convoId)
    expect(bobView.convo.members).toHaveLength(2)

    // Both users can still see the conversation in listConvos
    const aliceList = (await alice.agent.listConvos()) as ListConvosResponse
    const aliceConvoIds = aliceList.convos.map((c) => c.id)
    expect(aliceConvoIds).toContain(convoId)

    const bobList = (await bob.agent.listConvos()) as ListConvosResponse
    const bobConvoIds = bobList.convos.map((c) => c.id)
    expect(bobConvoIds).toContain(convoId)

    // Clean up
    await removeBlock(network, alice, blockRef)
  })

  // -----------------------------------------------------------------------
  // Unblocking restores ability to message
  // -----------------------------------------------------------------------

  it('unblocking restores ability to message', async () => {
    // Create fresh users for isolation
    const henry = await createTestUser(network, 'henry.test')
    const iris = await createTestUser(network, 'iris.test')

    // Create a conversation
    const convoRes = (await henry.agent.getConvoForMembers([
      henry.did,
      iris.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await iris.agent.acceptConvo(convoId)

    // Henry blocks Iris
    const blockRef = await createBlock(network, henry, iris)

    // Both cannot send
    await expect(
      iris.agent.sendMessage(convoId, { text: 'While blocked' }),
    ).rejects.toThrow(/block between recipient and sender/)

    await expect(
      henry.agent.sendMessage(convoId, { text: 'While blocked too' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Henry unblocks Iris
    await removeBlock(network, henry, blockRef)

    // Now both can send again
    const irisMsg = (await iris.agent.sendMessage(convoId, {
      text: 'After unblock from Iris',
    })) as MessageView
    expect(irisMsg.id).toBeTruthy()
    expect(irisMsg.text).toBe('After unblock from Iris')

    const henryMsg = (await henry.agent.sendMessage(convoId, {
      text: 'After unblock from Henry',
    })) as MessageView
    expect(henryMsg.id).toBeTruthy()
    expect(henryMsg.text).toBe('After unblock from Henry')
  })

  // -----------------------------------------------------------------------
  // Block does not affect other conversations
  // -----------------------------------------------------------------------

  it('block does not affect other conversations', async () => {
    // Alice has conversations with Bob and Carol
    const aliceBobRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const aliceBobConvoId = aliceBobRes.convo.id

    const aliceCarolRes = (await alice.agent.getConvoForMembers([
      alice.did,
      carol.did,
    ])) as ConvoForMembersResponse
    const aliceCarolConvoId = aliceCarolRes.convo.id
    await carol.agent.acceptConvo(aliceCarolConvoId)

    // Alice blocks Bob
    const blockRef = await createBlock(network, alice, bob)

    // Alice cannot send to Bob
    await expect(
      alice.agent.sendMessage(aliceBobConvoId, {
        text: 'Should fail - blocked',
      }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Alice CAN still send to Carol -- block with Bob has no effect
    const carolMsg = (await alice.agent.sendMessage(aliceCarolConvoId, {
      text: 'Still works with Carol',
    })) as MessageView
    expect(carolMsg.id).toBeTruthy()
    expect(carolMsg.text).toBe('Still works with Carol')

    // Carol can also send to Alice
    const carolReply = (await carol.agent.sendMessage(aliceCarolConvoId, {
      text: 'Carol replies to Alice',
    })) as MessageView
    expect(carolReply.id).toBeTruthy()

    // Clean up
    await removeBlock(network, alice, blockRef)
  })

  // -----------------------------------------------------------------------
  // Block during active conversation
  // -----------------------------------------------------------------------

  it('block during active conversation', async () => {
    // Create fresh users for isolation
    const jack = await createTestUser(network, 'jack.test')
    const kate = await createTestUser(network, 'kate.test')

    // Create a conversation and send some messages
    const convoRes = (await jack.agent.getConvoForMembers([
      jack.did,
      kate.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await kate.agent.acceptConvo(convoId)

    // Messaging works before block
    const msg1 = (await jack.agent.sendMessage(convoId, {
      text: 'Message 1 - before block',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    const msg2 = (await kate.agent.sendMessage(convoId, {
      text: 'Message 2 - before block',
    })) as MessageView
    expect(msg2.id).toBeTruthy()

    // Jack blocks Kate mid-flow
    const blockRef = await createBlock(network, jack, kate)

    // Next send from either user fails
    await expect(
      jack.agent.sendMessage(convoId, { text: 'Message 3 - after block' }),
    ).rejects.toThrow(/block between recipient and sender/)

    await expect(
      kate.agent.sendMessage(convoId, { text: 'Message 4 - after block' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Messages sent before the block are still visible
    const jackMsgs = (await jack.agent.getMessages(convoId)) as {
      messages: MessageView[]
    }
    const texts = jackMsgs.messages
      .filter((m): m is MessageView => 'text' in m)
      .map((m) => m.text)
    expect(texts).toContain('Message 1 - before block')
    expect(texts).toContain('Message 2 - before block')

    // Clean up
    await removeBlock(network, jack, blockRef)
  })

  // -----------------------------------------------------------------------
  // Batch send fails if any recipient is blocked
  // -----------------------------------------------------------------------

  it('batch send fails if any recipient is blocked', async () => {
    // Create fresh users for isolation
    const leo = await createTestUser(network, 'leo.test')
    const mia = await createTestUser(network, 'mia.test')
    const nina = await createTestUser(network, 'nina.test')

    // Leo has conversations with both Mia and Nina
    const leoMiaRes = (await leo.agent.getConvoForMembers([
      leo.did,
      mia.did,
    ])) as ConvoForMembersResponse
    const leoMiaConvoId = leoMiaRes.convo.id
    await mia.agent.acceptConvo(leoMiaConvoId)

    const leoNinaRes = (await leo.agent.getConvoForMembers([
      leo.did,
      nina.did,
    ])) as ConvoForMembersResponse
    const leoNinaConvoId = leoNinaRes.convo.id
    await nina.agent.acceptConvo(leoNinaConvoId)

    // Mia blocks Leo
    const blockRef = await createBlock(network, mia, leo)

    // Leo tries a batch send to both conversations -- should fail because
    // the Mia conversation has a block (the entire batch is rejected)
    await expect(
      leo.agent.sendMessageBatch([
        { convoId: leoMiaConvoId, message: { text: 'Batch to Mia' } },
        { convoId: leoNinaConvoId, message: { text: 'Batch to Nina' } },
      ]),
    ).rejects.toThrow(/block between recipient and sender/)

    // Verify that a batch send to only the unblocked conversation succeeds
    const batchRes = (await leo.agent.sendMessageBatch([
      { convoId: leoNinaConvoId, message: { text: 'Batch to Nina only' } },
    ])) as SendMessageBatchResponse
    expect(batchRes.items).toHaveLength(1)
    expect(batchRes.items[0].text).toBe('Batch to Nina only')

    // Clean up
    await removeBlock(network, mia, blockRef)
  })
})
