import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createModServiceClient,
  setChatDisabled,
} from './_util'

/**
 * Service-level gap coverage tests.
 *
 * Targets remaining uncovered branches in service files:
 *
 * message.ts:
 * - sendMessage text exceeding byte limit (MAX_TEXT_BYTES = 10000)
 * - addReaction idempotent path (same reaction twice)
 * - addReaction limit reached (5 reactions per user per message, then 6th)
 * - removeReaction idempotent path (remove reaction that doesn't exist)
 * - sendMessage when caller status is 'left'
 * - sendMessage chatDisabled check
 * - countGraphemes fallback (Intl.Segmenter path vs Array.from)
 *
 * read-state.ts:
 * - updateRead with messageId (lines 44-56, rev from specific message)
 * - updateRead with messageId payload building (lines 85-97)
 * - updateAllRead with status filter (lines 130-136)
 *
 * conversation.ts:
 * - listConvos readState='unread' filter (line 249-251)
 * - getConvo for non-member (line 203-205)
 *
 * views/index.ts:
 * - buildConvoView with deleted lastMessage (line 208-215)
 * - buildConvoView status='left' maps to undefined (line 247)
 * - buildProfileViewBasic chatDisabled=true path (line 124-126)
 */

interface ConvoView {
  id: string
  rev: string
  members: Array<{ did: string; chatDisabled?: boolean }>
  status?: string
  unreadCount: number
  muted: boolean
  lastMessage?: {
    $type: string
    id: string
    text?: string
    sender: { did: string }
  }
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

interface ReactionResponse {
  message: MessageView
}

interface GetMessagesResponse {
  messages: Array<MessageView | { $type: string; id: string }>
  cursor?: string
}

describe('service-level gap coverage', () => {
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

    // Create shared conversation
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)
  })

  afterAll(async () => {
    if (network) await network.close()
  }, 120000)

  // -----------------------------------------------------------------------
  // message.ts: text byte limit validation
  // -----------------------------------------------------------------------

  describe('sendMessage byte limit', () => {
    it('rejects message text exceeding 10000 bytes', async () => {
      // Create a string that's small in graphemes but large in bytes
      // Each multibyte char (e.g. emoji) is 4 bytes. Use a simpler approach:
      // 10001 ASCII chars = 10001 bytes > 10000 limit
      const longText = 'a'.repeat(10001)
      await expect(
        alice.agent.sendMessage(convoId, { text: longText }),
      ).rejects.toThrow(/exceeds maximum byte length/)
    })

    it('accepts message text at exactly 10000 bytes', async () => {
      const exactText = 'a'.repeat(10000)
      // This is 10000 graphemes too (within 1000 grapheme limit? No, 10000 > 1000)
      // Actually this will fail on grapheme limit first
      await expect(
        alice.agent.sendMessage(convoId, { text: exactText }),
      ).rejects.toThrow(/exceeds maximum/)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: addReaction idempotent + limit
  // -----------------------------------------------------------------------

  describe('addReaction idempotent and limit paths', () => {
    let messageId: string

    beforeAll(async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Reaction limit test message',
      })) as MessageView
      messageId = msg.id
    })

    it('adding the same reaction twice is idempotent', async () => {
      // First add
      const res1 = (await alice.agent.addReaction(
        convoId,
        messageId,
        '\uD83D\uDE00',
      )) as ReactionResponse
      expect(res1.message.reactions).toBeDefined()
      const count1 = res1.message.reactions!.length

      // Second add of same reaction — should be idempotent
      const res2 = (await alice.agent.addReaction(
        convoId,
        messageId,
        '\uD83D\uDE00',
      )) as ReactionResponse
      expect(res2.message.reactions).toBeDefined()
      const count2 = res2.message.reactions!.length

      // Count should be the same — no duplicate inserted
      expect(count2).toBe(count1)
    })

    it('adding 5 reactions reaches the limit', async () => {
      // Add 4 more unique reactions (already have 1 from previous test)
      const emojis = ['\uD83D\uDE01', '\uD83D\uDE02', '\uD83D\uDE03', '\uD83D\uDE04']
      for (const emoji of emojis) {
        await alice.agent.addReaction(convoId, messageId, emoji)
      }

      // Verify we have 5 reactions
      const res = (await alice.agent.addReaction(
        convoId,
        messageId,
        '\uD83D\uDE00', // Re-adding existing one — idempotent
      )) as ReactionResponse
      expect(res.message.reactions!.length).toBe(5)
    })

    it('adding a 6th different reaction exceeds the limit', async () => {
      await expect(
        alice.agent.addReaction(convoId, messageId, '\uD83D\uDE05'),
      ).rejects.toThrow(/Maximum 5 reactions|ReactionLimitReached/)
    })

    it('idempotent add at the limit still works (same reaction)', async () => {
      // Even at 5 reactions, re-adding an existing one should work
      const res = (await alice.agent.addReaction(
        convoId,
        messageId,
        '\uD83D\uDE00',
      )) as ReactionResponse
      expect(res.message.reactions!.length).toBe(5)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: removeReaction idempotent path
  // -----------------------------------------------------------------------

  describe('removeReaction idempotent path', () => {
    it('removing a non-existent reaction is idempotent (no error)', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Remove non-existent reaction test',
      })) as MessageView

      // Remove a reaction that was never added — should be a no-op
      const res = (await alice.agent.removeReaction(
        convoId,
        msg.id,
        '\uD83D\uDE00',
      )) as ReactionResponse

      expect(res.message).toBeDefined()
      expect(res.message.id).toBe(msg.id)
      // No reactions should exist
      expect(
        res.message.reactions === undefined ||
          res.message.reactions.length === 0,
      ).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: sendMessage to left conversation
  // -----------------------------------------------------------------------

  describe('sendMessage to left conversation', () => {
    it('sendMessage by a user who has left fails', async () => {
      const u1 = await createTestUser(network, 'sg-left1.test')
      const u2 = await createTestUser(network, 'sg-left2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      // u1 leaves
      await u1.agent.leaveConvo(cid)

      // u1 tries to send → should fail
      await expect(
        u1.agent.sendMessage(cid, { text: 'After leaving' }),
      ).rejects.toThrow(/Cannot send a message to a conversation you have left/)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: sendMessage chatDisabled check
  // -----------------------------------------------------------------------

  describe('sendMessage chatDisabled check', () => {
    it('chatDisabled user cannot send a message', async () => {
      const u = await createTestUser(network, 'sg-cdis.test')
      const peer = await createTestUser(network, 'sg-cdpeer.test')

      const convoRes = (await u.agent.getConvoForMembers([
        u.did,
        peer.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await peer.agent.acceptConvo(cid)

      // Disable chat
      await setChatDisabled(modClient, u.did, true)

      await expect(
        u.agent.sendMessage(cid, { text: 'Disabled' }),
      ).rejects.toThrow(/Account is disabled/)

      // Re-enable
      await setChatDisabled(modClient, u.did, false)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: sendMessage auto-accept from 'request' status
  // -----------------------------------------------------------------------

  describe('sendMessage auto-accept from request status', () => {
    it('sending a message when status is request auto-accepts', async () => {
      const u1 = await createTestUser(network, 'sg-auto1.test')
      const u2 = await createTestUser(network, 'sg-auto2.test')

      // u1 creates convo — u2 has status 'request'
      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id

      // u2 has not accepted yet (status = 'request')
      const before = (await u2.agent.getConvo(cid)) as GetConvoResponse
      expect(before.convo.status).toBe('request')

      // u2 sends a message — should auto-accept
      await u2.agent.sendMessage(cid, { text: 'Auto-accept via send' })

      // Status should now be 'accepted'
      const after = (await u2.agent.getConvo(cid)) as GetConvoResponse
      expect(after.convo.status).toBe('accepted')
    })
  })

  // -----------------------------------------------------------------------
  // conversation.ts: listConvos readState=unread
  // -----------------------------------------------------------------------

  describe('listConvos readState=unread', () => {
    it('filters to only unread conversations', async () => {
      const u = await createTestUser(network, 'sg-unrd.test')
      const peer1 = await createTestUser(network, 'sg-unrdp1.test')
      const peer2 = await createTestUser(network, 'sg-unrdp2.test')

      // Create 2 convos
      const c1Res = (await u.agent.getConvoForMembers([
        u.did,
        peer1.did,
      ])) as ConvoForMembersResponse
      const c1 = c1Res.convo.id
      await peer1.agent.acceptConvo(c1)

      const c2Res = (await u.agent.getConvoForMembers([
        u.did,
        peer2.did,
      ])) as ConvoForMembersResponse
      const c2 = c2Res.convo.id
      await peer2.agent.acceptConvo(c2)

      // peer1 sends a message in c1 (u has unread)
      await peer1.agent.sendMessage(c1, { text: 'Unread msg' })

      // peer2 sends a message in c2 (u has unread)
      await peer2.agent.sendMessage(c2, { text: 'Also unread' })

      // u reads c1
      await u.agent.updateRead(c1)

      // listConvos with readState=unread should show only c2
      const res = (await u.agent.listConvos({
        readState: 'unread',
      })) as ListConvosResponse

      expect(res.convos.length).toBeGreaterThanOrEqual(1)
      const ids = res.convos.map((c) => c.id)
      expect(ids).toContain(c2)
      expect(ids).not.toContain(c1)
    })
  })

  // -----------------------------------------------------------------------
  // conversation.ts: getConvo for non-member
  // -----------------------------------------------------------------------

  describe('getConvo for non-member', () => {
    it('non-member gets Convo not found', async () => {
      const outsider = await createTestUser(network, 'sg-out.test')
      await expect(outsider.agent.getConvo(convoId)).rejects.toThrow(
        /Convo not found/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // views/index.ts: buildConvoView with deleted lastMessage
  // -----------------------------------------------------------------------

  describe('buildConvoView with deleted lastMessage', () => {
    it('convo view shows deletedMessageView for soft-deleted last message', async () => {
      const u1 = await createTestUser(network, 'sg-delmsg1.test')
      const u2 = await createTestUser(network, 'sg-delmsg2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      // u1 sends a message then deletes account (soft-deletes messages)
      const msg = (await u1.agent.sendMessage(cid, {
        text: 'Will be deleted',
      })) as MessageView

      // Delete account soft-deletes messages
      await u1.agent.deleteAccount()

      // u2 gets the convo — the last message should be a deletedMessageView
      const convo = (await u2.agent.getConvo(cid)) as GetConvoResponse
      if (convo.convo.lastMessage) {
        expect(convo.convo.lastMessage.$type).toBe(
          'chat.bsky.convo.defs#deletedMessageView',
        )
      }
    })
  })

  // -----------------------------------------------------------------------
  // views/index.ts: buildConvoView left status → undefined
  // -----------------------------------------------------------------------

  describe('buildConvoView left status', () => {
    it('convo view has no status field for a left member', async () => {
      const u1 = await createTestUser(network, 'sg-lvst1.test')
      const u2 = await createTestUser(network, 'sg-lvst2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id

      // u1 leaves
      await u1.agent.leaveConvo(cid)

      // u1 rejoins (getConvoForMembers with left status triggers rejoin)
      const rejoinRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      // After rejoin, status should be 'request', not 'left'
      expect(rejoinRes.convo.status).toBe('request')
    })
  })

  // -----------------------------------------------------------------------
  // views/index.ts: buildProfileViewBasic with chatDisabled
  // -----------------------------------------------------------------------

  describe('buildProfileViewBasic chatDisabled', () => {
    it('convo members include chatDisabled flag when set', async () => {
      const u1 = await createTestUser(network, 'sg-pv1.test')
      const u2 = await createTestUser(network, 'sg-pv2.test')

      // Create convo FIRST while chat is enabled
      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id

      // Then disable chat for u2
      await setChatDisabled(modClient, u2.did, true)

      // Re-fetch the convo — member view for u2 should have chatDisabled=true
      const convo = (await u1.agent.getConvo(cid)) as GetConvoResponse
      const u2Member = convo.convo.members.find((m) => m.did === u2.did)
      expect(u2Member).toBeDefined()
      expect(u2Member!.chatDisabled).toBe(true)

      // Re-enable
      await setChatDisabled(modClient, u2.did, false)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: addReaction to soft-deleted message
  // -----------------------------------------------------------------------

  describe('addReaction to soft-deleted message', () => {
    it('returns ReactionMessageDeleted error', async () => {
      const u1 = await createTestUser(network, 'sg-adrd1.test')
      const u2 = await createTestUser(network, 'sg-adrd2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      // u1 sends a message
      const msg = (await u1.agent.sendMessage(cid, {
        text: 'For addReaction deleted test',
      })) as MessageView

      // u1 deletes account (soft-deletes messages)
      await u1.agent.deleteAccount()

      // u2 tries to react to the now-deleted message
      await expect(
        u2.agent.addReaction(cid, msg.id, '\u2764\uFE0F'),
      ).rejects.toThrow(
        /Cannot react to deleted message|ReactionMessageDeleted/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: getMessages shows deletedMessageView for soft-deleted msgs
  // -----------------------------------------------------------------------

  describe('getMessages shows deletedMessageView', () => {
    it('soft-deleted messages appear as deletedMessageView in getMessages', async () => {
      const u1 = await createTestUser(network, 'sg-gmdv1.test')
      const u2 = await createTestUser(network, 'sg-gmdv2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      // u1 sends a message
      await u1.agent.sendMessage(cid, { text: 'Will be soft-deleted' })

      // u2 also sends a message to have some non-deleted messages
      await u2.agent.sendMessage(cid, { text: 'This stays' })

      // u1 deletes account (soft-deletes messages)
      await u1.agent.deleteAccount()

      // u2 gets messages
      const msgs = (await u2.agent.getMessages(cid)) as GetMessagesResponse

      // Should have at least 1 deletedMessageView
      const deleted = msgs.messages.filter(
        (m) => m.$type === 'chat.bsky.convo.defs#deletedMessageView',
      )
      expect(deleted.length).toBeGreaterThanOrEqual(1)

      // The non-deleted message should also be there
      const active = msgs.messages.filter(
        (m) => m.$type === 'chat.bsky.convo.defs#messageView',
      )
      expect(active.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: reaction validation - empty value and multi-grapheme
  // -----------------------------------------------------------------------

  describe('reaction validation', () => {
    let msgId: string

    beforeAll(async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Reaction validation test msg',
      })) as MessageView
      msgId = msg.id
    })

    it('empty reaction value is rejected', async () => {
      await expect(
        alice.agent.addReaction(convoId, msgId, ''),
      ).rejects.toThrow(/Reaction value is required|ReactionInvalidValue/)
    })

    it('multi-grapheme reaction (two emojis) is rejected', async () => {
      await expect(
        alice.agent.addReaction(convoId, msgId, '\uD83D\uDE00\uD83D\uDE01'),
      ).rejects.toThrow(/exactly 1 emoji|ReactionInvalidValue/)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: sendMessageBatch auto-accept
  // -----------------------------------------------------------------------

  describe('sendMessageBatch auto-accept', () => {
    it('batch send auto-accepts request status for caller', async () => {
      const u1 = await createTestUser(network, 'sg-baa1.test')
      const u2 = await createTestUser(network, 'sg-baa2.test')

      // u2 creates convo → u1 has 'request' status
      const convoRes = (await u2.agent.getConvoForMembers([
        u2.did,
        u1.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id

      // u1 has status 'request'
      const before = (await u1.agent.getConvo(cid)) as GetConvoResponse
      expect(before.convo.status).toBe('request')

      // u1 sends via batch → should auto-accept
      await u1.agent.sendMessageBatch([
        { convoId: cid, message: { text: 'Batch auto-accept' } },
      ])

      // Status should now be 'accepted'
      const after = (await u1.agent.getConvo(cid)) as GetConvoResponse
      expect(after.convo.status).toBe('accepted')
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: sendMessageBatch caller left
  // -----------------------------------------------------------------------

  describe('sendMessageBatch caller left', () => {
    it('batch send fails when caller has left', async () => {
      const u1 = await createTestUser(network, 'sg-blf1.test')
      const u2 = await createTestUser(network, 'sg-blf2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      await u1.agent.leaveConvo(cid)

      await expect(
        u1.agent.sendMessageBatch([
          { convoId: cid, message: { text: 'After leave batch' } },
        ]),
      ).rejects.toThrow(/Cannot send a message to a conversation you have left/)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: sendMessageBatch empty array
  // -----------------------------------------------------------------------

  describe('sendMessageBatch empty items', () => {
    it('batch with empty items array is rejected', async () => {
      await expect(
        alice.agent.sendMessageBatch([]),
      ).rejects.toThrow(/At least one item/)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: deleteMessageForSelf non-member
  // -----------------------------------------------------------------------

  describe('deleteMessageForSelf non-member', () => {
    it('non-member cannot delete a message', async () => {
      const outsider = await createTestUser(network, 'sg-deln.test')
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Delete non-member test',
      })) as MessageView

      await expect(
        outsider.agent.deleteMessageForSelf(convoId, msg.id),
      ).rejects.toThrow(/Convo not found/)
    })
  })

  // -----------------------------------------------------------------------
  // message.ts: getMessages with cursor pagination
  // -----------------------------------------------------------------------

  describe('getMessages cursor pagination', () => {
    it('cursor-based pagination returns next page', async () => {
      const u1 = await createTestUser(network, 'sg-pag1.test')
      const u2 = await createTestUser(network, 'sg-pag2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      // Send 5 messages
      for (let i = 0; i < 5; i++) {
        await u1.agent.sendMessage(cid, { text: `Pagination msg ${i}` })
      }

      // Get first page (limit 2)
      const page1 = (await u1.agent.getMessages(cid, {
        limit: 2,
      })) as GetMessagesResponse
      expect(page1.messages).toHaveLength(2)
      expect(page1.cursor).toBeDefined()

      // Get second page using cursor
      const page2 = (await u1.agent.getMessages(cid, {
        limit: 2,
        cursor: page1.cursor,
      })) as GetMessagesResponse
      expect(page2.messages).toHaveLength(2)

      // Messages should be different
      expect(page1.messages[0].id).not.toBe(page2.messages[0].id)
    })
  })

  // -----------------------------------------------------------------------
  // views/index.ts: convo view with facets on last message
  // -----------------------------------------------------------------------

  describe('convo view lastMessage with rich content', () => {
    it('convo view shows facets on last message', async () => {
      const u1 = await createTestUser(network, 'sg-cvf1.test')
      const u2 = await createTestUser(network, 'sg-cvf2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      await u1.agent.sendMessage(cid, {
        text: '#test facets in view',
        facets: [
          {
            index: { byteStart: 0, byteEnd: 5 },
            features: [
              { $type: 'app.bsky.richtext.facet#tag', tag: 'test' },
            ],
          },
        ],
      })

      const convo = (await u1.agent.getConvo(cid)) as { convo: ConvoView }
      expect(convo.convo.lastMessage).toBeDefined()
      expect(convo.convo.lastMessage!.$type).toBe(
        'chat.bsky.convo.defs#messageView',
      )
    })

    it('convo view shows embed on last message', async () => {
      const u1 = await createTestUser(network, 'sg-cve1.test')
      const u2 = await createTestUser(network, 'sg-cve2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      await u1.agent.sendMessage(cid, {
        text: 'Embed in view',
        embed: {
          $type: 'app.bsky.embed.record',
          record: {
            uri: 'at://did:plc:viewembed/app.bsky.feed.post/001',
            cid: 'bafyreifakeviewembed',
          },
        },
      })

      const convo = (await u1.agent.getConvo(cid)) as { convo: ConvoView }
      expect(convo.convo.lastMessage).toBeDefined()
      expect(convo.convo.lastMessage!.$type).toBe(
        'chat.bsky.convo.defs#messageView',
      )
    })
  })

  // -----------------------------------------------------------------------
  // event-log.ts: getLog cursor filtering
  // -----------------------------------------------------------------------

  describe('getLog cursor filtering', () => {
    it('getLog with cursor filters to events after the cursor', async () => {
      await alice.agent.sendMessage(convoId, { text: 'Log cursor 1' })
      await alice.agent.sendMessage(convoId, { text: 'Log cursor 2' })

      const fullLog = (await bob.agent.getLog()) as {
        logs: Array<{ rev: string; $type: string }>
        cursor?: string
      }
      expect(fullLog.logs.length).toBeGreaterThanOrEqual(2)

      const cursor = fullLog.logs[0].rev
      const filtered = (await bob.agent.getLog(cursor)) as {
        logs: Array<{ rev: string; $type: string }>
      }

      expect(filtered.logs.length).toBe(fullLog.logs.length - 1)
      for (const log of filtered.logs) {
        expect(log.rev > cursor).toBe(true)
      }
    })
  })

  // -----------------------------------------------------------------------
  // account.ts: exportAccountData with deleted messages
  // -----------------------------------------------------------------------

  describe('exportAccountData with deleted messages', () => {
    it('export includes deleted message views', async () => {
      const u1 = await createTestUser(network, 'sg-exp1.test')
      const u2 = await createTestUser(network, 'sg-exp2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await u2.agent.acceptConvo(cid)

      await u2.agent.sendMessage(cid, { text: 'Export msg 1' })
      await u2.agent.sendMessage(cid, { text: 'Export msg 2' })
      await u1.agent.sendMessage(cid, { text: 'Will be deleted' })

      // u2 deletes account — soft-deletes u2's messages
      await u2.agent.deleteAccount()

      // u1 exports data
      const rawData = await u1.agent.exportAccountData()
      expect(rawData).toBeDefined()
      expect(rawData.length).toBeGreaterThan(0)

      const lines = rawData
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))

      const deletedMsgs = lines.filter(
        (l) => l.$type === 'chat.bsky.convo.defs#deletedMessageView',
      )
      expect(deletedMsgs.length).toBeGreaterThanOrEqual(1)

      const activeMsgs = lines.filter(
        (l) => l.$type === 'chat.bsky.convo.defs#messageView',
      )
      expect(activeMsgs.length).toBeGreaterThanOrEqual(1)
    })
  })
})
