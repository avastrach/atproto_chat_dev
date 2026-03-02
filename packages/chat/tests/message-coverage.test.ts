import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createBlock,
  removeBlock,
  setChatDisabled,
  createModServiceClient,
} from './_util'

/**
 * Message service coverage tests.
 *
 * Targets uncovered branches in message.ts:
 *
 * - Batch validation: missing convoId in item, missing message in item
 * - chatDisabled enforcement in sendMessageBatch (lines 327-335)
 * - removeReaction on a deleted message (lines 872-877)
 * - sendMessageBatch block check per item (lines 361-384)
 * - getMessages deleted message view path (line 581-582)
 * - Reaction validation edge cases: exactly 1 complex grapheme
 * - Message with only facets (no embed) and only embed (no facets)
 * - getMessages with no messages (empty convo)
 * - Pagination edge: exactly limit messages (no cursor returned)
 *
 * References:
 * - message.ts (validateMessageText, validateReactionValue, sendMessageBatch)
 * - Errata E3 (limit clamping)
 */

// Type helpers
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

interface MessageView {
  id: string
  rev: string
  text: string
  sender: { did: string }
  sentAt: string
  $type?: string
  facets?: unknown[]
  embed?: unknown
  reactions?: Array<{
    value: string
    sender: { did: string }
    createdAt: string
  }>
}

interface DeletedMessageView {
  id: string
  rev: string
  sender: { did: string }
  sentAt: string
  $type?: string
}

interface GetMessagesResponse {
  messages: (MessageView | DeletedMessageView)[]
  cursor?: string
}

interface SendMessageBatchResponse {
  items: MessageView[]
}

interface ReactionResponse {
  message: MessageView
}

