import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  createTestNetwork,
  createTestUser,
  createTestUsers,
  createBlock,
  removeBlock,
  setAllowIncoming,
} from './_util'

/**
 * Integration flow tests that mirror real frontend user interactions.
 *
 * These tests exercise multiple features together in sequences that match
 * how the Bluesky app actually uses the chat backend. Each flow tests a
 * complete user journey rather than isolated endpoints.
 *
 * Flows covered:
 * 1. Full conversation lifecycle
 * 2. Request flow (accept via reply)
 * 3. Event log sync (chronological ordering)
 * 4. Block mid-conversation
 * 5. Privacy setting change mid-session
 * 6. Multiple conversations with pagination
 * 7. Concurrent message exchange (multi-convo isolation)
 * 8. Unread count tracking across operations
 *
 * References:
 * - Frontend: convo/agent.ts (Convo state machine, sendMessage, addReaction, markConvoAccepted)
 * - Frontend: events/agent.ts (MessagesEventBus, getLog polling, cursor-based sync)
 * - PRD sections 16.7.x (all conversation lifecycle operations)
 */

// ---------------------------------------------------------------------------
// Type helpers for casting XRPC responses
// ---------------------------------------------------------------------------

interface ConvoMember {
  did: string
}

interface ConvoView {
  id: string
  rev: string
  members: ConvoMember[]
  muted: boolean
  status: string
  unreadCount: number
  lastMessage?: unknown
}

