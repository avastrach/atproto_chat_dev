import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createBlock,
  createModServiceClient,
  setChatDisabled,
  setAllowIncoming,
} from './_util'

/**
 * Coverage gaps batch 3 — E2E API tests for gaps #10, #14, #15, #16.
 *
 * Sections:
 * A. Report / Moderation Context — getMessageContext & getActorMetadata (Gap #10)
 * B. Emoji-Only Messages (Gap #14)
 * C. Convo Availability Check — getConvoAvailability (Gap #15)
 * D. Chat Disabled / Access Control (Gap #16)
 *
 * References:
 * - docs/plans/chat-e2e-coverage-gaps.md
 * - PRD 17.6.18 (getActorMetadata)
 * - PRD 17.6.19 (getMessageContext)
 * - PRD 17.6.20 (updateActorAccess)
 * - PRD 14.1 (chatDisabled Flag Detection)
 * - Service: moderation.ts, conversation.ts, privacy.ts
 */

// ---------------------------------------------------------------------------
// Type helpers for casting XRPC responses
// ---------------------------------------------------------------------------

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

interface GetMessagesResponse {
  messages: MessageView[]
  cursor?: string
}

interface ActorMetadataPeriod {
  messagesSent: number
  messagesReceived: number
  convos: number
  convosStarted: number
}

interface ActorMetadataResponse {
  day: ActorMetadataPeriod
  month: ActorMetadataPeriod
  all: ActorMetadataPeriod
}

interface GetMessageContextResponse {
  messages: Array<MessageView | { id: string; sender: { did: string } }>
}

interface ConvoAvailabilityResponse {
  canChat: boolean
  convo?: ConvoView
}

// ===========================================================================
// SECTION A: Report / Moderation Context (Gap #10)
// ===========================================================================