describe('message service coverage', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let modClient: ChatApiClient
  let convoId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
    modClient = await createModServiceClient(network)

    // Create a conversation for message tests
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

  // -----------------------------------------------------------------------
  // sendMessageBatch chatDisabled enforcement (lines 327-335)
  // -----------------------------------------------------------------------

  describe('sendMessageBatch chatDisabled', () => {
    it('chatDisabled user cannot send via batch', async () => {
      const disUser = await createTestUser(network, 'msc-dis.test')
      const peer = await createTestUser(network, 'msc-dispeer.test')

      const convoRes = (await disUser.agent.getConvoForMembers([
        disUser.did,
        peer.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await peer.agent.acceptConvo(cid)

      // Verify batch works before disabling
      const preRes = (await disUser.agent.sendMessageBatch([
        { convoId: cid, message: { text: 'Before disable batch' } },
      ])) as SendMessageBatchResponse
      expect(preRes.items).toHaveLength(1)

      // Moderator disables chat
      await setChatDisabled(modClient, disUser.did, true)

      // Batch should fail with "Account is disabled"
      await expect(
        disUser.agent.sendMessageBatch([
          { convoId: cid, message: { text: 'After disable batch' } },
        ]),
      ).rejects.toThrow(/Account is disabled/)

      // Re-enable for cleanup
      await setChatDisabled(modClient, disUser.did, false)
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch validation edge cases
  // -----------------------------------------------------------------------

  describe('sendMessageBatch validation', () => {
    it('batch rejects item with missing convoId', async () => {
      // The XRPC endpoint handler should reject items without convoId
      // before reaching the service layer. But the service also validates.
      const chatUrl = network.chat.url
      const { createServiceJwt } = await import('@atproto/xrpc-server')
      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)

      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.sendMessageBatch',
        keypair,
      })

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.sendMessageBatch`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            items: [{ message: { text: 'missing convoId' } }],
          }),
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
    })

    it('batch rejects item with missing message', async () => {
      const chatUrl = network.chat.url
      const { createServiceJwt } = await import('@atproto/xrpc-server')
      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)

      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.sendMessageBatch',
        keypair,
      })

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.sendMessageBatch`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            items: [{ convoId }],
          }),
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
    })

    it('batch rejects item with empty message text', async () => {
      await expect(
        alice.agent.sendMessageBatch([
          { convoId, message: { text: '' } },
        ]),
      ).rejects.toThrow(/must have a message with text/)
    })

    it('batch rejects message exceeding grapheme limit', async () => {
      const longText = 'a'.repeat(1001)
      await expect(
        alice.agent.sendMessageBatch([
          { convoId, message: { text: longText } },
        ]),
      ).rejects.toThrow(/exceeds maximum.*1000 graphemes/)
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch with block check (lines 361-384)
  // -----------------------------------------------------------------------

  describe('sendMessageBatch block check', () => {
    it('batch fails when recipient has blocked the sender', async () => {
      const sender = await createTestUser(network, 'msc-bs.test')
      const blocker = await createTestUser(network, 'msc-bblk.test')

      const convoRes = (await sender.agent.getConvoForMembers([
        sender.did,
        blocker.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await blocker.agent.acceptConvo(cid)

      // Block the sender
      const blockRef = await createBlock(network, blocker, sender)

      // Batch send should fail
      await expect(
        sender.agent.sendMessageBatch([
          { convoId: cid, message: { text: 'Blocked batch' } },
        ]),
      ).rejects.toThrow(/block between recipient and sender/)

      // Cleanup
      await removeBlock(network, blocker, blockRef)
    })
  })

  // -----------------------------------------------------------------------
  // removeReaction on a deleted message (lines 872-877)
  // -----------------------------------------------------------------------

  describe('removeReaction on deleted message', () => {
    it('removeReaction on a soft-deleted message returns ReactionMessageDeleted', async () => {
      // Create a throwaway user who will delete their account
      const tempUser = await createTestUser(network, 'msc-rrd.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        tempUser.did,
      ])) as ConvoForMembersResponse
      const freshConvoId = convoRes.convo.id
      await tempUser.agent.acceptConvo(freshConvoId)

      // tempUser sends a message and alice reacts to it
      const msg = (await tempUser.agent.sendMessage(freshConvoId, {
        text: 'Message for remove reaction on deleted',
      })) as MessageView

      await alice.agent.addReaction(
        freshConvoId,
        msg.id,
        '\u2764\uFE0F',
      )

      // tempUser deletes their account (soft-deletes their messages)
      await tempUser.agent.deleteAccount()

      // Alice tries to remove her reaction from the now-deleted message
      await expect(
        alice.agent.removeReaction(freshConvoId, msg.id, '\u2764\uFE0F'),
      ).rejects.toThrow(
        /Cannot modify reactions on deleted message|ReactionMessageDeleted/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // Reaction edge cases
  // -----------------------------------------------------------------------

  describe('reaction edge cases', () => {
    it('addReaction for a non-member returns Convo not found', async () => {
      const outsider = await createTestUser(network, 'msc-rnm.test')
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Reaction non-member test',
      })) as MessageView

      await expect(
        outsider.agent.addReaction(convoId, msg.id, '\u2764\uFE0F'),
      ).rejects.toThrow(/Convo not found/)
    })

    it('removeReaction for a non-member returns Convo not found', async () => {
      const outsider = await createTestUser(network, 'msc-rrnm.test')
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Remove reaction non-member test',
      })) as MessageView

      await expect(
        outsider.agent.removeReaction(convoId, msg.id, '\u2764\uFE0F'),
      ).rejects.toThrow(/Convo not found/)
    })

    it('addReaction to a non-existent message returns Message not found', async () => {
      await expect(
        alice.agent.addReaction(convoId, 'nonexistent-msg-id', '\u2764\uFE0F'),
      ).rejects.toThrow(/Message not found/)
    })

    it('removeReaction from a non-existent message returns Message not found', async () => {
      await expect(
        alice.agent.removeReaction(
          convoId,
          'nonexistent-msg-id',
          '\u2764\uFE0F',
        ),
      ).rejects.toThrow(/Message not found/)
    })

    it('addReaction with complex emoji grapheme (ZWJ sequence) is accepted', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'ZWJ reaction test',
      })) as MessageView

      // Family emoji with ZWJ: counts as 1 grapheme in Intl.Segmenter
      const familyEmoji = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67'
      const raw = (await alice.agent.addReaction(
        convoId,
        msg.id,
        familyEmoji,
      )) as ReactionResponse

      expect(raw.message.reactions).toBeDefined()
      const found = raw.message.reactions!.find(
        (r) => r.value === familyEmoji,
      )
      expect(found).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // getMessages edge cases
  // -----------------------------------------------------------------------

  describe('getMessages edge cases', () => {
    it('getMessages on a convo with no messages returns empty array', async () => {
      const user1 = await createTestUser(network, 'gm-empty1.test')
      const user2 = await createTestUser(network, 'gm-empty2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const emptyConvoId = convoRes.convo.id

      const res = (await user1.agent.getMessages(
        emptyConvoId,
      )) as GetMessagesResponse

      expect(res.messages).toBeDefined()
      expect(Array.isArray(res.messages)).toBe(true)
      expect(res.messages).toHaveLength(0)
      // No cursor when no messages
      expect(res.cursor).toBeUndefined()
    })

    it('getMessages with limit=1 returns exactly 1 message and a cursor', async () => {
      // Send at least 2 messages so there is a cursor
      await alice.agent.sendMessage(convoId, { text: 'Limit 1 test msg A' })
      await alice.agent.sendMessage(convoId, { text: 'Limit 1 test msg B' })

      const res = (await alice.agent.getMessages(convoId, {
        limit: 1,
      })) as GetMessagesResponse

      expect(res.messages).toHaveLength(1)
      expect(res.cursor).toBeDefined()
    })

    it('getMessages with very large limit clamps to 100', async () => {
      const res = (await alice.agent.getMessages(convoId, {
        limit: 9999,
      })) as GetMessagesResponse

      expect(res.messages).toBeDefined()
      // Should have returned at most 100 messages (clamped)
      expect(res.messages.length).toBeLessThanOrEqual(100)
    })
  })

  // -----------------------------------------------------------------------
  // Message with facets only, embed only
  // -----------------------------------------------------------------------

  describe('message content variations', () => {
    it('sendMessage with facets but no embed', async () => {
      const facets = [
        {
          index: { byteStart: 0, byteEnd: 3 },
          features: [
            { $type: 'app.bsky.richtext.facet#tag', tag: 'test' },
          ],
        },
      ]

      const msg = (await alice.agent.sendMessage(convoId, {
        text: '#test hello',
        facets,
      })) as MessageView

      expect(msg.facets).toBeDefined()
      expect(msg.facets!.length).toBe(1)
      // embed should be absent/null/undefined
      expect(msg.embed).toBeUndefined()
    })

    it('sendMessage with embed but no facets', async () => {
      const embed = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: 'at://did:plc:embedonly/app.bsky.feed.post/001',
          cid: 'bafyreifakeembedonly',
        },
      }

      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Embed only message',
        embed,
      })) as MessageView

      expect(msg.embed).toBeDefined()
      // facets should be absent/null/undefined
      expect(msg.facets).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // sendMessage after convo is left by other member
  // -----------------------------------------------------------------------

  describe('send when other member has left', () => {
    it('sender can still send after the other member has left', async () => {
      const user1 = await createTestUser(network, 'msc-sol1.test')
      const user2 = await createTestUser(network, 'msc-sol2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await user2.agent.acceptConvo(cid)

      // user2 leaves
      await user2.agent.leaveConvo(cid)

      // user1 can still send (the block check skips members with status='left')
      const msg = (await user1.agent.sendMessage(cid, {
        text: 'Solo send after leave',
      })) as MessageView
      expect(msg.id).toBeTruthy()
      expect(msg.text).toBe('Solo send after leave')
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch with multiple convos
  // -----------------------------------------------------------------------

  describe('sendMessageBatch multi-convo', () => {
    it('batch sends to multiple different conversations', async () => {
      const peer1 = await createTestUser(network, 'msc-mc1.test')
      const peer2 = await createTestUser(network, 'msc-mc2.test')

      const c1Res = (await alice.agent.getConvoForMembers([
        alice.did,
        peer1.did,
      ])) as ConvoForMembersResponse
      const c1 = c1Res.convo.id
      await peer1.agent.acceptConvo(c1)

      const c2Res = (await alice.agent.getConvoForMembers([
        alice.did,
        peer2.did,
      ])) as ConvoForMembersResponse
      const c2 = c2Res.convo.id
      await peer2.agent.acceptConvo(c2)

      const batchRes = (await alice.agent.sendMessageBatch([
        { convoId: c1, message: { text: 'Multi-convo batch msg 1' } },
        { convoId: c2, message: { text: 'Multi-convo batch msg 2' } },
      ])) as SendMessageBatchResponse

      expect(batchRes.items).toHaveLength(2)
      expect(batchRes.items[0].text).toBe('Multi-convo batch msg 1')
      expect(batchRes.items[1].text).toBe('Multi-convo batch msg 2')

      // Verify each message landed in the correct convo
      const c1Msgs = (await peer1.agent.getMessages(c1)) as GetMessagesResponse
      const c1Texts = c1Msgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)
      expect(c1Texts).toContain('Multi-convo batch msg 1')
      expect(c1Texts).not.toContain('Multi-convo batch msg 2')

      const c2Msgs = (await peer2.agent.getMessages(c2)) as GetMessagesResponse
      const c2Texts = c2Msgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)
      expect(c2Texts).toContain('Multi-convo batch msg 2')
      expect(c2Texts).not.toContain('Multi-convo batch msg 1')
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch with facets and embeds per item
  // -----------------------------------------------------------------------

  describe('sendMessageBatch with rich content', () => {
    it('batch with facets and embeds in individual items', async () => {
      const chatUrl = network.chat.url
      const { createServiceJwt } = await import('@atproto/xrpc-server')
      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)

      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.sendMessageBatch',
        keypair,
      })

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.sendMessageBatch`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            items: [
              {
                convoId,
                message: {
                  text: 'Batch with facets',
                  facets: [
                    {
                      index: { byteStart: 0, byteEnd: 5 },
                      features: [
                        {
                          $type: 'app.bsky.richtext.facet#tag',
                          tag: 'batch',
                        },
                      ],
                    },
                  ],
                },
              },
              {
                convoId,
                message: {
                  text: 'Batch with embed',
                  embed: {
                    $type: 'app.bsky.embed.record',
                    record: {
                      uri: 'at://did:plc:batchtest/app.bsky.feed.post/xyz',
                      cid: 'bafyreifakebatch',
                    },
                  },
                },
              },
            ],
          }),
        },
      )

      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.items).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch max items limit (lines 309-312)
  // -----------------------------------------------------------------------

  describe('sendMessageBatch max items limit', () => {
    it('rejects batch with >100 items', async () => {
      const items = Array.from({ length: 101 }, () => ({
        convoId,
        message: { text: 'Overflow' },
      }))

      await expect(alice.agent.sendMessageBatch(items)).rejects.toThrow(
        /Batch size exceeds maximum of 100/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // deleteMessageForSelf edge cases
  // -----------------------------------------------------------------------

  describe('deleteMessageForSelf edge cases', () => {
    it('deleteMessageForSelf for non-existent message returns error', async () => {
      await expect(
        alice.agent.deleteMessageForSelf(convoId, 'nonexistent-msg-xyz'),
      ).rejects.toThrow(/Message not found/)
    })

    it('deleteMessageForSelf is idempotent (second delete succeeds)', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Delete idempotent test',
      })) as MessageView

      const res1 = (await alice.agent.deleteMessageForSelf(
        convoId,
        msg.id,
      )) as DeletedMessageView
      expect(res1.id).toBe(msg.id)

      const res2 = (await alice.agent.deleteMessageForSelf(
        convoId,
        msg.id,
      )) as DeletedMessageView
      expect(res2.id).toBe(msg.id)
    })
  })

  // -----------------------------------------------------------------------
  // sendMessage with facets and embed together
  // -----------------------------------------------------------------------

  describe('sendMessage with facets and embed together', () => {
    it('sendMessage with both facets and embed', async () => {
      const facets = [
        {
          index: { byteStart: 0, byteEnd: 5 },
          features: [
            { $type: 'app.bsky.richtext.facet#tag', tag: 'hello' },
          ],
        },
      ]
      const embed = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: 'at://did:plc:both/app.bsky.feed.post/001',
          cid: 'bafyreifakeboth',
        },
      }

      const msg = (await alice.agent.sendMessage(convoId, {
        text: '#hello world',
        facets,
        embed,
      })) as MessageView

      expect(msg.facets).toBeDefined()
      expect(msg.embed).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // getMessages for a left member
  // -----------------------------------------------------------------------

  describe('getMessages for left member', () => {
    it('left member can still read messages', async () => {
      const u1 = await createTestUser(network, 'msc-gmlf1.test')
      const u2 = await createTestUser(network, 'msc-gmlf2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      await u1.agent.sendMessage(cid, { text: 'Before leave' })
      await u1.agent.leaveConvo(cid)

      const res = (await u1.agent.getMessages(cid)) as GetMessagesResponse
      expect(res.messages).toBeDefined()
      expect(res.messages.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // getMessages without reactions
  // -----------------------------------------------------------------------

  describe('getMessages no reactions', () => {
    it('messages without reactions have no reactions array', async () => {
      const u1 = await createTestUser(network, 'msc-gmnr1.test')
      const u2 = await createTestUser(network, 'msc-gmnr2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      await u1.agent.sendMessage(cid, { text: 'No reaction msg' })

      const res = (await u1.agent.getMessages(cid)) as GetMessagesResponse
      expect(res.messages).toHaveLength(1)
      const msg = res.messages[0] as MessageView
      expect(
        msg.reactions === undefined || msg.reactions.length === 0,
      ).toBe(true)
    })
  })
})