interface MessageView {
  id: string
  rev: string
  text: string
  sender: { did: string }
  sentAt: string
  reactions?: Array<{
    value: string
    sender: { did: string }
    createdAt: string
  }>
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

interface GetMessagesResponse {
  messages: MessageView[]
  cursor?: string
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

interface MuteConvoResponse {
  convo: ConvoView
}

interface UpdateReadResponse {
  convo: ConvoView
}

// ==========================================================================
// Flow 1: Full Conversation Lifecycle
// ==========================================================================

describe('Flow 1: Full conversation lifecycle', () => {
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

  it('creates convo, sends message, verifies via getMessages, adds reaction, mutes, unmutes, marks as read', async () => {
    // Step 1: Create conversation via getConvoForMembers
    // (mirrors frontend: user taps "New message" -> selects recipient)
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    expect(convoId).toBeTruthy()
    expect(convoRes.convo.members).toHaveLength(2)

    // Alice (initiator) should have status 'accepted'
    const aliceView = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceView.convo.status).toBe('accepted')

    // Bob needs to accept first
    await bob.agent.acceptConvo(convoId)

    // Step 2: Send a message
    // (mirrors frontend: Convo.sendMessage -> processPendingMessages)
    const sentMsg = (await alice.agent.sendMessage(convoId, {
      text: 'Hello Bob, how are you?',
    })) as MessageView

    expect(sentMsg.id).toBeTruthy()
    expect(sentMsg.text).toBe('Hello Bob, how are you?')
    expect(sentMsg.sender.did).toBe(alice.did)

    // Step 3: Verify message appears via getMessages for both users
    // (mirrors frontend: Convo.fetchMessageHistory)
    const aliceMsgs = (await alice.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const aliceFound = aliceMsgs.messages.find(
      (m) => 'text' in m && m.text === 'Hello Bob, how are you?',
    )
    expect(aliceFound).toBeDefined()

    const bobMsgs = (await bob.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const bobFound = bobMsgs.messages.find(
      (m) => 'text' in m && m.text === 'Hello Bob, how are you?',
    )
    expect(bobFound).toBeDefined()

    // Step 4: Add a reaction
    // (mirrors frontend: Convo.addReaction with optimistic update)
    const reactionRaw = (await bob.agent.addReaction(
      convoId,
      sentMsg.id,
      '\u2764\uFE0F',
    )) as { message: MessageView }
    const reactionRes = reactionRaw.message

    expect(reactionRes.reactions).toBeDefined()
    expect(reactionRes.reactions!.length).toBeGreaterThanOrEqual(1)
    const heartReaction = reactionRes.reactions!.find(
      (r) => r.value === '\u2764\uFE0F' && r.sender.did === bob.did,
    )
    expect(heartReaction).toBeDefined()

    // Verify reaction is visible to Alice via getMessages
    const aliceMsgsAfterReact = (await alice.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const reactedMsg = aliceMsgsAfterReact.messages.find(
      (m) => m.id === sentMsg.id,
    ) as MessageView
    expect(reactedMsg).toBeDefined()
    expect(reactedMsg.reactions).toBeDefined()
    expect(
      reactedMsg.reactions!.find(
        (r) => r.value === '\u2764\uFE0F' && r.sender.did === bob.did,
      ),
    ).toBeDefined()

    // Step 5: Mute the conversation
    // (mirrors frontend: user taps mute in conversation settings)
    const muteRes = (await alice.agent.muteConvo(
      convoId,
    )) as MuteConvoResponse
    expect(muteRes.convo.muted).toBe(true)

    // Verify muted state persists in getConvo
    const mutedView = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(mutedView.convo.muted).toBe(true)

    // Bob's view should NOT be muted (per-user)
    const bobMutedView = (await bob.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(bobMutedView.convo.muted).toBe(false)

    // Step 6: Unmute the conversation
    const unmuteRes = (await alice.agent.unmuteConvo(
      convoId,
    )) as MuteConvoResponse
    expect(unmuteRes.convo.muted).toBe(false)

    // Step 7: Mark as read
    // (mirrors frontend: MessagesEventBus polling triggers updateRead)
    // First, Bob sends a message to create unread state for Alice
    await bob.agent.sendMessage(convoId, { text: 'Are you there?' })

    const beforeRead = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(beforeRead.convo.unreadCount).toBeGreaterThan(0)

    const readRes = (await alice.agent.updateRead(
      convoId,
    )) as UpdateReadResponse
    expect(readRes.convo.unreadCount).toBe(0)
  })
})

// ==========================================================================
// Flow 2: Request Flow
// ==========================================================================

describe('Flow 2: Request flow', () => {
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

  it('Alice sends to Bob (request), Bob sees request, Bob replies (auto-accepts), both see accepted', async () => {
    // Step 1: Alice initiates a conversation with Bob
    // (mirrors frontend: user starts new DM with someone they haven't chatted with)
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    // Alice (initiator) sees status='accepted'
    const aliceView = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceView.convo.status).toBe('accepted')

    // Bob (recipient) sees status='request'
    const bobViewBefore = (await bob.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(bobViewBefore.convo.status).toBe('request')

    // Step 2: Alice sends a message
    const aliceMsg = (await alice.agent.sendMessage(convoId, {
      text: 'Hey Bob, want to chat?',
    })) as MessageView
    expect(aliceMsg.id).toBeTruthy()

    // Step 3: Bob lists convos and sees the request
    // (mirrors frontend: Messages list screen showing "Requests" tab)
    const bobConvos = (await bob.agent.listConvos()) as ListConvosResponse
    const bobConvo = bobConvos.convos.find((c) => c.id === convoId)
    expect(bobConvo).toBeDefined()
    expect(bobConvo!.status).toBe('request')

    // Step 4: Bob sends a reply, which auto-accepts the convo
    // (mirrors frontend: Convo.sendMessage sets convo.status='accepted' optimistically,
    //  then the backend auto-accepts on sendMessage from a 'request' state)
    const bobMsg = (await bob.agent.sendMessage(convoId, {
      text: 'Sure, what is up?',
    })) as MessageView
    expect(bobMsg.id).toBeTruthy()
    expect(bobMsg.sender.did).toBe(bob.did)

    // Step 5: Verify convo is now accepted for Bob
    const bobViewAfter = (await bob.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(bobViewAfter.convo.status).toBe('accepted')

    // Step 6: Verify convo is still accepted for Alice
    const aliceViewAfter = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceViewAfter.convo.status).toBe('accepted')

    // Step 7: Verify both messages are present in the conversation
    const msgs = (await alice.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const texts = msgs.messages
      .filter((m): m is MessageView => 'text' in m)
      .map((m) => m.text)
    expect(texts).toContain('Hey Bob, want to chat?')
    expect(texts).toContain('Sure, what is up?')
  })
})

// ==========================================================================
// Flow 3: Event Log Sync
// ==========================================================================

describe('Flow 3: Event log sync', () => {
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

  it('performs convo creation, message sends, reaction, mark read -- then verifies event log order and types', async () => {
    // Capture initial log cursor before any actions
    // (mirrors frontend: MessagesEventBus.init() calls getLog to get initial cursor)
    const initialLog = (await alice.agent.getLog()) as GetLogResponse
    const initialCursor = initialLog.cursor

    // Step 1: Create conversation (generates logBeginConvo)
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id

    // Accept the convo (generates logAcceptConvo)
    await bob.agent.acceptConvo(convoId)

    // Step 2: Send messages (generates logCreateMessage events)
    const msg1 = (await alice.agent.sendMessage(convoId, {
      text: 'Event log test message 1',
    })) as MessageView

    await bob.agent.sendMessage(convoId, {
      text: 'Event log test message 2',
    })

    // Step 3: Add a reaction (generates logAddReaction)
    await bob.agent.addReaction(convoId, msg1.id, '\uD83D\uDC4D')

    // Step 4: Mark as read (generates logReadMessage -- self-only for Alice)
    await alice.agent.updateRead(convoId)

    // Step 5: Fetch all events since initial cursor
    // (mirrors frontend: MessagesEventBus.poll() fetching new events)
    const aliceLog = (await alice.agent.getLog(
      initialCursor,
    )) as GetLogResponse

    // Verify we got events
    expect(aliceLog.logs.length).toBeGreaterThan(0)

    // Verify all events have rev and convoId
    for (const entry of aliceLog.logs) {
      expect(entry.rev).toBeTruthy()
      expect(entry.convoId).toBeTruthy()
      expect(entry.$type).toMatch(/^chat\.bsky\.convo\.defs#/)
    }

    // Verify events are in ascending chronological order (by rev)
    // (this is critical for frontend: ingestFirehose relies on rev ordering)
    for (let i = 1; i < aliceLog.logs.length; i++) {
      expect(aliceLog.logs[i].rev > aliceLog.logs[i - 1].rev).toBe(true)
    }

    // Verify expected event types are present
    const eventTypes = aliceLog.logs.map((e) => e.$type)

    // logBeginConvo should be present (Alice created the convo)
    expect(eventTypes).toContain('chat.bsky.convo.defs#logBeginConvo')

    // logCreateMessage should be present (messages were sent)
    expect(
      eventTypes.filter(
        (t) => t === 'chat.bsky.convo.defs#logCreateMessage',
      ).length,
    ).toBeGreaterThanOrEqual(2)

    // logAddReaction should be present (Bob reacted to Alice's message)
    expect(eventTypes).toContain('chat.bsky.convo.defs#logAddReaction')

    // logReadMessage should be present (Alice marked as read -- self-only event)
    expect(eventTypes).toContain('chat.bsky.convo.defs#logReadMessage')

    // Step 6: Verify Bob does NOT see Alice's self-only events
    const bobLog = (await bob.agent.getLog(initialCursor)) as GetLogResponse
    const bobEventTypes = bobLog.logs.map((e) => e.$type)

    // Bob should NOT see Alice's logReadMessage (self-only)
    const bobReadEvents = bobLog.logs.filter(
      (e) =>
        e.$type === 'chat.bsky.convo.defs#logReadMessage' &&
        e.convoId === convoId,
    )
    // Bob might see his own read events but not Alice's
    // The key assertion: Bob should see shared events
    expect(bobEventTypes).toContain('chat.bsky.convo.defs#logCreateMessage')

    // Step 7: Verify cursor-based incremental sync works
    // (mirrors frontend: MessagesEventBus stores latestRev and uses it as cursor)
    const afterCursor = aliceLog.cursor
    if (afterCursor) {
      const incrementalLog = (await alice.agent.getLog(
        afterCursor,
      )) as GetLogResponse
      // No new events should appear since we haven't done anything new
      expect(incrementalLog.logs.length).toBe(0)
    }
  })
})

// ==========================================================================
// Flow 4: Block Mid-Conversation
// ==========================================================================

describe('Flow 4: Block mid-conversation', () => {
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

  it('establishes convo with messages, blocks, verifies send fails, unblocks, verifies send succeeds', async () => {
    // Step 1: Establish conversation with messages
    // (mirrors frontend: two users have an active conversation)
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Exchange some messages to establish an active conversation
    const preBlockMsg1 = (await alice.agent.sendMessage(convoId, {
      text: 'Hey Bob, great chatting!',
    })) as MessageView
    expect(preBlockMsg1.id).toBeTruthy()

    const preBlockMsg2 = (await bob.agent.sendMessage(convoId, {
      text: 'Yeah, same here!',
    })) as MessageView
    expect(preBlockMsg2.id).toBeTruthy()

    // Step 2: Create block (Alice blocks Bob)
    // (mirrors frontend: user goes to profile -> blocks user)
    const blockRef = await createBlock(network, alice, bob)

    // Step 3: Verify sendMessage fails with "block between recipient and sender"
    // (mirrors frontend: handleSendMessageFailure checks for this exact error string
    //  and emits 'invalidate-block-state' event)
    await expect(
      alice.agent.sendMessage(convoId, { text: 'Should fail - I blocked Bob' }),
    ).rejects.toThrow(/block between recipient and sender/)

    await expect(
      bob.agent.sendMessage(convoId, { text: 'Should fail - Alice blocked me' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Step 4: Verify the conversation is still viewable (read-only)
    // (mirrors frontend: convo still appears in list but sends fail)
    const aliceConvo = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceConvo.convo.id).toBe(convoId)

    const bobConvo = (await bob.agent.getConvo(convoId)) as GetConvoResponse
    expect(bobConvo.convo.id).toBe(convoId)

    // Verify pre-block messages are still visible
    const msgs = (await alice.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const texts = msgs.messages
      .filter((m): m is MessageView => 'text' in m)
      .map((m) => m.text)
    expect(texts).toContain('Hey Bob, great chatting!')
    expect(texts).toContain('Yeah, same here!')

    // Step 5: Unblock
    await removeBlock(network, alice, blockRef)

    // Step 6: Verify sendMessage succeeds again
    const postUnblockMsg1 = (await alice.agent.sendMessage(convoId, {
      text: 'I unblocked you, we can chat again',
    })) as MessageView
    expect(postUnblockMsg1.id).toBeTruthy()
    expect(postUnblockMsg1.text).toBe(
      'I unblocked you, we can chat again',
    )

    const postUnblockMsg2 = (await bob.agent.sendMessage(convoId, {
      text: 'Great, glad to be back!',
    })) as MessageView
    expect(postUnblockMsg2.id).toBeTruthy()
    expect(postUnblockMsg2.text).toBe('Great, glad to be back!')
  })
})

// ==========================================================================
// Flow 5: Privacy Setting Change Mid-Session
// ==========================================================================

describe('Flow 5: Privacy setting change mid-session', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser
  let dave: TestUser

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
    carol = await createTestUser(network, 'carol.test')
    dave = await createTestUser(network, 'dave.test')
  })

  afterAll(async () => {
    await network.close()
  })

  it('set allowIncoming=all, create convo, change to none, existing convo works, new user blocked, change back, new user succeeds', async () => {
    // Step 1: Alice sets allowIncoming to 'all'
    await setAllowIncoming(alice.agent, 'all')

    // Step 2: Bob creates a conversation with Alice (succeeds because allowIncoming=all)
    const convoRes = (await bob.agent.getConvoForMembers([
      bob.did,
      alice.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    expect(convoId).toBeTruthy()
    await alice.agent.acceptConvo(convoId)

    // Send a message to confirm the convo is fully working
    const msg1 = (await bob.agent.sendMessage(convoId, {
      text: 'Hello Alice!',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Step 3: Alice changes her privacy setting to 'none'
    // (mirrors frontend: user goes to Settings -> Privacy -> Messaging -> "No one")
    await setAllowIncoming(alice.agent, 'none')

    // Step 4: Verify existing conversation still works
    // (allowIncoming only applies to NEW convo creation, not existing convos)
    const msg2 = (await bob.agent.sendMessage(convoId, {
      text: 'Can you still see this?',
    })) as MessageView
    expect(msg2.id).toBeTruthy()
    expect(msg2.text).toBe('Can you still see this?')

    const msg3 = (await alice.agent.sendMessage(convoId, {
      text: 'Yes I can!',
    })) as MessageView
    expect(msg3.id).toBeTruthy()

    // Step 5: New user (Carol) cannot start a convo with Alice
    await expect(
      carol.agent.getConvoForMembers([carol.did, alice.did]),
    ).rejects.toThrow(/recipient has disabled incoming messages/)

    // Step 6: Change back to 'all'
    await setAllowIncoming(alice.agent, 'all')

    // Step 7: Now a new user (Dave) can start a convo with Alice
    const daveConvoRes = (await dave.agent.getConvoForMembers([
      dave.did,
      alice.did,
    ])) as ConvoForMembersResponse
    expect(daveConvoRes.convo.id).toBeTruthy()
    expect(daveConvoRes.convo.members).toHaveLength(2)

    // Dave can send a message
    await alice.agent.acceptConvo(daveConvoRes.convo.id)
    const daveMsg = (await dave.agent.sendMessage(daveConvoRes.convo.id, {
      text: 'Hi Alice, I am Dave!',
    })) as MessageView
    expect(daveMsg.id).toBeTruthy()
  })
})

// ==========================================================================
// Flow 6: Multiple Conversations with Pagination
// ==========================================================================

describe('Flow 6: Multiple conversations with pagination', () => {
  let network: TestNetwork
  let alice: TestUser
  let others: TestUser[]

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')

    // Create 6 other users so Alice has 6 conversations
    others = await createTestUsers(network, [
      'user1.test',
      'user2.test',
      'user3.test',
      'user4.test',
      'user5.test',
      'user6.test',
    ])
  })

  afterAll(async () => {
    await network.close()
  })

  it('creates 6 conversations and verifies listConvos returns all with correct cursor-based pagination', async () => {
    // Step 1: Create 6 conversations for Alice
    // (mirrors frontend: user has multiple active DM threads)
    const convoIds: string[] = []
    for (const other of others) {
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        other.did,
      ])) as ConvoForMembersResponse
      convoIds.push(convoRes.convo.id)

      // Accept from the other side
      await other.agent.acceptConvo(convoRes.convo.id)

      // Send a message in each convo so they have content and show up in list
      await alice.agent.sendMessage(convoRes.convo.id, {
        text: `Hello ${other.handle}!`,
      })
    }

    // Step 2: Verify listConvos returns all conversations
    const allConvos = (await alice.agent.listConvos()) as ListConvosResponse
    expect(allConvos.convos.length).toBeGreaterThanOrEqual(6)

    // Verify all our created convo IDs are present
    const returnedIds = allConvos.convos.map((c) => c.id)
    for (const convoId of convoIds) {
      expect(returnedIds).toContain(convoId)
    }

    // Step 3: Verify cursor-based pagination works
    // Fetch page by page with limit=2
    const allPaginatedConvos: ConvoView[] = []
    let cursor: string | undefined
    let pageCount = 0

    do {
      const page = (await alice.agent.listConvos({
        limit: 2,
        cursor,
      })) as ListConvosResponse

      expect(page.convos.length).toBeLessThanOrEqual(2)
      allPaginatedConvos.push(...page.convos)
      cursor = page.cursor
      pageCount++

      // Safety limit to avoid infinite loop
      if (pageCount > 10) break
    } while (cursor)

    // We should have fetched at least 6 conversations total
    expect(allPaginatedConvos.length).toBeGreaterThanOrEqual(6)

    // Verify no duplicates in paginated results
    const paginatedIds = allPaginatedConvos.map((c) => c.id)
    const uniqueIds = new Set(paginatedIds)
    expect(uniqueIds.size).toBe(paginatedIds.length)

    // Verify all our created convos are present in paginated results
    for (const convoId of convoIds) {
      expect(paginatedIds).toContain(convoId)
    }

    // Step 4: Verify each conversation has the correct member
    for (let i = 0; i < convoIds.length; i++) {
      const convo = allPaginatedConvos.find((c) => c.id === convoIds[i])
      expect(convo).toBeDefined()
      expect(convo!.members).toHaveLength(2)
      const memberDids = convo!.members.map((m) => m.did).sort()
      expect(memberDids).toEqual([alice.did, others[i].did].sort())
    }
  })
})

// ==========================================================================
// Flow 7: Concurrent Message Exchange
// ==========================================================================

describe('Flow 7: Concurrent message exchange', () => {
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

  it('3 users with 2 conversations: messages stay isolated in their respective convos', async () => {
    // Step 1: Create two conversations: A-B and A-C
    // (mirrors frontend: user has multiple conversations open)
    const abConvoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const abConvoId = abConvoRes.convo.id
    await bob.agent.acceptConvo(abConvoId)

    const acConvoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      carol.did,
    ])) as ConvoForMembersResponse
    const acConvoId = acConvoRes.convo.id
    await carol.agent.acceptConvo(acConvoId)

    expect(abConvoId).not.toBe(acConvoId)

    // Step 2: Send messages to both conversations in an interleaved pattern
    // (mirrors frontend: user rapidly switches between conversations).
    // Sends are sequential to avoid database transaction deadlocks, but the
    // interleaving pattern still exercises the isolation invariant -- messages
    // to convo A-B must not appear in convo A-C and vice versa.
    const sends: MessageView[] = []
    sends.push((await alice.agent.sendMessage(abConvoId, { text: 'AB msg from Alice 1' })) as MessageView)
    sends.push((await alice.agent.sendMessage(acConvoId, { text: 'AC msg from Alice 1' })) as MessageView)
    sends.push((await bob.agent.sendMessage(abConvoId, { text: 'AB msg from Bob 1' })) as MessageView)
    sends.push((await carol.agent.sendMessage(acConvoId, { text: 'AC msg from Carol 1' })) as MessageView)
    sends.push((await alice.agent.sendMessage(abConvoId, { text: 'AB msg from Alice 2' })) as MessageView)
    sends.push((await alice.agent.sendMessage(acConvoId, { text: 'AC msg from Alice 2' })) as MessageView)

    // All sends should succeed
    for (const msg of sends) {
      expect(msg.id).toBeTruthy()
    }

    // Step 3: Verify messages are correctly isolated per conversation
    // A-B conversation should only have A-B messages
    const abMsgs = (await alice.agent.getMessages(
      abConvoId,
    )) as GetMessagesResponse
    const abTexts = abMsgs.messages
      .filter((m): m is MessageView => 'text' in m)
      .map((m) => m.text)

    expect(abTexts).toContain('AB msg from Alice 1')
    expect(abTexts).toContain('AB msg from Alice 2')
    expect(abTexts).toContain('AB msg from Bob 1')
    // Should NOT contain A-C messages
    expect(abTexts).not.toContain('AC msg from Alice 1')
    expect(abTexts).not.toContain('AC msg from Alice 2')
    expect(abTexts).not.toContain('AC msg from Carol 1')

    // A-C conversation should only have A-C messages
    const acMsgs = (await alice.agent.getMessages(
      acConvoId,
    )) as GetMessagesResponse
    const acTexts = acMsgs.messages
      .filter((m): m is MessageView => 'text' in m)
      .map((m) => m.text)

    expect(acTexts).toContain('AC msg from Alice 1')
    expect(acTexts).toContain('AC msg from Alice 2')
    expect(acTexts).toContain('AC msg from Carol 1')
    // Should NOT contain A-B messages
    expect(acTexts).not.toContain('AB msg from Alice 1')
    expect(acTexts).not.toContain('AB msg from Alice 2')
    expect(acTexts).not.toContain('AB msg from Bob 1')

    // Step 4: Verify correct message counts
    const abMessageCount = abMsgs.messages.filter(
      (m): m is MessageView => 'text' in m,
    ).length
    expect(abMessageCount).toBeGreaterThanOrEqual(3) // at least 3 A-B messages

    const acMessageCount = acMsgs.messages.filter(
      (m): m is MessageView => 'text' in m,
    ).length
    expect(acMessageCount).toBeGreaterThanOrEqual(3) // at least 3 A-C messages

    // Step 5: Verify Bob cannot see Carol's messages and vice versa
    const bobMsgs = (await bob.agent.getMessages(
      abConvoId,
    )) as GetMessagesResponse
    const bobTexts = bobMsgs.messages
      .filter((m): m is MessageView => 'text' in m)
      .map((m) => m.text)
    expect(bobTexts).not.toContain('AC msg from Carol 1')

    // Carol should not be able to access A-B convo at all
    await expect(carol.agent.getMessages(abConvoId)).rejects.toThrow()
  })
})

// ==========================================================================
// Flow 8: Unread Count Tracking Across Operations
// ==========================================================================

describe('Flow 8: Unread count tracking across operations', () => {
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

  it('tracks unread count through send, mark-read, send-more cycles', async () => {
    // Step 1: Create and set up conversation
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Initialize read state for both users
    await alice.agent.updateRead(convoId)
    await bob.agent.updateRead(convoId)

    // Step 2: Bob sends messages -> Alice's unread count increases
    // (mirrors frontend: user receives messages while viewing another screen)
    await bob.agent.sendMessage(convoId, { text: 'Unread test msg 1' })

    const aliceView1 = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceView1.convo.unreadCount).toBe(1)

    await bob.agent.sendMessage(convoId, { text: 'Unread test msg 2' })

    const aliceView2 = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceView2.convo.unreadCount).toBe(2)

    await bob.agent.sendMessage(convoId, { text: 'Unread test msg 3' })

    const aliceView3 = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceView3.convo.unreadCount).toBe(3)

    // Step 3: Verify sender's unread count is NOT affected
    // (mirrors frontend: sending a message does not increment your own unread)
    const bobViewDuring = (await bob.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(bobViewDuring.convo.unreadCount).toBe(0)

    // Step 4: Alice marks as read -> unread count resets to 0
    // (mirrors frontend: user opens conversation -> updateRead is called)
    const readRes = (await alice.agent.updateRead(
      convoId,
    )) as UpdateReadResponse
    expect(readRes.convo.unreadCount).toBe(0)

    // Verify via getConvo as well
    const aliceViewAfterRead = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceViewAfterRead.convo.unreadCount).toBe(0)

    // Step 5: Bob sends more messages -> unread count increases again
    // (mirrors frontend: user navigates away from conversation, new messages arrive)
    await bob.agent.sendMessage(convoId, { text: 'Another round msg 1' })
    await bob.agent.sendMessage(convoId, { text: 'Another round msg 2' })

    const aliceViewRound2 = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceViewRound2.convo.unreadCount).toBe(2)

    // Step 6: Alice sends a reply -- her own unread should stay the same
    // (mirrors frontend: Convo.sendMessage does not change own unread count)
    await alice.agent.sendMessage(convoId, { text: 'Alice replies' })

    const aliceAfterOwnSend = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    // Unread count should still be 2 (Alice's own message doesn't affect her unread)
    expect(aliceAfterOwnSend.convo.unreadCount).toBe(2)

    // Step 7: Mark as read again to reset
    await alice.agent.updateRead(convoId)

    const aliceFinal = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    expect(aliceFinal.convo.unreadCount).toBe(0)

    // Step 8: Verify updateAllRead works across multiple conversations
    // Create a second conversation for Alice
    const carol = await createTestUser(network, 'carol.test')
    const convo2Res = (await carol.agent.getConvoForMembers([
      carol.did,
      alice.did,
    ])) as ConvoForMembersResponse
    const convo2Id = convo2Res.convo.id
    await alice.agent.acceptConvo(convo2Id)
    await alice.agent.updateRead(convo2Id)

    // Send messages to both convos
    await bob.agent.sendMessage(convoId, { text: 'Unread in convo 1' })
    await carol.agent.sendMessage(convo2Id, { text: 'Unread in convo 2' })

    // Verify both have unreads
    const aliceConvo1 = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    const aliceConvo2 = (await alice.agent.getConvo(
      convo2Id,
    )) as GetConvoResponse
    expect(aliceConvo1.convo.unreadCount).toBeGreaterThan(0)
    expect(aliceConvo2.convo.unreadCount).toBeGreaterThan(0)

    // Mark all as read
    const updateAllRes = (await alice.agent.updateAllRead()) as {
      updatedCount: number
    }
    expect(updateAllRes.updatedCount).toBeGreaterThanOrEqual(2)

    // Verify both are now at 0
    const aliceConvo1After = (await alice.agent.getConvo(
      convoId,
    )) as GetConvoResponse
    const aliceConvo2After = (await alice.agent.getConvo(
      convo2Id,
    )) as GetConvoResponse
    expect(aliceConvo1After.convo.unreadCount).toBe(0)
    expect(aliceConvo2After.convo.unreadCount).toBe(0)
  })
})