describe('coverage gaps batch 3 — report / moderation context (gap #10)', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let modClient: ChatApiClient
  let convoId: string
  let messageIds: string[]

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'g10-alice.test')
    bob = await createTestUser(network, 'g10-bob.test')
    modClient = await createModServiceClient(network)

    // Create conversation and accept it
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Send 10 messages in order for context testing
    messageIds = []
    for (let i = 1; i <= 10; i++) {
      const sender = i % 2 === 1 ? alice : bob
      const res = (await sender.agent.sendMessage(convoId, {
        text: `Context message ${i}`,
      })) as MessageView
      messageIds.push(res.id)
    }
  })

  afterAll(async () => {
    await network.close()
  })

  it('getMessageContext returns surrounding messages', async () => {
    // Target is messageIds[4] = "Context message 5" (middle of 10)
    const targetId = messageIds[4]
    const result =
      (await modClient.getMessageContext(targetId)) as GetMessageContextResponse

    expect(result.messages).toBeDefined()
    expect(result.messages.length).toBeGreaterThanOrEqual(3)

    // Target message should be present
    const target = result.messages.find((m) => m.id === targetId)
    expect(target).toBeDefined()
    expect('text' in target!).toBe(true)
    expect((target as MessageView).text).toBe('Context message 5')

    // Should include messages before the target
    const beforeIds = result.messages
      .filter((m) => m.id < targetId)
      .map((m) => m.id)
    expect(beforeIds.length).toBeGreaterThan(0)

    // Should include messages after the target
    const afterIds = result.messages
      .filter((m) => m.id > targetId)
      .map((m) => m.id)
    expect(afterIds.length).toBeGreaterThan(0)
  })

  it('getMessageContext with before=2 after=3 returns correct window', async () => {
    // Target is messageIds[4] = "Context message 5"
    // before=2 should give messageIds[2] and messageIds[3]
    // after=3 should give messageIds[5], messageIds[6], messageIds[7]
    const targetId = messageIds[4]

    const result = (await modClient.getMessageContext(targetId, {
      before: 2,
      after: 3,
    })) as GetMessageContextResponse

    // 2 before + target + 3 after = 6
    expect(result.messages).toHaveLength(6)

    // Verify exact messages returned in chronological order
    expect(result.messages[0].id).toBe(messageIds[2])
    expect(result.messages[1].id).toBe(messageIds[3])
    expect(result.messages[2].id).toBe(targetId)
    expect(result.messages[3].id).toBe(messageIds[5])
    expect(result.messages[4].id).toBe(messageIds[6])
    expect(result.messages[5].id).toBe(messageIds[7])

    // Verify chronological order (ascending by ID)
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i].id > result.messages[i - 1].id).toBe(true)
    }
  })

  it('getActorMetadata returns chat activity stats', async () => {
    // Alice sent messages 1, 3, 5, 7, 9 (5 messages)
    // Bob sent messages 2, 4, 6, 8, 10 (5 messages)
    const metadata =
      (await modClient.getActorMetadata(alice.did)) as ActorMetadataResponse

    expect(metadata.all).toBeDefined()
    expect(metadata.day).toBeDefined()
    expect(metadata.month).toBeDefined()

    // Alice sent 5 messages
    expect(metadata.all.messagesSent).toBeGreaterThanOrEqual(5)
    expect(metadata.day.messagesSent).toBeGreaterThanOrEqual(5)
    expect(metadata.month.messagesSent).toBeGreaterThanOrEqual(5)

    // Alice received 5 messages from Bob
    expect(metadata.all.messagesReceived).toBeGreaterThanOrEqual(5)

    // Alice is in at least 1 conversation
    expect(metadata.all.convos).toBeGreaterThanOrEqual(1)

    // Alice started the conversation (she called getConvoForMembers first)
    expect(metadata.all.convosStarted).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// SECTION B: Emoji-Only Messages (Gap #14)
// ===========================================================================

describe('coverage gaps batch 3 — emoji-only messages (gap #14)', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'g14-alice.test')
    bob = await createTestUser(network, 'g14-bob.test')

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

  it('sendMessage with only emoji characters — stores and retrieves correctly', async () => {
    const emojiTexts = ['\u{1F600}', '\u{1F44D}\u{1F389}\u{1F525}', '\u{1F1FA}\u{1F1F8}']

    for (const emojiText of emojiTexts) {
      const sent = (await alice.agent.sendMessage(convoId, {
        text: emojiText,
      })) as MessageView

      expect(sent.id).toBeTruthy()
      expect(sent.text).toBe(emojiText)

      // Verify via getMessages that the emoji text is preserved
      const msgs = (await bob.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const found = msgs.messages.find((m) => m.id === sent.id)
      expect(found).toBeDefined()
      expect(found!.text).toBe(emojiText)
    }
  })

  it('sendMessage with mixed emoji and text — normal message', async () => {
    const mixedText = 'Hello \u{1F44B} World \u{1F30D}'

    const sent = (await alice.agent.sendMessage(convoId, {
      text: mixedText,
    })) as MessageView

    expect(sent.id).toBeTruthy()
    expect(sent.text).toBe(mixedText)

    // Verify via getMessages
    const msgs = (await bob.agent.getMessages(convoId)) as GetMessagesResponse
    const found = msgs.messages.find((m) => m.id === sent.id)
    expect(found).toBeDefined()
    expect(found!.text).toBe(mixedText)
  })
})

// ===========================================================================
// SECTION C: Convo Availability Check (Gap #15)
// ===========================================================================

describe('coverage gaps batch 3 — convo availability (gap #15)', () => {
  let network: TestNetwork

  beforeAll(async () => {
    network = await createTestNetwork()
  })

  afterAll(async () => {
    await network.close()
  })

  it('getConvoAvailability with valid members — canChat is true', async () => {
    const alice = await createTestUser(network, 'g15-avail-a.test')
    const bob = await createTestUser(network, 'g15-avail-b.test')

    // Both users have allowIncoming='all' (default from createTestUser)
    const result = (await alice.agent.getConvoAvailability([
      alice.did,
      bob.did,
    ])) as ConvoAvailabilityResponse

    expect(result.canChat).toBe(true)
  })

  it('getConvoAvailability when convo exists — returns convo object', async () => {
    const alice = await createTestUser(network, 'g15-exist-a.test')
    const bob = await createTestUser(network, 'g15-exist-b.test')

    // Create the convo first
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    // Now check availability — should return the existing convo
    const result = (await alice.agent.getConvoAvailability([
      alice.did,
      bob.did,
    ])) as ConvoAvailabilityResponse

    expect(result.canChat).toBe(true)
    expect(result.convo).toBeDefined()
    expect(result.convo!.id).toBe(convoId)
  })

  it('getConvoAvailability with block — canChat is false', async () => {
    const alice = await createTestUser(network, 'g15-block-a.test')
    const bob = await createTestUser(network, 'g15-block-b.test')

    // Alice blocks Bob
    await createBlock(network, alice, bob)

    // Check availability — should be false due to block
    const result = (await alice.agent.getConvoAvailability([
      alice.did,
      bob.did,
    ])) as ConvoAvailabilityResponse

    expect(result.canChat).toBe(false)
  })

  it('getConvoAvailability with allowIncoming=none — canChat is false', async () => {
    const alice = await createTestUser(network, 'g15-none-a.test')
    const bob = await createTestUser(network, 'g15-none-b.test')

    // Bob sets allowIncoming to 'none'
    await setAllowIncoming(bob.agent, 'none')

    // Alice checks availability — should be false because Bob has allowIncoming=none
    const result = (await alice.agent.getConvoAvailability([
      alice.did,
      bob.did,
    ])) as ConvoAvailabilityResponse

    expect(result.canChat).toBe(false)
  })
})

// ===========================================================================
// SECTION D: Chat Disabled / Access Control (Gap #16)
// ===========================================================================

describe('coverage gaps batch 3 — chat disabled / access control (gap #16)', () => {
  let network: TestNetwork
  let modClient: ChatApiClient

  beforeAll(async () => {
    network = await createTestNetwork()
    modClient = await createModServiceClient(network)
  })

  afterAll(async () => {
    await network.close()
  })

  it('disabled user cannot send messages', async () => {
    const alice = await createTestUser(network, 'g16-dis-a.test')
    const bob = await createTestUser(network, 'g16-dis-b.test')

    // Create conversation and accept it
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Verify Alice can send before disabling
    const msg1 = (await alice.agent.sendMessage(convoId, {
      text: 'Before disable',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Mod disables Alice via updateActorAccess(alice.did, false)
    await setChatDisabled(modClient, alice.did, true)

    // Alice tries to send — should fail
    await expect(
      alice.agent.sendMessage(convoId, { text: 'After disable' }),
    ).rejects.toThrow(/Account is disabled/)
  })

  it('disabled user cannot start new conversations', async () => {
    const alice = await createTestUser(network, 'g16-newc-a.test')
    const bob = await createTestUser(network, 'g16-newc-b.test')

    // Mod disables Alice before she creates any conversation
    await setChatDisabled(modClient, alice.did, true)

    // Alice tries to start a new conversation — should fail
    // getConvoForMembers calls checkCanInitiateConvo which checks chatDisabled
    await expect(
      alice.agent.getConvoForMembers([alice.did, bob.did]),
    ).rejects.toThrow(/Account is disabled/)
  })

  it('re-enabling access allows messages again', async () => {
    const alice = await createTestUser(network, 'g16-reen-a.test')
    const bob = await createTestUser(network, 'g16-reen-b.test')

    // Create conversation and accept it
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Verify Alice can send
    const msg1 = (await alice.agent.sendMessage(convoId, {
      text: 'Before disable',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Mod disables Alice
    await setChatDisabled(modClient, alice.did, true)

    // Confirm she cannot send
    await expect(
      alice.agent.sendMessage(convoId, { text: 'While disabled' }),
    ).rejects.toThrow(/Account is disabled/)

    // Mod re-enables Alice via updateActorAccess(alice.did, true)
    await setChatDisabled(modClient, alice.did, false)

    // Alice can now send messages again
    const msg2 = (await alice.agent.sendMessage(convoId, {
      text: 'After re-enable',
    })) as MessageView
    expect(msg2.id).toBeTruthy()
    expect(msg2.text).toBe('After re-enable')
  })
})
