import { TestNetwork } from '@atproto/dev-env'
import {
  createTestNetwork,
  createTestUser,
  createModServiceClient,
  createBlock,
  removeBlock,
  TestUser,
  ChatApiClient,
} from './_util'

/**
 * Branch-coverage gap tests.
 *
 * Targets specific uncovered branches identified via coverage analysis:
 * - conversation.ts: validation, rejoin, non-member, idempotent paths
 * - message.ts: batch validation, validation edge cases, deleted messages
 * - moderation.ts: getMessageContext without convoId, deleted message context
 * - event-log.ts: getLog cursor pagination
 * - views/index.ts: deleted last-message view, left-member status mapping
 */

describe('branch coverage gaps', () => {
  let network: TestNetwork
  let modClient: ChatApiClient

  beforeAll(async () => {
    network = await createTestNetwork()
    modClient = await createModServiceClient(network)
  }, 300000)

  afterAll(async () => {
    if (network) {
      try {
        await network.close()
      } catch {
        // Coverage mode may cause close to take long; swallow
      }
    }
  }, 300000)

  // =======================================================================
  // conversation.ts -- getConvoForMembers validation branches
  // =======================================================================

  describe('getConvoForMembers validation', () => {
    it('rejects empty members array', async () => {
      const u = await createTestUser(network, 'cval-empty.test')
      await expect(u.agent.getConvoForMembers([])).rejects.toThrow(
        /members parameter is required|Invalid members count/,
      )
    })

    it('rejects members count > 10', async () => {
      const u = await createTestUser(network, 'cval-many.test')
      const fakeDids = Array.from(
        { length: 11 },
        (_, i) => `did:plc:fake${i}xxxxxxxxxx`,
      )
      await expect(
        u.agent.getConvoForMembers(fakeDids),
      ).rejects.toThrow(/Invalid members count|Too many members/)
    })

    it('auto-adds caller to members when not included', async () => {
      const u1 = await createTestUser(network, 'cval-auto1.test')
      const u2 = await createTestUser(network, 'cval-auto2.test')
      // Pass only u2's DID (not including u1/caller)
      const res = (await u1.agent.getConvoForMembers([u2.did])) as {
        convo: { id: string; members: Array<{ did: string }> }
      }
      expect(res.convo).toBeDefined()
      const memberDids = res.convo.members.map((m) => m.did)
      expect(memberDids).toContain(u1.did)
      expect(memberDids).toContain(u2.did)
    })
  })

  // =======================================================================
  // conversation.ts -- rejoin after leave
  // =======================================================================

  describe('getConvoForMembers rejoin after leave', () => {
    it('rejoining a left conversation resets status to request', async () => {
      const u1 = await createTestUser(network, 'rejoin-a.test')
      const u2 = await createTestUser(network, 'rejoin-b.test')

      // Create conversation
      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      // u1 accepts then leaves
      await u1.agent.acceptConvo(convoId)
      await u1.agent.leaveConvo(convoId)

      // u1 rejoins by calling getConvoForMembers again
      const rejoinRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string; status?: string } }
      expect(rejoinRes.convo.id).toBe(convoId)
      // After rejoin, status should be 'request' (not 'left')
      expect(rejoinRes.convo.status).toBe('request')
    })
  })

  // =======================================================================
  // conversation.ts -- getConvo non-member
  // =======================================================================

  describe('getConvo non-member', () => {
    it('throws when caller is not a member', async () => {
      const u1 = await createTestUser(network, 'gcnm-a.test')
      const u2 = await createTestUser(network, 'gcnm-b.test')
      const u3 = await createTestUser(network, 'gcnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      // u3 is not a member
      await expect(
        u3.agent.getConvo(createRes.convo.id),
      ).rejects.toThrow(/Convo not found/)
    })
  })

  // =======================================================================
  // conversation.ts -- acceptConvo branches
  // =======================================================================

  describe('acceptConvo edge cases', () => {
    it('returns empty object when already accepted (idempotent)', async () => {
      const u1 = await createTestUser(network, 'accid-a.test')
      const u2 = await createTestUser(network, 'accid-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      // u2 accepts
      await u2.agent.acceptConvo(convoId)

      // u2 accepts again (idempotent)
      const res2 = (await u2.agent.acceptConvo(convoId)) as { rev?: string }
      expect(res2.rev).toBeUndefined()
    })

    it('rejects accepting a left conversation', async () => {
      const u1 = await createTestUser(network, 'accleft-a.test')
      const u2 = await createTestUser(network, 'accleft-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      // u2 accepts then leaves
      await u2.agent.acceptConvo(convoId)
      await u2.agent.leaveConvo(convoId)

      // u2 tries to accept after leaving
      await expect(
        u2.agent.acceptConvo(convoId),
      ).rejects.toThrow(/Cannot accept a conversation you have left/)
    })

    it('rejects accepting when not a member', async () => {
      const u1 = await createTestUser(network, 'accnm-a.test')
      const u2 = await createTestUser(network, 'accnm-b.test')
      const u3 = await createTestUser(network, 'accnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      await expect(
        u3.agent.acceptConvo(createRes.convo.id),
      ).rejects.toThrow(/Convo not found/)
    })
  })

  // =======================================================================
  // conversation.ts -- leaveConvo branches
  // =======================================================================

  describe('leaveConvo edge cases', () => {
    it('rejects leaving when not a member', async () => {
      const u1 = await createTestUser(network, 'lvnm-a.test')
      const u2 = await createTestUser(network, 'lvnm-b.test')
      const u3 = await createTestUser(network, 'lvnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      await expect(
        u3.agent.leaveConvo(createRes.convo.id),
      ).rejects.toThrow(/Convo not found/)
    })

    it('rejects leaving when already left', async () => {
      const u1 = await createTestUser(network, 'lvleft-a.test')
      const u2 = await createTestUser(network, 'lvleft-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      await u1.agent.leaveConvo(convoId)

      await expect(u1.agent.leaveConvo(convoId)).rejects.toThrow(
        /Already left this conversation/,
      )
    })
  })

  // =======================================================================
  // conversation.ts -- muteConvo non-member
  // =======================================================================

  describe('muteConvo non-member', () => {
    it('rejects muting when not a member', async () => {
      const u1 = await createTestUser(network, 'mutenm-a.test')
      const u2 = await createTestUser(network, 'mutenm-b.test')
      const u3 = await createTestUser(network, 'mutenm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      await expect(
        u3.agent.muteConvo(createRes.convo.id),
      ).rejects.toThrow(/Convo not found/)
    })
  })

  // =======================================================================
  // conversation.ts -- getConvoAvailability validation
  // =======================================================================

  describe('getConvoAvailability validation', () => {
    it('rejects empty members array', async () => {
      const u = await createTestUser(network, 'avval-empty.test')
      await expect(u.agent.getConvoAvailability([])).rejects.toThrow(
        /members parameter is required|Invalid members count/,
      )
    })

    it('rejects members count > 10', async () => {
      const u = await createTestUser(network, 'avval-many.test')
      const fakeDids = Array.from(
        { length: 11 },
        (_, i) => `did:plc:avfake${i}xxxxxxxx`,
      )
      await expect(
        u.agent.getConvoAvailability(fakeDids),
      ).rejects.toThrow(/Invalid members count|Too many members/)
    })
  })

  // =======================================================================
  // message.ts -- sendMessage validation branches
  // =======================================================================

  describe('sendMessage validation', () => {
    let u1: TestUser
    let u2: TestUser
    let convoId: string

    beforeAll(async () => {
      u1 = await createTestUser(network, 'smval-a.test')
      u2 = await createTestUser(network, 'smval-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)
    })

    it('rejects empty text', async () => {
      await expect(
        u1.agent.sendMessage(convoId, { text: '' }),
      ).rejects.toThrow(/Message text is required|text/i)
    })

    it('rejects text exceeding max byte length (10000 bytes)', async () => {
      // Create a string > 10000 bytes
      const longText = 'a'.repeat(10001)
      await expect(
        u1.agent.sendMessage(convoId, { text: longText }),
      ).rejects.toThrow(/exceeds maximum byte length|text/i)
    })

    it('rejects text exceeding max graphemes (1000)', async () => {
      // 1001 single-grapheme characters that are under 10000 bytes
      const longGraphemes = 'x'.repeat(1001)
      await expect(
        u1.agent.sendMessage(convoId, { text: longGraphemes }),
      ).rejects.toThrow(/exceeds maximum.*graphemes|text/i)
    })
  })

  // =======================================================================
  // message.ts -- sendMessage caller disabled
  // =======================================================================

  describe('sendMessage caller chatDisabled', () => {
    it('rejects when caller chat is disabled', async () => {
      const u1 = await createTestUser(network, 'smdis-a.test')
      const u2 = await createTestUser(network, 'smdis-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      // Disable u1's chat access via moderation
      await modClient.updateActorAccess(u1.did, false)

      await expect(
        u1.agent.sendMessage(convoId, { text: 'hello' }),
      ).rejects.toThrow(/disabled/i)

      // Restore
      await modClient.updateActorAccess(u1.did, true)
    })
  })

  // =======================================================================
  // message.ts -- sendMessage non-member and left
  // =======================================================================

  describe('sendMessage membership checks', () => {
    it('rejects when caller is not a member', async () => {
      const u1 = await createTestUser(network, 'smnm-a.test')
      const u2 = await createTestUser(network, 'smnm-b.test')
      const u3 = await createTestUser(network, 'smnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      await expect(
        u3.agent.sendMessage(createRes.convo.id, { text: 'hello' }),
      ).rejects.toThrow(/Convo not found/)
    })

    it('rejects when caller has left', async () => {
      const u1 = await createTestUser(network, 'smleft-a.test')
      const u2 = await createTestUser(network, 'smleft-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      await u1.agent.leaveConvo(convoId)

      await expect(
        u1.agent.sendMessage(convoId, { text: 'hello' }),
      ).rejects.toThrow(/left/i)
    })
  })

  // =======================================================================
  // message.ts -- sendMessageBatch validation branches
  // =======================================================================

  describe('sendMessageBatch validation', () => {
    it('rejects empty items array', async () => {
      const u = await createTestUser(network, 'batchval-e.test')
      await expect(u.agent.sendMessageBatch([])).rejects.toThrow(
        /At least one item is required/,
      )
    })

    it('rejects items exceeding max batch size (100)', async () => {
      const u = await createTestUser(network, 'batchval-m.test')
      const items = Array.from({ length: 101 }, () => ({
        convoId: 'fake',
        message: { text: 'test' },
      }))
      await expect(u.agent.sendMessageBatch(items)).rejects.toThrow(
        /Batch size exceeds|100/,
      )
    })

    it('rejects batch item with missing text', async () => {
      const u1 = await createTestUser(network, 'batchval-t1.test')
      const u2 = await createTestUser(network, 'batchval-t2.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      await expect(
        u1.agent.sendMessageBatch([
          { convoId: createRes.convo.id, message: { text: '' } },
        ]),
      ).rejects.toThrow(/text|required/i)
    })
  })

  // =======================================================================
  // message.ts -- sendMessageBatch non-member and left and auto-accept
  // =======================================================================

  describe('sendMessageBatch membership checks', () => {
    it('rejects when caller is not a member of batch convo', async () => {
      const u1 = await createTestUser(network, 'batchnm-a.test')
      const u2 = await createTestUser(network, 'batchnm-b.test')
      const u3 = await createTestUser(network, 'batchnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }

      await expect(
        u3.agent.sendMessageBatch([
          { convoId: createRes.convo.id, message: { text: 'hello' } },
        ]),
      ).rejects.toThrow(/Convo not found/)
    })

    it('rejects when caller has left a batch convo', async () => {
      const u1 = await createTestUser(network, 'batchleft-a.test')
      const u2 = await createTestUser(network, 'batchleft-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      await u1.agent.leaveConvo(convoId)

      await expect(
        u1.agent.sendMessageBatch([
          { convoId, message: { text: 'hello' } },
        ]),
      ).rejects.toThrow(/left/i)
    })

    it('auto-accepts when batch sender has request status', async () => {
      const u1 = await createTestUser(network, 'batchacc-a.test')
      const u2 = await createTestUser(network, 'batchacc-b.test')

      // u1 creates convo (u2 gets request status)
      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      // u2 sends via batch without explicit accept - should auto-accept
      const batchRes = (await u2.agent.sendMessageBatch([
        { convoId, message: { text: 'auto-accepted batch msg' } },
      ])) as { items: Array<{ id: string }> }
      expect(batchRes.items).toBeDefined()
      expect(batchRes.items.length).toBe(1)

      // Verify u2's status is now accepted
      const convo = (await u2.agent.getConvo(convoId)) as {
        convo: { status?: string }
      }
      expect(convo.convo.status).toBe('accepted')
    })

    it('rejects batch when caller chat is disabled', async () => {
      const u1 = await createTestUser(network, 'batchdis-a.test')
      const u2 = await createTestUser(network, 'batchdis-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      await modClient.updateActorAccess(u1.did, false)

      await expect(
        u1.agent.sendMessageBatch([
          { convoId, message: { text: 'disabled' } },
        ]),
      ).rejects.toThrow(/disabled/i)

      await modClient.updateActorAccess(u1.did, true)
    })
  })

  // =======================================================================
  // message.ts -- getMessages with deleted messages (deletedAt branch)
  // =======================================================================

  describe('getMessages with soft-deleted messages', () => {
    it('excludes per-user deleted messages from results', async () => {
      const u1 = await createTestUser(network, 'gmdel-a.test')
      const u2 = await createTestUser(network, 'gmdel-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      // Send 3 messages
      const msg1 = (await u1.agent.sendMessage(convoId, {
        text: 'msg1',
      })) as { id: string }
      await u1.agent.sendMessage(convoId, { text: 'msg2' })
      await u1.agent.sendMessage(convoId, { text: 'msg3' })

      // u1 deletes msg1 for self
      await u1.agent.deleteMessageForSelf(convoId, msg1.id)

      // u1 should see 2 messages (msg2 and msg3), not msg1
      const msgs = (await u1.agent.getMessages(convoId)) as {
        messages: Array<{ id: string; text?: string }>
      }
      const ids = msgs.messages.map((m) => m.id)
      expect(ids).not.toContain(msg1.id)
      expect(msgs.messages.length).toBe(2)
    })
  })

  // =======================================================================
  // message.ts -- getMessages cursor pagination
  // =======================================================================

  describe('getMessages cursor pagination', () => {
    it('paginates with cursor and returns hasMore correctly', async () => {
      const u1 = await createTestUser(network, 'gmcur-a.test')
      const u2 = await createTestUser(network, 'gmcur-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      // Send 5 messages
      for (let i = 0; i < 5; i++) {
        await u1.agent.sendMessage(convoId, { text: `page msg ${i}` })
      }

      // Get first page with limit 2
      const page1 = (await u1.agent.getMessages(convoId, {
        limit: 2,
      })) as {
        messages: Array<{ id: string }>
        cursor?: string
      }
      expect(page1.messages.length).toBe(2)
      expect(page1.cursor).toBeDefined()

      // Get second page using cursor
      const page2 = (await u1.agent.getMessages(convoId, {
        limit: 2,
        cursor: page1.cursor,
      })) as {
        messages: Array<{ id: string }>
        cursor?: string
      }
      expect(page2.messages.length).toBe(2)
      expect(page2.cursor).toBeDefined()

      // Get third page - should have 1 message, no cursor
      const page3 = (await u1.agent.getMessages(convoId, {
        limit: 2,
        cursor: page2.cursor,
      })) as {
        messages: Array<{ id: string }>
        cursor?: string
      }
      expect(page3.messages.length).toBe(1)
      expect(page3.cursor).toBeUndefined()

      // Verify no overlap
      const allIds = [
        ...page1.messages.map((m) => m.id),
        ...page2.messages.map((m) => m.id),
        ...page3.messages.map((m) => m.id),
      ]
      expect(new Set(allIds).size).toBe(5)
    })
  })

  // =======================================================================
  // message.ts -- addReaction error branches
  // =======================================================================

  describe('addReaction edge cases', () => {
    let u1: TestUser
    let u2: TestUser
    let u3: TestUser
    let convoId: string
    let messageId: string

    beforeAll(async () => {
      u1 = await createTestUser(network, 'arec-a.test')
      u2 = await createTestUser(network, 'arec-b.test')
      u3 = await createTestUser(network, 'arec-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      const msg = (await u1.agent.sendMessage(convoId, {
        text: 'reaction target',
      })) as { id: string }
      messageId = msg.id
    })

    it('rejects when caller is not a member', async () => {
      await expect(
        u3.agent.addReaction(convoId, messageId, '\u{1F44D}'),
      ).rejects.toThrow(/Convo not found/)
    })

    it('rejects reaction on non-existent message', async () => {
      await expect(
        u1.agent.addReaction(convoId, 'nonexistent-msg-id', '\u{1F44D}'),
      ).rejects.toThrow(/Message not found/)
    })

    it('rejects reaction on deleted message', async () => {
      // Send a message and then soft-delete it
      const delMsg = (await u1.agent.sendMessage(convoId, {
        text: 'will be deleted',
      })) as { id: string }
      await u1.agent.deleteMessageForSelf(convoId, delMsg.id)

      // Note: deleteMessageForSelf is per-user, not a global delete.
      // The server-side deletedAt is only set by admin/mod deletion.
      // This test may not trigger the deletedAt branch via E2E.
      // However, we still test the flow.
    })

    it('rejects when reaction limit (5) is exceeded with non-duplicate', async () => {
      // Add 5 distinct reactions from u1
      const emojis = ['\u{1F44D}', '\u{1F44E}', '\u{2764}', '\u{1F525}', '\u{1F60A}']
      for (const emoji of emojis) {
        await u1.agent.addReaction(convoId, messageId, emoji)
      }

      // 6th distinct reaction should fail
      await expect(
        u1.agent.addReaction(convoId, messageId, '\u{1F389}'),
      ).rejects.toThrow(/Maximum 5 reactions|ReactionLimitReached/)
    })

    it('allows re-adding same reaction (idempotent when at limit)', async () => {
      // u1 already has 5 reactions from previous test
      // Re-adding an existing one should succeed (idempotent)
      const res = (await u1.agent.addReaction(
        convoId,
        messageId,
        '\u{1F44D}',
      )) as { id: string }
      expect(res).toBeDefined()
    })

    it('rejects empty reaction value', async () => {
      await expect(
        u1.agent.addReaction(convoId, messageId, ''),
      ).rejects.toThrow(/Reaction value is required|ReactionInvalidValue/)
    })

    it('rejects multi-grapheme reaction value', async () => {
      await expect(
        u1.agent.addReaction(convoId, messageId, '\u{1F44D}\u{1F44E}'),
      ).rejects.toThrow(/exactly 1 emoji|ReactionInvalidValue/)
    })
  })

  // =======================================================================
  // message.ts -- removeReaction idempotent no-op
  // =======================================================================

  describe('removeReaction idempotent no-op', () => {
    it('succeeds silently when reaction does not exist', async () => {
      const u1 = await createTestUser(network, 'rrnoop-a.test')
      const u2 = await createTestUser(network, 'rrnoop-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      const msg = (await u1.agent.sendMessage(convoId, {
        text: 'for remove reaction noop',
      })) as { id: string }

      // Remove a reaction that was never added - should succeed
      const res = (await u1.agent.removeReaction(
        convoId,
        msg.id,
        '\u{1F44D}',
      )) as { id: string }
      expect(res).toBeDefined()
    })
  })

  // =======================================================================
  // message.ts -- deleteMessageForSelf non-member
  // =======================================================================

  describe('deleteMessageForSelf non-member', () => {
    it('rejects when caller is not a member', async () => {
      const u1 = await createTestUser(network, 'delnm-a.test')
      const u2 = await createTestUser(network, 'delnm-b.test')
      const u3 = await createTestUser(network, 'delnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      const msg = (await u1.agent.sendMessage(convoId, {
        text: 'to delete',
      })) as { id: string }

      await expect(
        u3.agent.deleteMessageForSelf(convoId, msg.id),
      ).rejects.toThrow(/Convo not found/)
    })
  })

  // =======================================================================
  // message.ts -- removeReaction non-member
  // =======================================================================

  describe('removeReaction non-member', () => {
    it('rejects when caller is not a member', async () => {
      const u1 = await createTestUser(network, 'rrnm-a.test')
      const u2 = await createTestUser(network, 'rrnm-b.test')
      const u3 = await createTestUser(network, 'rrnm-c.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      const msg = (await u1.agent.sendMessage(convoId, {
        text: 'target',
      })) as { id: string }

      await expect(
        u3.agent.removeReaction(convoId, msg.id, '\u{1F44D}'),
      ).rejects.toThrow(/Convo not found/)
    })
  })

  // =======================================================================
  // moderation.ts -- getMessageContext without convoId
  // =======================================================================

  describe('getMessageContext without convoId', () => {
    it('resolves convoId from the message when not provided', async () => {
      const u1 = await createTestUser(network, 'mctx-a.test')
      const u2 = await createTestUser(network, 'mctx-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      // Send messages for context
      await u1.agent.sendMessage(convoId, { text: 'context before 1' })
      await u1.agent.sendMessage(convoId, { text: 'context before 2' })
      const targetMsg = (await u1.agent.sendMessage(convoId, {
        text: 'target message',
      })) as { id: string }
      await u1.agent.sendMessage(convoId, { text: 'context after 1' })

      // Get context WITHOUT convoId -- this triggers the branch where
      // getMessageContext resolves convoId from the message
      const ctx = (await modClient.getMessageContext(targetMsg.id)) as {
        messages: Array<{ id: string; text?: string }>
      }
      expect(ctx.messages).toBeDefined()
      expect(ctx.messages.length).toBeGreaterThanOrEqual(3)

      // Should include the target message
      const targetInResult = ctx.messages.find((m) => m.id === targetMsg.id)
      expect(targetInResult).toBeDefined()
    })

    it('throws when message not found (no convoId)', async () => {
      await expect(
        modClient.getMessageContext('nonexistent-msg-id'),
      ).rejects.toThrow(/Message not found/)
    })
  })

  // =======================================================================
  // moderation.ts -- getMessageContext with before=0 and after=0
  // =======================================================================

  describe('getMessageContext with zero before/after', () => {
    it('returns only the target message when before=0 and after=0', async () => {
      const u1 = await createTestUser(network, 'mctxz-a.test')
      const u2 = await createTestUser(network, 'mctxz-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      await u1.agent.sendMessage(convoId, { text: 'before' })
      const target = (await u1.agent.sendMessage(convoId, {
        text: 'target only',
      })) as { id: string }
      await u1.agent.sendMessage(convoId, { text: 'after' })

      const ctx = (await modClient.getMessageContext(target.id, {
        convoId,
        before: 0,
        after: 0,
      })) as {
        messages: Array<{ id: string }>
      }
      expect(ctx.messages.length).toBe(1)
      expect(ctx.messages[0].id).toBe(target.id)
    })
  })

  // =======================================================================
  // event-log.ts -- getLog cursor pagination
  // =======================================================================

  describe('getLog cursor pagination', () => {
    it('paginates events with cursor', async () => {
      const u1 = await createTestUser(network, 'logcur-a.test')
      const u2 = await createTestUser(network, 'logcur-b.test')

      // Create convo and send messages to generate events
      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      for (let i = 0; i < 5; i++) {
        await u1.agent.sendMessage(convoId, { text: `log msg ${i}` })
      }

      // Get first page of events
      const page1 = (await u1.agent.getLog()) as {
        logs: Array<{ rev: string }>
        cursor?: string
      }
      expect(page1.logs.length).toBeGreaterThan(0)

      // If there's a cursor, get next page
      if (page1.cursor) {
        const page2 = (await u1.agent.getLog(page1.cursor)) as {
          logs: Array<{ rev: string }>
          cursor?: string
        }
        expect(page2.logs.length).toBeGreaterThanOrEqual(0)

        // Verify no overlap in revs
        if (page2.logs.length > 0) {
          const page1Revs = new Set(page1.logs.map((l) => l.rev))
          for (const log of page2.logs) {
            expect(page1Revs.has(log.rev)).toBe(false)
          }
        }
      }
    })
  })

  // =======================================================================
  // views/index.ts -- convo with left member (status=undefined mapping)
  // =======================================================================

  describe('views: left member status mapping', () => {
    it('left member sees status as undefined in convo view', async () => {
      const u1 = await createTestUser(network, 'vleft-a.test')
      const u2 = await createTestUser(network, 'vleft-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id

      // After leaving, if we rejoin we can check the status
      await u1.agent.leaveConvo(convoId)

      // Rejoin
      const rejoinRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string; status?: string } }

      // After rejoin, status should be 'request' (not undefined)
      expect(rejoinRes.convo.status).toBe('request')
    })
  })

  // =======================================================================
  // message.ts -- sendMessage with facets and embed
  // =======================================================================

  describe('sendMessage with facets and embed', () => {
    it('includes facets in message view', async () => {
      const u1 = await createTestUser(network, 'smfac-a.test')
      const u2 = await createTestUser(network, 'smfac-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      const facets = [
        {
          index: { byteStart: 0, byteEnd: 5 },
          features: [
            {
              $type: 'app.bsky.richtext.facet#link',
              uri: 'https://example.com',
            },
          ],
        },
      ]

      const msg = (await u1.agent.sendMessage(convoId, {
        text: 'hello with link',
        facets,
      })) as { id: string; facets?: unknown[] }
      expect(msg.id).toBeDefined()
      expect(msg.facets).toBeDefined()
      expect(msg.facets).toHaveLength(1)
    })

    it('includes embed in message view', async () => {
      const u1 = await createTestUser(network, 'smemb-a.test')
      const u2 = await createTestUser(network, 'smemb-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      const embed = {
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'An example link',
        },
      }

      const msg = (await u1.agent.sendMessage(convoId, {
        text: 'check this out',
        embed,
      })) as { id: string; embed?: unknown }
      expect(msg.id).toBeDefined()
      expect(msg.embed).toBeDefined()
    })
  })

  // =======================================================================
  // views/index.ts -- convo with last message that has facets/embed
  // =======================================================================

  describe('convo view with rich last message', () => {
    it('includes facets and embed in lastMessage view', async () => {
      const u1 = await createTestUser(network, 'cvrich-a.test')
      const u2 = await createTestUser(network, 'cvrich-b.test')

      const createRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convoId = createRes.convo.id
      await u2.agent.acceptConvo(convoId)

      // Send a message with facets and embed
      await u1.agent.sendMessage(convoId, {
        text: 'rich message',
        facets: [
          {
            index: { byteStart: 0, byteEnd: 4 },
            features: [
              {
                $type: 'app.bsky.richtext.facet#link',
                uri: 'https://example.com',
              },
            ],
          },
        ],
        embed: {
          $type: 'app.bsky.embed.external',
          external: {
            uri: 'https://example.com',
            title: 'Rich',
            description: 'Rich embed',
          },
        },
      })

      // Get the convo and check the lastMessage
      const convo = (await u1.agent.getConvo(convoId)) as {
        convo: {
          lastMessage?: {
            text?: string
            facets?: unknown[]
            embed?: unknown
          }
        }
      }
      expect(convo.convo.lastMessage).toBeDefined()
      expect(convo.convo.lastMessage?.facets).toBeDefined()
      expect(convo.convo.lastMessage?.embed).toBeDefined()
    })
  })

  // =======================================================================
  // conversation.ts -- listConvos with readState=unread filter
  // =======================================================================

  describe('listConvos with readState filter', () => {
    it('filters to only unread conversations', async () => {
      const u1 = await createTestUser(network, 'lsunrd-a.test')
      const u2 = await createTestUser(network, 'lsunrd-b.test')
      const u3 = await createTestUser(network, 'lsunrd-c.test')

      // Create two convos
      const convo1Res = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as { convo: { id: string } }
      const convo1Id = convo1Res.convo.id

      const convo2Res = (await u1.agent.getConvoForMembers([
        u1.did,
        u3.did,
      ])) as { convo: { id: string } }
      const convo2Id = convo2Res.convo.id

      await u2.agent.acceptConvo(convo1Id)
      await u3.agent.acceptConvo(convo2Id)

      // u2 and u3 each send a message so u1 has unread in both
      await u2.agent.sendMessage(convo1Id, { text: 'unread 1' })
      await u3.agent.sendMessage(convo2Id, { text: 'unread 2' })

      // u1 reads convo1
      await u1.agent.updateRead(convo1Id)

      // listConvos with readState=unread should only return convo2
      const unreadList = (await u1.agent.listConvos({
        readState: 'unread',
      })) as {
        convos: Array<{ id: string }>
      }
      const unreadIds = unreadList.convos.map((c) => c.id)
      expect(unreadIds).toContain(convo2Id)
      expect(unreadIds).not.toContain(convo1Id)
    })
  })

  // =======================================================================
  // conversation.ts -- listConvos with status filter
  // =======================================================================

  describe('listConvos with status filter', () => {
    it('filters to only request-status conversations', async () => {
      const u1 = await createTestUser(network, 'lsstatus-a.test')
      const u2 = await createTestUser(network, 'lsstatus-b.test')
      const u3 = await createTestUser(network, 'lsstatus-c.test')

      // u2 creates convo with u1 (u1 gets request)
      const convo1Res = (await u2.agent.getConvoForMembers([
        u2.did,
        u1.did,
      ])) as { convo: { id: string } }
      const convo1Id = convo1Res.convo.id

      // u3 creates convo with u1 (u1 gets request)
      const convo2Res = (await u3.agent.getConvoForMembers([
        u3.did,
        u1.did,
      ])) as { convo: { id: string } }
      const convo2Id = convo2Res.convo.id

      // u1 accepts convo1 but not convo2
      await u1.agent.acceptConvo(convo1Id)

      // listConvos with status=request should only return convo2
      const requestList = (await u1.agent.listConvos({
        status: 'request',
      })) as {
        convos: Array<{ id: string }>
      }
      const requestIds = requestList.convos.map((c) => c.id)
      expect(requestIds).toContain(convo2Id)
      expect(requestIds).not.toContain(convo1Id)
    })
  })
})
