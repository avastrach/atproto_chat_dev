import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createModServiceClient,
} from './_util'

/**
 * Moderation E2E tests.
 *
 * Covers:
 * - getActorMetadata: returns message counts by time period
 * - getMessageContext: returns surrounding messages for moderation
 * - updateActorAccess: disables/enables chat access
 *
 * NOTE: Moderation endpoints (chat.bsky.moderation.*) typically require
 * admin-level authentication. These tests verify the basic request structure.
 * In a full integration environment, the tests would use admin service-auth
 * tokens. For now, these tests exercise the endpoints through the standard
 * ChatApiClient. The server may require special auth headers for moderation
 * endpoints in production.
 *
 * References:
 * - PRD 17.6.18 (getActorMetadata)
 * - PRD 17.6.19 (getMessageContext)
 * - PRD 17.6.20 (updateActorAccess)
 * - Service: moderation.ts
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

interface ConvoForMembersResponse {
  convo: ConvoView
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
  messages: (MessageView | { id: string; sender: { did: string } })[]
}

/**
 * Helper to make raw XRPC calls for moderation endpoints.
 * Moderation endpoints live under a different NSID namespace (chat.bsky.moderation.*)
 * and may not be wrapped in the ChatApiClient convenience methods.
 * The ChatApiClient already covers the standard convo endpoints.
 *
 * For moderation-specific endpoints, we'll directly test the data flows
 * that are accessible through the standard chat API (e.g., message counts
 * can be inferred from sending/receiving messages, message context from
 * getMessages).
 */

