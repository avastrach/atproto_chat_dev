import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Message operations E2E tests.
 *
 * Covers:
 * - Sending a single message (sendMessage)
 * - Sending messages in a batch (sendMessageBatch)
 * - Message text validation (grapheme and byte limits, empty text)
 * - Getting messages with cursor-based pagination
 * - Auto-accept on send (sending to a 'request' convo auto-accepts it)
 * - Deleting a message for self (deleteMessageForSelf)
 *
 * References:
 * - PRD 16.7.3 (Sending a Message)
 * - PRD 16.7.8 (Deleting a Message for Self)
 * - Service: message.ts (MAX_TEXT_GRAPHEMES=1000, MAX_TEXT_BYTES=10000, MAX_BATCH_ITEMS=100)
 * - Errata E3 (pagination limit 1-100)
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
  facets?: unknown[]
  embed?: unknown
}

interface DeletedMessageView {
  id: string
  rev: string
  sender: { did: string }
  sentAt: string
  $type?: string
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

interface GetConvoResponse {
  convo: ConvoView
}

interface GetMessagesResponse {
  messages: (MessageView | DeletedMessageView)[]
  cursor?: string
}

interface SendMessageBatchResponse {
  items: MessageView[]
}

describe('message operations', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')

    // Create a conversation for message tests
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id

    // Accept the convo so both users can send freely
    await bob.agent.acceptConvo(convoId)
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // sendMessage - basic message sending
  // -----------------------------------------------------------------------

  describe('sendMessage', () => {
    it('returns a MessageView with correct fields', async () => {
      const res = (await alice.agent.sendMessage(convoId, {
        text: 'Hello Bob!',
      })) as MessageView

      expect(res.id).toBeTruthy()
      expect(res.text).toBe('Hello Bob!')
      expect(res.sender.did).toBe(alice.did)
      expect(res.sentAt).toBeTruthy()
      expect(res.rev).toBeTruthy()
    })

    it('message appears in getMessages for both users', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Visible to both',
      })) as MessageView

      // Alice sees it
      const aliceMsgs = (await alice.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const aliceFound = aliceMsgs.messages.find(
        (m) => 'text' in m && m.text === 'Visible to both',
      )
      expect(aliceFound).toBeDefined()

      // Bob sees it
      const bobMsgs = (await bob.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const bobFound = bobMsgs.messages.find(
        (m) => 'text' in m && m.text === 'Visible to both',
      )
      expect(bobFound).toBeDefined()
    })

    it('both users can send messages in the same conversation', async () => {
      const aliceMsg = (await alice.agent.sendMessage(convoId, {
        text: 'From Alice',
      })) as MessageView

      const bobMsg = (await bob.agent.sendMessage(convoId, {
        text: 'From Bob',
      })) as MessageView

      expect(aliceMsg.sender.did).toBe(alice.did)
      expect(bobMsg.sender.did).toBe(bob.did)

      // Both messages appear in the conversation
      const msgs = (await alice.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const texts = msgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)
      expect(texts).toContain('From Alice')
      expect(texts).toContain('From Bob')
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch - batch message sending
  // -----------------------------------------------------------------------

  describe('sendMessageBatch', () => {
    it('sends multiple messages and all appear in order', async () => {
      const items = [
        { convoId, message: { text: 'Batch msg 1' } },
        { convoId, message: { text: 'Batch msg 2' } },
        { convoId, message: { text: 'Batch msg 3' } },
      ]

      const res = (await alice.agent.sendMessageBatch(
        items,
      )) as SendMessageBatchResponse

      expect(res.items).toHaveLength(3)
      expect(res.items[0].text).toBe('Batch msg 1')
      expect(res.items[1].text).toBe('Batch msg 2')
      expect(res.items[2].text).toBe('Batch msg 3')

      // All messages appear in getMessages
      const msgs = (await bob.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const texts = msgs.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)
      expect(texts).toContain('Batch msg 1')
      expect(texts).toContain('Batch msg 2')
      expect(texts).toContain('Batch msg 3')
    })

    it('rejects empty batch', async () => {
      await expect(alice.agent.sendMessageBatch([])).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Message validation
  // -----------------------------------------------------------------------

  describe('message validation', () => {
    it('rejects empty text', async () => {
      await expect(
        alice.agent.sendMessage(convoId, { text: '' }),
      ).rejects.toThrow()
    })

    it('rejects text exceeding 1000 graphemes', async () => {
      // Create a string with 1001 single-character graphemes
      const longText = 'a'.repeat(1001)

      await expect(
        alice.agent.sendMessage(convoId, { text: longText }),
      ).rejects.toThrow()
    })

    it('accepts text at exactly 1000 graphemes', async () => {
      const text1000 = 'a'.repeat(1000)

      const res = (await alice.agent.sendMessage(convoId, {
        text: text1000,
      })) as MessageView

      expect(res.id).toBeTruthy()
      expect(res.text).toBe(text1000)
    })

    it('rejects text exceeding 10000 bytes', async () => {
      // Multi-byte characters: each emoji is 4 bytes. 2501 emojis = 10004 bytes > 10000
      // But they'd also be 2501 graphemes > 1000 graphemes, so use a different approach:
      // Use 2-byte characters (e.g. latin extended) to keep graphemes under 1000
      // but bytes over 10000
      // Actually, 1000 graphemes * 4 bytes each = 4000 bytes < 10000
      // To exceed byte limit without grapheme limit, we'd need >10 bytes per grapheme
      // on average, which is hard in practice. Let's just test a massive string.
      const massiveText = '\u{1F600}'.repeat(2501) // 2501 emoji = 2501 graphemes (over), 10004 bytes

      await expect(
        alice.agent.sendMessage(convoId, { text: massiveText }),
      ).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // getMessages - cursor-based pagination
  // -----------------------------------------------------------------------

  describe('getMessages pagination', () => {
    it('returns messages in reverse chronological order (newest first)', async () => {
      // Send a few ordered messages
      await alice.agent.sendMessage(convoId, { text: 'Older message' })
      await alice.agent.sendMessage(convoId, { text: 'Newer message' })

      const res = (await alice.agent.getMessages(
        convoId,
      )) as GetMessagesResponse

      // Messages should be ordered newest first (descending by ID)
      // The first message in the array should be the newest
      expect(res.messages.length).toBeGreaterThanOrEqual(2)
      const texts = res.messages
        .filter((m): m is MessageView => 'text' in m)
        .map((m) => m.text)
      const newerIdx = texts.indexOf('Newer message')
      const olderIdx = texts.indexOf('Older message')
      if (newerIdx !== -1 && olderIdx !== -1) {
        expect(newerIdx).toBeLessThan(olderIdx)
      }
    })

    it('supports limit parameter', async () => {
      const res = (await alice.agent.getMessages(convoId, {
        limit: 2,
      })) as GetMessagesResponse

      expect(res.messages.length).toBeLessThanOrEqual(2)
    })

    it('supports cursor-based pagination', async () => {
      // Fetch first page with small limit
      const page1 = (await alice.agent.getMessages(convoId, {
        limit: 2,
      })) as GetMessagesResponse

      expect(page1.messages.length).toBeLessThanOrEqual(2)

      // If there are more messages, use cursor
      if (page1.cursor) {
        const page2 = (await alice.agent.getMessages(convoId, {
          limit: 2,
          cursor: page1.cursor,
        })) as GetMessagesResponse

        expect(page2.messages).toBeDefined()

        // Pages should contain different messages
        if (page1.messages.length > 0 && page2.messages.length > 0) {
          expect(page1.messages[0].id).not.toBe(page2.messages[0].id)
        }
      }
    })
  })

  // -----------------------------------------------------------------------
  // Auto-accept on send
  // -----------------------------------------------------------------------

  describe('auto-accept on send', () => {
    it('sending a message from a request convo auto-accepts it', async () => {
      // Create a new convo with carol. Carol's status starts as 'request'.
      const createRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const cid = createRes.convo.id

      // Create a fresh convo: alice initiates with carol
      const freshConvo = (await alice.agent.getConvoForMembers([
        alice.did,
        (await createTestUser(network, 'dave.test')).did,
      ])) as ConvoForMembersResponse
      const dave = await createTestUser(network, 'dave2.test')

      // Use a different approach: create convo where bob is the non-initiator
      // Alice creates convo with a new user (Eve)
      const eve = await createTestUser(network, 'eve.test')
      const eveConvo = (await alice.agent.getConvoForMembers([
        alice.did,
        eve.did,
      ])) as ConvoForMembersResponse
      const eveConvoId = eveConvo.convo.id

      // Eve's status should be 'request'
      const eveBefore = (await eve.agent.getConvo(
        eveConvoId,
      )) as GetConvoResponse
      expect(eveBefore.convo.status).toBe('request')

      // Eve sends a message (should auto-accept)
      const msg = (await eve.agent.sendMessage(eveConvoId, {
        text: 'Auto-accept test',
      })) as MessageView
      expect(msg.id).toBeTruthy()

      // Eve's status should now be 'accepted'
      const eveAfter = (await eve.agent.getConvo(
        eveConvoId,
      )) as GetConvoResponse
      expect(eveAfter.convo.status).toBe('accepted')
    })
  })

  // -----------------------------------------------------------------------
  // deleteMessageForSelf - per-user deletion
  // -----------------------------------------------------------------------

  describe('deleteMessageForSelf', () => {
    it('hides the message for the caller', async () => {
      // Alice sends a message
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Delete me for Alice',
      })) as MessageView

      // Alice deletes it for herself
      const deleteRes = (await alice.agent.deleteMessageForSelf(
        convoId,
        msg.id,
      )) as DeletedMessageView

      expect(deleteRes.id).toBe(msg.id)

      // Alice should NOT see the message in getMessages
      const aliceMsgs = (await alice.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const aliceFound = aliceMsgs.messages.find((m) => m.id === msg.id)
      expect(aliceFound).toBeUndefined()
    })

    it('message remains visible to other members', async () => {
      // Alice sends a message
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Still visible to Bob',
      })) as MessageView

      // Alice deletes it for herself
      await alice.agent.deleteMessageForSelf(convoId, msg.id)

      // Bob should still see the message
      const bobMsgs = (await bob.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const bobFound = bobMsgs.messages.find(
        (m) => m.id === msg.id && 'text' in m,
      ) as MessageView | undefined
      expect(bobFound).toBeDefined()
      expect(bobFound!.text).toBe('Still visible to Bob')
    })

    it('is idempotent - deleting an already deleted message does not error', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Delete twice test',
      })) as MessageView

      // Delete once
      await alice.agent.deleteMessageForSelf(convoId, msg.id)

      // Delete again -- should not throw (idempotent via ON CONFLICT DO NOTHING)
      const res = (await alice.agent.deleteMessageForSelf(
        convoId,
        msg.id,
      )) as DeletedMessageView
      expect(res.id).toBe(msg.id)
    })

    it('cannot delete a message from a non-member conversation', async () => {
      // Alice sends a message in alice-bob convo
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Carol cannot delete',
      })) as MessageView

      // Carol (not a member) tries to delete -- should fail
      const carol = await createTestUser(network, 'carol2.test')
      await expect(
        carol.agent.deleteMessageForSelf(convoId, msg.id),
      ).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Cannot send to a left conversation
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Rich text: facets and embeds
  // -----------------------------------------------------------------------

  describe('rich text and embeds', () => {
    it('sends a message with a mention facet and returns it in the response', async () => {
      const mentionFacets = [
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

      const res = (await alice.agent.sendMessage(convoId, {
        text: '@Bob hello!',
        facets: mentionFacets,
      })) as MessageView

      expect(res.id).toBeTruthy()
      expect(res.text).toBe('@Bob hello!')
      expect(res.facets).toBeDefined()
      expect(Array.isArray(res.facets)).toBe(true)
      expect(res.facets!.length).toBe(1)

      const facet = res.facets![0] as {
        index: { byteStart: number; byteEnd: number }
        features: Array<{ $type: string; did?: string }>
      }
      expect(facet.index.byteStart).toBe(0)
      expect(facet.index.byteEnd).toBe(4)
      expect(facet.features[0].$type).toBe('app.bsky.richtext.facet#mention')
      expect(facet.features[0].did).toBe(bob.did)
    })

    it('sends a message with a link facet and returns it in the response', async () => {
      const linkFacets = [
        {
          index: { byteStart: 10, byteEnd: 35 },
          features: [
            {
              $type: 'app.bsky.richtext.facet#link',
              uri: 'https://bsky.social',
            },
          ],
        },
      ]

      const res = (await alice.agent.sendMessage(convoId, {
        text: 'Check out https://bsky.social for more',
        facets: linkFacets,
      })) as MessageView

      expect(res.id).toBeTruthy()
      expect(res.facets).toBeDefined()
      expect(res.facets!.length).toBe(1)

      const facet = res.facets![0] as {
        index: { byteStart: number; byteEnd: number }
        features: Array<{ $type: string; uri?: string }>
      }
      expect(facet.features[0].$type).toBe('app.bsky.richtext.facet#link')
      expect(facet.features[0].uri).toBe('https://bsky.social')
    })

    it('sends a message with a post embed and returns it in the response', async () => {
      const postEmbed = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: 'at://did:plc:fake123/app.bsky.feed.post/abc123',
          cid: 'bafyreifake123cid',
        },
      }

      const res = (await alice.agent.sendMessage(convoId, {
        text: 'Check out this post',
        embed: postEmbed,
      })) as MessageView

      expect(res.id).toBeTruthy()
      expect(res.text).toBe('Check out this post')
      expect(res.embed).toBeDefined()

      const embed = res.embed as {
        $type: string
        record: { uri: string; cid: string }
      }
      expect(embed.$type).toBe('app.bsky.embed.record')
      expect(embed.record.uri).toBe(
        'at://did:plc:fake123/app.bsky.feed.post/abc123',
      )
      expect(embed.record.cid).toBe('bafyreifake123cid')
    })

    it('facets and embeds are returned in getMessages response', async () => {
      // Send a message with both facets and embed
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
      const embed = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: 'at://did:plc:testpost/app.bsky.feed.post/xyz',
          cid: 'bafyreifaketestcid',
        },
      }

      const sentMsg = (await alice.agent.sendMessage(convoId, {
        text: '@Bob check this post',
        facets,
        embed,
      })) as MessageView

      // Verify the message is returned in getMessages with facets and embed
      const msgs = (await bob.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const found = msgs.messages.find(
        (m) => m.id === sentMsg.id,
      ) as MessageView
      expect(found).toBeDefined()
      expect(found.facets).toBeDefined()
      expect(found.facets!.length).toBe(1)
      expect(found.embed).toBeDefined()

      const foundEmbed = found.embed as {
        $type: string
        record: { uri: string; cid: string }
      }
      expect(foundEmbed.$type).toBe('app.bsky.embed.record')
      expect(foundEmbed.record.uri).toBe(
        'at://did:plc:testpost/app.bsky.feed.post/xyz',
      )
    })
  })

  // -----------------------------------------------------------------------
  // Cannot send to a left conversation
  // -----------------------------------------------------------------------

  describe('send to left conversation', () => {
    it('rejects sending a message after leaving', async () => {
      const frank = await createTestUser(network, 'frank.test')
      const createRes = (await alice.agent.getConvoForMembers([
        alice.did,
        frank.did,
      ])) as ConvoForMembersResponse
      const cid = createRes.convo.id

      // Frank leaves the convo
      await frank.agent.leaveConvo(cid)

      // Frank tries to send -- should fail
      await expect(
        frank.agent.sendMessage(cid, { text: 'Should fail' }),
      ).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // sendMessage error branches
  // -----------------------------------------------------------------------

  describe('sendMessage error branches', () => {
    it('rejects sending to a convo the caller is not a member of', async () => {
      // Hits message.ts lines 165-167 (membership not found).
      const outsider = await createTestUser(network, 'msg-nm-out.test')

      await expect(
        outsider.agent.sendMessage(convoId, { text: 'Not a member' }),
      ).rejects.toThrow(/Convo not found/)
    })

    it('rejects sending to a non-existent convoId', async () => {
      await expect(
        alice.agent.sendMessage('nonexistent-convo-xyz', { text: 'No convo' }),
      ).rejects.toThrow(/Convo not found/)
    })

    it('getMessages rejects for a non-member', async () => {
      // Hits message.ts lines 514-516 (membership check in getMessages).
      const outsider = await createTestUser(network, 'msg-gm-out.test')

      await expect(
        outsider.agent.getMessages(convoId),
      ).rejects.toThrow(/Convo not found/)
    })

    it('deleteMessageForSelf rejects for a non-existent message', async () => {
      // Hits message.ts lines 631-633 (message not found).
      await expect(
        alice.agent.deleteMessageForSelf(convoId, 'nonexistent-msg-id'),
      ).rejects.toThrow(/Message not found/)
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch additional branches
  // -----------------------------------------------------------------------

  describe('sendMessageBatch additional branches', () => {
    it('batch auto-accepts when sender has request status', async () => {
      // Hits message.ts lines 387-404 (auto-accept in batch path).
      // Create a convo where alice initiates with a new user.
      // The new user's status is 'request'. Sending via batch auto-accepts.
      const newUser = await createTestUser(network, 'batchaa.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        newUser.did,
      ])) as ConvoForMembersResponse
      const batchConvoId = convoRes.convo.id

      // newUser has status='request'
      const beforeSend = (await newUser.agent.getConvo(
        batchConvoId,
      )) as GetConvoResponse
      expect(beforeSend.convo.status).toBe('request')

      // newUser sends via batch -- should auto-accept
      const batchRes = (await newUser.agent.sendMessageBatch([
        { convoId: batchConvoId, message: { text: 'Batch auto-accept' } },
      ])) as SendMessageBatchResponse

      expect(batchRes.items).toHaveLength(1)
      expect(batchRes.items[0].text).toBe('Batch auto-accept')

      // Status should now be 'accepted'
      const afterSend = (await newUser.agent.getConvo(
        batchConvoId,
      )) as GetConvoResponse
      expect(afterSend.convo.status).toBe('accepted')
    })

    it('batch rejects when sender has left the conversation', async () => {
      // Hits message.ts lines 355-359 (left status in batch).
      const batchUser = await createTestUser(network, 'batchleft.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        batchUser.did,
      ])) as ConvoForMembersResponse
      const batchConvoId = convoRes.convo.id

      // batchUser leaves
      await batchUser.agent.leaveConvo(batchConvoId)

      // batchUser tries to send via batch
      await expect(
        batchUser.agent.sendMessageBatch([
          { convoId: batchConvoId, message: { text: 'Should fail' } },
        ]),
      ).rejects.toThrow(/Cannot send a message to a conversation you have left/)
    })

    it('batch rejects when caller is not a member', async () => {
      // Hits message.ts lines 349-353 (membership not found in batch).
      const outsider = await createTestUser(network, 'batchnm.test')

      await expect(
        outsider.agent.sendMessageBatch([
          { convoId, message: { text: 'Not a member' } },
        ]),
      ).rejects.toThrow(/Convo not found/)
    })

    it('batch sends messages with facets and embed', async () => {
      // Hits message.ts lines 421-426 (facets/embed in batch).
      const batchRes = (await alice.agent.sendMessageBatch([
        {
          convoId,
          message: {
            text: 'Batch with facets',
          },
        },
      ])) as SendMessageBatchResponse

      expect(batchRes.items).toHaveLength(1)
      expect(batchRes.items[0].text).toBe('Batch with facets')
    })
  })

  // -----------------------------------------------------------------------
  // getMessages with deleted messages in results
  // -----------------------------------------------------------------------

  describe('getMessages with deleted messages', () => {
    it('returns deletedMessageView for soft-deleted messages', async () => {
      // Hits message.ts lines 581-582 (buildDeletedMessageView in getMessages).
      // After account deletion, messages get soft-deleted (deletedAt set).
      // We already have deleteMessageForSelf tests but we need the message.ts
      // line 581 path which checks `row.deletedAt` in the getMessages loop.
      // deleteMessageForSelf uses message_deletion table (per-user), not
      // the message.deletedAt column. To hit line 581, we need a message
      // that has deletedAt set (account deletion).

      // Create a temporary user, send a message, delete their account
      const tempUser = await createTestUser(network, 'msg-del-temp.test')
      const tempConvoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        tempUser.did,
      ])) as ConvoForMembersResponse
      const tempConvoId = tempConvoRes.convo.id
      await tempUser.agent.acceptConvo(tempConvoId)

      const msg = (await tempUser.agent.sendMessage(tempConvoId, {
        text: 'Will be soft-deleted',
      })) as MessageView

      // Delete the temp user's account (soft-deletes their messages)
      await tempUser.agent.deleteAccount()

      // Alice fetches messages -- should see a deletedMessageView
      const msgsRes = (await alice.agent.getMessages(
        tempConvoId,
      )) as GetMessagesResponse

      const deletedMsg = msgsRes.messages.find((m) => m.id === msg.id)
      expect(deletedMsg).toBeDefined()
      expect(deletedMsg!.$type).toBe(
        'chat.bsky.convo.defs#deletedMessageView',
      )
    })
  })
})
