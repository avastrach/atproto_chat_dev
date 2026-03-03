import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Leave-clears-history E2E tests.
 *
 * Covers:
 * - When a user leaves a conversation and later rejoins, getMessages should
 *   NOT return messages from before they left. Only messages sent after they
 *   rejoin should be visible.
 * - Other members who never left continue to see all messages.
 * - The `rejoinedAt` column on `conversation_member` tracks when a user last
 *   joined/rejoined. `getMessages` filters out messages with sentAt < rejoinedAt.
 *
 * References:
 * - PRD 16.7.10 (Leaving a Conversation)
 * - Service: message.ts (getMessages rejoinedAt filtering)
 * - Service: conversation.ts (getConvoForMembers rejoin logic)
 * - Migration: 002_add_rejoined_at
 */

// Type helpers
interface ConvoView {
  id: string
  rev: string
  members: Array<{ did: string }>
  status: string
  unreadCount: number
}

interface MessageView {
  id: string
  rev: string
  text: string
  sender: { did: string }
  sentAt: string
  $type?: string
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

interface GetMessagesResponse {
  messages: (MessageView | { id: string; $type?: string })[]
  cursor?: string
}

describe('leave-clears-history', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'lh-alice.test')
    bob = await createTestUser(network, 'lh-bob.test')
  })

  afterAll(async () => {
    await network.close()
  })

  /** Helper: get the chat service database handle. */
  function chatDb() {
    return network.chat.ctx.db.db
  }

  // -----------------------------------------------------------------------
  // 1. After leave + rejoin, getMessages does NOT return pre-leave messages
  // -----------------------------------------------------------------------

  describe('after leave + rejoin, pre-leave messages are hidden', () => {
    let convoId: string

    it('sets up a conversation, sends messages, then alice leaves and rejoins', async () => {
      // Create conversation
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      convoId = convoRes.convo.id

      // Bob accepts
      await bob.agent.acceptConvo(convoId)

      // Send pre-leave messages
      await alice.agent.sendMessage(convoId, { text: 'Pre-leave msg 1' })
      await bob.agent.sendMessage(convoId, { text: 'Pre-leave msg 2' })
      await alice.agent.sendMessage(convoId, { text: 'Pre-leave msg 3' })

      // Alice leaves
      await alice.agent.leaveConvo(convoId)

      // Alice rejoins by calling getConvoForMembers
      const rejoinRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      expect(rejoinRes.convo.id).toBe(convoId)
    })

    it('alice does NOT see pre-leave messages after rejoin', async () => {
      // Accept the convo again after rejoin (status goes to 'request')
      await alice.agent.acceptConvo(convoId)

      const aliceMsgs = (await alice.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      const aliceTexts = aliceMsgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)

      expect(aliceTexts).not.toContain('Pre-leave msg 1')
      expect(aliceTexts).not.toContain('Pre-leave msg 2')
      expect(aliceTexts).not.toContain('Pre-leave msg 3')
    })
  })

  // -----------------------------------------------------------------------
  // 2. After leave + rejoin, getMessages DOES return post-rejoin messages
  // -----------------------------------------------------------------------

  describe('after leave + rejoin, post-rejoin messages are visible', () => {
    let convoId: string

    it('sets up convo, leave, rejoin, then sends new messages', async () => {
      // Use fresh users to avoid interference
      const carol = await createTestUser(network, 'lh-carol.test')
      const dave = await createTestUser(network, 'lh-dave.test')

      // Create conversation
      const convoRes = (await carol.agent.getConvoForMembers([
        carol.did,
        dave.did,
      ])) as ConvoForMembersResponse
      convoId = convoRes.convo.id

      // Dave accepts
      await dave.agent.acceptConvo(convoId)

      // Send pre-leave messages
      await carol.agent.sendMessage(convoId, { text: 'Before leaving' })

      // Carol leaves
      await carol.agent.leaveConvo(convoId)

      // Carol rejoins
      await carol.agent.getConvoForMembers([carol.did, dave.did])

      // Carol accepts the convo again
      await carol.agent.acceptConvo(convoId)

      // Send post-rejoin messages
      await dave.agent.sendMessage(convoId, { text: 'After rejoin from Dave' })
      await carol.agent.sendMessage(convoId, {
        text: 'After rejoin from Carol',
      })

      // Carol should see post-rejoin messages
      const carolMsgs = (await carol.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      const carolTexts = carolMsgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)

      expect(carolTexts).toContain('After rejoin from Dave')
      expect(carolTexts).toContain('After rejoin from Carol')
      expect(carolTexts).not.toContain('Before leaving')
    })
  })

  // -----------------------------------------------------------------------
  // 3. Other member (who never left) can still see ALL messages
  // -----------------------------------------------------------------------

  describe('non-leaving member sees all messages', () => {
    it('bob sees both pre-leave and post-rejoin messages', async () => {
      const eve = await createTestUser(network, 'lh-eve.test')
      const frank = await createTestUser(network, 'lh-frank.test')

      // Create conversation
      const convoRes = (await eve.agent.getConvoForMembers([
        eve.did,
        frank.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Frank accepts
      await frank.agent.acceptConvo(convoId)

      // Send pre-leave messages
      await eve.agent.sendMessage(convoId, { text: 'Eve pre-leave' })
      await frank.agent.sendMessage(convoId, { text: 'Frank pre-leave' })

      // Eve leaves
      await eve.agent.leaveConvo(convoId)

      // Eve rejoins
      await eve.agent.getConvoForMembers([eve.did, frank.did])
      await eve.agent.acceptConvo(convoId)

      // Send post-rejoin messages
      await frank.agent.sendMessage(convoId, { text: 'Frank post-rejoin' })
      await eve.agent.sendMessage(convoId, { text: 'Eve post-rejoin' })

      // Frank (never left) should see ALL messages
      const frankMsgs = (await frank.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      const frankTexts = frankMsgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)

      expect(frankTexts).toContain('Eve pre-leave')
      expect(frankTexts).toContain('Frank pre-leave')
      expect(frankTexts).toContain('Frank post-rejoin')
      expect(frankTexts).toContain('Eve post-rejoin')

      // Eve (who left and rejoined) should NOT see pre-leave messages
      const eveMsgs = (await eve.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      const eveTexts = eveMsgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)

      expect(eveTexts).not.toContain('Eve pre-leave')
      expect(eveTexts).not.toContain('Frank pre-leave')
      expect(eveTexts).toContain('Frank post-rejoin')
      expect(eveTexts).toContain('Eve post-rejoin')
    })
  })

  // -----------------------------------------------------------------------
  // 4. First-time conversation creation (no leave) shows all messages
  // -----------------------------------------------------------------------

  describe('first-time conversation shows all messages normally', () => {
    it('new members with no leave history see all messages', async () => {
      const grace = await createTestUser(network, 'lh-grace.test')
      const hank = await createTestUser(network, 'lh-hank.test')

      // Create conversation
      const convoRes = (await grace.agent.getConvoForMembers([
        grace.did,
        hank.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Hank accepts
      await hank.agent.acceptConvo(convoId)

      // Send multiple messages
      await grace.agent.sendMessage(convoId, { text: 'First message' })
      await hank.agent.sendMessage(convoId, { text: 'Second message' })
      await grace.agent.sendMessage(convoId, { text: 'Third message' })

      // Both users should see all messages
      const graceMsgs = (await grace.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      const graceTexts = graceMsgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)

      expect(graceTexts).toContain('First message')
      expect(graceTexts).toContain('Second message')
      expect(graceTexts).toContain('Third message')

      const hankMsgs = (await hank.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      const hankTexts = hankMsgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)

      expect(hankTexts).toContain('First message')
      expect(hankTexts).toContain('Second message')
      expect(hankTexts).toContain('Third message')

      // Verify rejoinedAt is null for first-time members (no leave history)
      const graceMember = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', grace.did)
        .select('rejoinedAt')
        .executeTakeFirst()

      expect(graceMember).toBeDefined()
      expect(graceMember!.rejoinedAt).toBeNull()

      const hankMember = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', hank.did)
        .select('rejoinedAt')
        .executeTakeFirst()

      expect(hankMember).toBeDefined()
      expect(hankMember!.rejoinedAt).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // 5. The rejoinedAt field is properly set on rejoin (DB check)
  // -----------------------------------------------------------------------

  describe('rejoinedAt field is properly set in the DB', () => {
    it('rejoinedAt is null before leave and set after rejoin', async () => {
      const iris = await createTestUser(network, 'lh-iris.test')
      const jake = await createTestUser(network, 'lh-jake.test')

      // Create conversation
      const convoRes = (await iris.agent.getConvoForMembers([
        iris.did,
        jake.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Jake accepts
      await jake.agent.acceptConvo(convoId)

      // Verify rejoinedAt is null initially
      const beforeLeave = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', iris.did)
        .select(['rejoinedAt', 'status'])
        .executeTakeFirst()

      expect(beforeLeave).toBeDefined()
      expect(beforeLeave!.rejoinedAt).toBeNull()
      expect(beforeLeave!.status).toBe('accepted')

      // Iris leaves
      await iris.agent.leaveConvo(convoId)

      // Verify status is 'left' and rejoinedAt is still null
      const afterLeave = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', iris.did)
        .select(['rejoinedAt', 'status', 'leftAt'])
        .executeTakeFirst()

      expect(afterLeave).toBeDefined()
      expect(afterLeave!.status).toBe('left')
      expect(afterLeave!.leftAt).toBeTruthy()
      expect(afterLeave!.rejoinedAt).toBeNull()

      // Capture the time before rejoin
      const beforeRejoinTime = new Date().toISOString()

      // Iris rejoins
      await iris.agent.getConvoForMembers([iris.did, jake.did])

      // Verify rejoinedAt is now set and status is 'request'
      const afterRejoin = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', iris.did)
        .select(['rejoinedAt', 'status', 'leftAt'])
        .executeTakeFirst()

      expect(afterRejoin).toBeDefined()
      expect(afterRejoin!.status).toBe('request')
      expect(afterRejoin!.leftAt).toBeNull()
      expect(afterRejoin!.rejoinedAt).toBeTruthy()

      // rejoinedAt should be a valid ISO timestamp after our capture time
      const rejoinedAtDate = new Date(afterRejoin!.rejoinedAt!)
      const beforeRejoinDate = new Date(beforeRejoinTime)
      expect(rejoinedAtDate.getTime()).toBeGreaterThanOrEqual(
        beforeRejoinDate.getTime() - 1000, // Allow 1s tolerance
      )

      // Jake (who never left) should still have rejoinedAt = null
      const jakeMember = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', jake.did)
        .select(['rejoinedAt', 'status'])
        .executeTakeFirst()

      expect(jakeMember).toBeDefined()
      expect(jakeMember!.rejoinedAt).toBeNull()
      expect(jakeMember!.status).toBe('accepted')
    })

    it('rejoinedAt is updated on second leave+rejoin cycle', async () => {
      const kim = await createTestUser(network, 'lh-kim.test')
      const leo = await createTestUser(network, 'lh-leo.test')

      // Create conversation
      const convoRes = (await kim.agent.getConvoForMembers([
        kim.did,
        leo.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Leo accepts
      await leo.agent.acceptConvo(convoId)

      // First leave + rejoin
      await kim.agent.leaveConvo(convoId)
      await kim.agent.getConvoForMembers([kim.did, leo.did])

      const afterFirstRejoin = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', kim.did)
        .select('rejoinedAt')
        .executeTakeFirst()

      expect(afterFirstRejoin!.rejoinedAt).toBeTruthy()
      const firstRejoinTime = afterFirstRejoin!.rejoinedAt!

      // Accept, then leave + rejoin again
      await kim.agent.acceptConvo(convoId)

      // Small delay to ensure timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 50))

      await kim.agent.leaveConvo(convoId)
      await kim.agent.getConvoForMembers([kim.did, leo.did])

      const afterSecondRejoin = await chatDb()
        .selectFrom('conversation_member')
        .where('convoId', '=', convoId)
        .where('memberDid', '=', kim.did)
        .select('rejoinedAt')
        .executeTakeFirst()

      expect(afterSecondRejoin!.rejoinedAt).toBeTruthy()
      const secondRejoinTime = afterSecondRejoin!.rejoinedAt!

      // Second rejoinedAt should be later than or equal to the first
      expect(new Date(secondRejoinTime).getTime()).toBeGreaterThanOrEqual(
        new Date(firstRejoinTime).getTime(),
      )
    })
  })
})