describe('moderation', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let modClient: ChatApiClient
  let convoId: string
  let messageIds: string[]

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
    modClient = await createModServiceClient(network)

    // Create conversation and send several messages for testing context
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id

    // Accept the convo
    await bob.agent.acceptConvo(convoId)

    // Send several messages in order for context testing
    messageIds = []
    const messages = [
      { sender: alice, text: 'Message 1 - context before' },
      { sender: bob, text: 'Message 2 - context before' },
      { sender: alice, text: 'Message 3 - context before' },
      { sender: bob, text: 'Message 4 - the target' },
      { sender: alice, text: 'Message 5 - context after' },
      { sender: bob, text: 'Message 6 - context after' },
      { sender: alice, text: 'Message 7 - context after' },
    ]

    for (const { sender, text } of messages) {
      const res = (await sender.agent.sendMessage(convoId, {
        text,
      })) as MessageView
      messageIds.push(res.id)
    }
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // Message activity tracking (verifiable through standard API)
  // -----------------------------------------------------------------------

  describe('message activity tracking', () => {
    it('messages sent by each user are tracked', async () => {
      // Alice sent messages 1, 3, 5, 7 (4 messages)
      // Bob sent messages 2, 4, 6 (3 messages)
      const aliceMsgs = (await alice.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }

      const aliceSent = aliceMsgs.messages.filter(
        (m) => 'sender' in m && m.sender.did === alice.did,
      )
      const bobSent = aliceMsgs.messages.filter(
        (m) => 'sender' in m && m.sender.did === bob.did,
      )

      expect(aliceSent.length).toBeGreaterThanOrEqual(4)
      expect(bobSent.length).toBeGreaterThanOrEqual(3)
    })

    it('messages are visible to both participants', async () => {
      // Both alice and bob can see all messages
      const aliceMsgs = (await alice.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }
      const bobMsgs = (await bob.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }

      expect(aliceMsgs.messages.length).toEqual(bobMsgs.messages.length)
    })
  })

  // -----------------------------------------------------------------------
  // Message context (surrounding messages)
  // -----------------------------------------------------------------------

  describe('message context', () => {
    it('messages surrounding a target can be retrieved via getMessages', async () => {
      // The target message is messageIds[3] ("Message 4 - the target")
      // We can verify surrounding context by checking getMessages returns
      // messages in the correct order

      const allMsgs = (await alice.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }

      // Find the target message
      const targetMsg = allMsgs.messages.find((m) => m.id === messageIds[3])
      expect(targetMsg).toBeDefined()
      expect('text' in targetMsg!).toBe(true)
      expect((targetMsg as MessageView).text).toBe('Message 4 - the target')

      // Verify messages before and after the target exist
      const beforeTarget = allMsgs.messages.find(
        (m) => m.id === messageIds[2],
      )
      const afterTarget = allMsgs.messages.find(
        (m) => m.id === messageIds[4],
      )
      expect(beforeTarget).toBeDefined()
      expect(afterTarget).toBeDefined()
    })

    it('all sent messages are retrievable for moderation purposes', async () => {
      // All 7 messages should be present
      const allMsgs = (await alice.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }

      for (const msgId of messageIds) {
        const found = allMsgs.messages.find((m) => m.id === msgId)
        expect(found).toBeDefined()
      }
    })
  })

  // -----------------------------------------------------------------------
  // Per-user deletion does not affect other users (moderation sees all)
  // -----------------------------------------------------------------------

  describe('deletion does not affect other user views', () => {
    it('deleting a message for self does not hide it from the other user', async () => {
      // Send a new message
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Moderation deletion test',
      })) as MessageView

      // Alice deletes for herself
      await alice.agent.deleteMessageForSelf(convoId, msg.id)

      // Alice should not see it
      const aliceMsgs = (await alice.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }
      const aliceFound = aliceMsgs.messages.find((m) => m.id === msg.id)
      expect(aliceFound).toBeUndefined()

      // Bob (and by extension, a moderator) should still see it
      const bobMsgs = (await bob.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }
      const bobFound = bobMsgs.messages.find((m) => m.id === msg.id)
      expect(bobFound).toBeDefined()
      expect((bobFound as MessageView).text).toBe('Moderation deletion test')
    })
  })

  // -----------------------------------------------------------------------
  // Conversation membership tracking
  // -----------------------------------------------------------------------

  describe('conversation membership', () => {
    it('both users are listed as members of the conversation', async () => {
      const convo = (await alice.agent.getConvo(convoId)) as {
        convo: ConvoView
      }

      expect(convo.convo.members).toHaveLength(2)
      const memberDids = convo.convo.members.map((m) => m.did).sort()
      expect(memberDids).toEqual([alice.did, bob.did].sort())
    })

    it('tracks multiple conversations per user', async () => {
      // Create additional conversations for alice
      const carol = await createTestUser(network, 'carol.test')
      const dave = await createTestUser(network, 'dave.test')

      await alice.agent.getConvoForMembers([alice.did, carol.did])
      await alice.agent.getConvoForMembers([alice.did, dave.did])

      // Alice should have at least 3 conversations
      const listRes = (await alice.agent.listConvos()) as {
        convos: ConvoView[]
      }
      expect(listRes.convos.length).toBeGreaterThanOrEqual(3)
    })
  })

  // -----------------------------------------------------------------------
  // Moderation-specific endpoints: getActorMetadata and getMessageContext
  // -----------------------------------------------------------------------

  describe('getActorMetadata via mod service', () => {
    let modClient: ChatApiClient

    beforeAll(async () => {
      modClient = await createModServiceClient(network)
    })

    it('returns accurate messagesSent count matching actual sent messages', async () => {
      // Alice sent messages 1, 3, 5, 7 in beforeAll (4 messages),
      // plus the 'Moderation deletion test' message (1 more = 5 minimum).
      const metadata =
        (await modClient.getActorMetadata(alice.did)) as ActorMetadataResponse

      expect(metadata.all).toBeDefined()
      expect(metadata.all.messagesSent).toBeGreaterThanOrEqual(4)
      expect(metadata.day).toBeDefined()
      expect(metadata.day.messagesSent).toBeGreaterThanOrEqual(4)
      expect(metadata.month).toBeDefined()
      expect(metadata.month.messagesSent).toBeGreaterThanOrEqual(4)
    })

    it('returns accurate messagesReceived count', async () => {
      // Alice received messages 2, 4, 6 from Bob (3 messages minimum)
      const metadata =
        (await modClient.getActorMetadata(alice.did)) as ActorMetadataResponse

      expect(metadata.all.messagesReceived).toBeGreaterThanOrEqual(3)
    })

    it('returns convos and convosStarted counts', async () => {
      const metadata =
        (await modClient.getActorMetadata(alice.did)) as ActorMetadataResponse

      // Alice should be in at least 1 conversation
      expect(metadata.all.convos).toBeGreaterThanOrEqual(1)
      // Alice initiated the convo in beforeAll, so convosStarted >= 1
      expect(metadata.all.convosStarted).toBeGreaterThanOrEqual(1)
    })
  })

  describe('getMessageContext via mod service', () => {
    let modClient: ChatApiClient

    beforeAll(async () => {
      modClient = await createModServiceClient(network)
    })

    it('returns surrounding messages for a given messageId', async () => {
      // Target is messageIds[3] = "Message 4 - the target"
      const targetId = messageIds[3]
      const result =
        (await modClient.getMessageContext(targetId)) as GetMessageContextResponse

      expect(result.messages).toBeDefined()
      expect(result.messages.length).toBeGreaterThanOrEqual(1)

      // Target message should be in the result
      const target = result.messages.find((m) => m.id === targetId)
      expect(target).toBeDefined()
      expect('text' in target!).toBe(true)
      expect((target as MessageView).text).toBe('Message 4 - the target')
    })

    it('returns messages before and after the target', async () => {
      // With default before=5, after=5, we should get surrounding context
      const targetId = messageIds[3]
      const result =
        (await modClient.getMessageContext(targetId)) as GetMessageContextResponse

      // We have 7 messages from beforeAll (indices 0-6), plus 1 extra
      // message sent by the "deletion does not affect other user views"
      // test that runs earlier. Target is at index 3.
      // before=5 means up to 3 messages before (indices 0,1,2)
      // after=5 means up to 4 messages after (indices 4,5,6 + deletion test msg)
      // Total should be 8 (3 before + target + 4 after)
      expect(result.messages.length).toBe(8)

      // Verify chronological order (ascending by ID)
      for (let i = 1; i < result.messages.length; i++) {
        expect(result.messages[i].id > result.messages[i - 1].id).toBe(true)
      }
    })

    it('respects before/after count parameters', async () => {
      const targetId = messageIds[3]

      // Request only 1 message before and 1 after
      const result = (await modClient.getMessageContext(targetId, {
        before: 1,
        after: 1,
      })) as GetMessageContextResponse

      // Should have at most 3 messages: 1 before + target + 1 after
      expect(result.messages.length).toBe(3)

      // Verify target is in the middle
      expect(result.messages[1].id).toBe(targetId)

      // Verify before and after
      expect(result.messages[0].id).toBe(messageIds[2])
      expect(result.messages[2].id).toBe(messageIds[4])
    })

    it('returns only target when before=0 and after=0', async () => {
      const targetId = messageIds[3]

      const result = (await modClient.getMessageContext(targetId, {
        before: 0,
        after: 0,
      })) as GetMessageContextResponse

      expect(result.messages.length).toBe(1)
      expect(result.messages[0].id).toBe(targetId)
    })

    it('handles asymmetric before=2 and after=3 correctly', async () => {
      // Target is messageIds[3] = "Message 4 - the target"
      // before=2 should give messageIds[1] and messageIds[2]
      // after=3 should give messageIds[4], messageIds[5], messageIds[6]
      const targetId = messageIds[3]

      const result = (await modClient.getMessageContext(targetId, {
        before: 2,
        after: 3,
      })) as GetMessageContextResponse

      // 2 before + target + 3 after = 6
      expect(result.messages.length).toBe(6)

      // Verify the exact messages returned
      expect(result.messages[0].id).toBe(messageIds[1])
      expect(result.messages[1].id).toBe(messageIds[2])
      expect(result.messages[2].id).toBe(targetId)
      expect(result.messages[3].id).toBe(messageIds[4])
      expect(result.messages[4].id).toBe(messageIds[5])
      expect(result.messages[5].id).toBe(messageIds[6])
    })

    it('resolves convoId from message when convoId is not provided', async () => {
      // Call getMessageContext WITHOUT specifying convoId -- the handler
      // should resolve it from the message itself (covers the convoId
      // lookup branch in moderation.ts getMessageContext)
      const targetId = messageIds[3]

      // The ChatApiClient.getMessageContext already supports omitting convoId.
      // We call it without the convoId option explicitly.
      const result =
        (await modClient.getMessageContext(targetId)) as GetMessageContextResponse

      expect(result.messages).toBeDefined()
      expect(result.messages.length).toBeGreaterThanOrEqual(1)

      // Target should be in the results
      const target = result.messages.find((m) => m.id === targetId)
      expect(target).toBeDefined()
    })

    it('provides convoId explicitly and returns consistent results', async () => {
      // Call getMessageContext WITH convoId specified -- this skips the
      // convoId lookup branch. Compare with the no-convoId result to
      // verify consistency.
      const targetId = messageIds[3]

      const withConvo = (await modClient.getMessageContext(targetId, {
        convoId,
        before: 1,
        after: 1,
      })) as GetMessageContextResponse

      const withoutConvo = (await modClient.getMessageContext(targetId, {
        before: 1,
        after: 1,
      })) as GetMessageContextResponse

      // Both should return the same messages
      expect(withConvo.messages.length).toBe(withoutConvo.messages.length)
      for (let i = 0; i < withConvo.messages.length; i++) {
        expect(withConvo.messages[i].id).toBe(withoutConvo.messages[i].id)
      }
    })

    it('getMessageContext with before=0 returns no before messages', async () => {
      const targetId = messageIds[3]

      const result = (await modClient.getMessageContext(targetId, {
        convoId,
        before: 0,
        after: 2,
      })) as GetMessageContextResponse

      expect(result.messages).toBeDefined()
      // target + 2 after = 3
      expect(result.messages.length).toBe(3)
      expect(result.messages[0].id).toBe(targetId)
    })

    it('getMessageContext with after=0 returns no after messages', async () => {
      const targetId = messageIds[3]

      const result = (await modClient.getMessageContext(targetId, {
        convoId,
        before: 2,
        after: 0,
      })) as GetMessageContextResponse

      expect(result.messages).toBeDefined()
      // 2 before + target = 3
      expect(result.messages.length).toBe(3)
      expect(result.messages[result.messages.length - 1].id).toBe(targetId)
    })

    it('getMessageContext for non-existent message returns error', async () => {
      await expect(
        modClient.getMessageContext('nonexistent-msg-id-xyz'),
      ).rejects.toThrow(/Message not found/)
    })

    it('getMessageContext with deleted messages shows them', async () => {
      const u1 = await createTestUser(network, 'mod-gmcd1.test')
      const u2 = await createTestUser(network, 'mod-gmcd2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const freshConvoId = convoRes.convo.id
      await u2.agent.acceptConvo(freshConvoId)

      await u1.agent.sendMessage(freshConvoId, { text: 'Before target' })
      const target = (await u2.agent.sendMessage(freshConvoId, {
        text: 'Target stays',
      })) as MessageView
      await u1.agent.sendMessage(freshConvoId, { text: 'After will delete' })

      // u1 deletes account — soft-deletes their messages
      await u1.agent.deleteAccount()

      const result = (await modClient.getMessageContext(target.id, {
        convoId: freshConvoId,
      })) as GetMessageContextResponse

      expect(result.messages).toBeDefined()
      expect(result.messages.length).toBeGreaterThanOrEqual(1)

      // Should contain at least one deleted message view
      const deleted = result.messages.filter(
        (m) =>
          '$type' in m &&
          (m as { $type: string }).$type ===
            'chat.bsky.convo.defs#deletedMessageView',
      )
      expect(deleted.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // Moderation handler validation via raw HTTP
  // -----------------------------------------------------------------------

  describe('moderation handler validation', () => {
    let modJwtFn: (nsid: string) => Promise<string>

    beforeAll(async () => {
      const { createServiceJwt } = await import('@atproto/xrpc-server')
      const modServiceDid = network.ozone.ctx.cfg.service.did
      const modServiceKeypair = network.ozone.ctx.signingKey

      modJwtFn = async (nsid: string) =>
        createServiceJwt({
          iss: `${modServiceDid}#atproto_labeler`,
          aud: network.chat.serverDid,
          lxm: nsid,
          keypair: modServiceKeypair,
        })
    })

    it('updateActorAccess without actor field returns 400', async () => {
      const jwt = await modJwtFn('chat.bsky.moderation.updateActorAccess')
      const res = await fetch(
        `${network.chat.url}/xrpc/chat.bsky.moderation.updateActorAccess`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ allowAccess: true }),
        },
      )
      expect(res.status).toBe(400)
    })

    it('updateActorAccess without allowAccess field returns 400', async () => {
      const jwt = await modJwtFn('chat.bsky.moderation.updateActorAccess')
      const res = await fetch(
        `${network.chat.url}/xrpc/chat.bsky.moderation.updateActorAccess`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ actor: alice.did }),
        },
      )
      expect(res.status).toBe(400)
    })

    it('getActorMetadata without actor param returns 400', async () => {
      const jwt = await modJwtFn('chat.bsky.moderation.getActorMetadata')
      const res = await fetch(
        `${network.chat.url}/xrpc/chat.bsky.moderation.getActorMetadata`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${jwt}` },
        },
      )
      expect(res.status).toBe(400)
    })

    it('getMessageContext without messageId param returns 400', async () => {
      const jwt = await modJwtFn('chat.bsky.moderation.getMessageContext')
      const res = await fetch(
        `${network.chat.url}/xrpc/chat.bsky.moderation.getMessageContext`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${jwt}` },
        },
      )
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // getActorMetadata edge cases
  // -----------------------------------------------------------------------

  describe('getActorMetadata edge cases', () => {
    it('returns zero counts for user with no activity', async () => {
      const freshUser = await createTestUser(network, 'mod-gam.test')

      const result = (await modClient.getActorMetadata(freshUser.did)) as {
        day: { messagesSent: number }
        month: { messagesSent: number }
        all: { messagesSent: number }
      }

      expect(result.day.messagesSent).toBe(0)
      expect(result.month.messagesSent).toBe(0)
      expect(result.all.messagesSent).toBe(0)
    })
  })
})
