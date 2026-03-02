import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Reaction operations E2E tests.
 *
 * Covers:
 * - Adding a reaction (single emoji)
 * - Removing a reaction
 * - Reaction limits (max 5 per user per message)
 * - Reaction validation (must be exactly 1 grapheme)
 * - Idempotent add (adding same reaction twice does not error or duplicate)
 * - Idempotent remove (removing non-existent reaction does not error)
 * - Reactions are visible to all members
 *
 * References:
 * - PRD 16.7.6 (Adding a Reaction)
 * - Service: message.ts (MAX_REACTIONS_PER_USER_PER_MESSAGE=5, validateReactionValue)
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
  reactions?: Array<{
    value: string
    sender: { did: string }
    createdAt: string
  }>
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

/** addReaction / removeReaction return { message: MessageView } */
interface ReactionResponse {
  message: MessageView
}

describe('reaction operations', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string
  let messageId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')

    // Create a conversation and send a test message
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id

    // Accept the convo
    await bob.agent.acceptConvo(convoId)

    // Send a message to react to
    const msg = (await alice.agent.sendMessage(convoId, {
      text: 'React to this message',
    })) as MessageView
    messageId = msg.id
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // addReaction - basic reaction adding
  // -----------------------------------------------------------------------

  describe('addReaction', () => {
    it('adds a single emoji reaction and returns the message with reactions', async () => {
      const raw = (await alice.agent.addReaction(
        convoId,
        messageId,
        '\u2764\uFE0F', // heart emoji
      )) as ReactionResponse
      const res = raw.message

      expect(res.id).toBe(messageId)
      expect(res.reactions).toBeDefined()
      expect(res.reactions!.length).toBeGreaterThanOrEqual(1)

      const heartReaction = res.reactions!.find(
        (r) => r.value === '\u2764\uFE0F' && r.sender.did === alice.did,
      )
      expect(heartReaction).toBeDefined()
    })

    it('allows different users to add the same reaction', async () => {
      // Send a fresh message for this test
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Both react',
      })) as MessageView

      await alice.agent.addReaction(convoId, msg.id, '\uD83D\uDC4D') // thumbs up
      const raw = (await bob.agent.addReaction(
        convoId,
        msg.id,
        '\uD83D\uDC4D',
      )) as ReactionResponse
      const res = raw.message

      expect(res.reactions).toBeDefined()
      const thumbsUpReactions = res.reactions!.filter(
        (r) => r.value === '\uD83D\uDC4D',
      )
      expect(thumbsUpReactions.length).toBe(2)
    })

    it('allows a user to add different reactions to the same message', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Multiple reactions',
      })) as MessageView

      await alice.agent.addReaction(convoId, msg.id, '\uD83D\uDE00') // grinning face
      await alice.agent.addReaction(convoId, msg.id, '\uD83D\uDE02') // joy
      const raw = (await alice.agent.addReaction(
        convoId,
        msg.id,
        '\uD83D\uDE0D', // heart eyes
      )) as ReactionResponse
      const res = raw.message

      expect(res.reactions).toBeDefined()
      const aliceReactions = res.reactions!.filter(
        (r) => r.sender.did === alice.did,
      )
      expect(aliceReactions.length).toBe(3)
    })

    it('is idempotent - adding the same reaction twice does not error or duplicate', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Idempotent reaction',
      })) as MessageView

      await alice.agent.addReaction(convoId, msg.id, '\u2B50') // star

      const raw2 = (await alice.agent.addReaction(
        convoId,
        msg.id,
        '\u2B50',
      )) as ReactionResponse
      const res2 = raw2.message

      // Count star reactions from alice - should be exactly 1
      const starReactions = res2.reactions!.filter(
        (r) => r.value === '\u2B50' && r.sender.did === alice.did,
      )
      expect(starReactions.length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // removeReaction - removing reactions
  // -----------------------------------------------------------------------

  describe('removeReaction', () => {
    it('removes a reaction', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Remove reaction test',
      })) as MessageView

      // Add a reaction
      await alice.agent.addReaction(convoId, msg.id, '\uD83D\uDE4F') // folded hands

      // Remove it
      const raw = (await alice.agent.removeReaction(
        convoId,
        msg.id,
        '\uD83D\uDE4F',
      )) as ReactionResponse
      const res = raw.message

      expect(res.id).toBe(msg.id)
      const foldedHands = res.reactions?.find(
        (r) => r.value === '\uD83D\uDE4F' && r.sender.did === alice.did,
      )
      expect(foldedHands).toBeUndefined()
    })

    it('is idempotent - removing a non-existent reaction does not error', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Idempotent remove test',
      })) as MessageView

      // Remove a reaction that was never added -- should not throw
      const raw = (await alice.agent.removeReaction(
        convoId,
        msg.id,
        '\uD83D\uDE80', // rocket
      )) as ReactionResponse
      const res = raw.message

      expect(res.id).toBe(msg.id)
    })

    it('only removes the specific reaction, leaving others intact', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Selective remove test',
      })) as MessageView

      // Add two reactions
      await alice.agent.addReaction(convoId, msg.id, '\uD83D\uDD25') // fire
      await alice.agent.addReaction(convoId, msg.id, '\u2764\uFE0F') // heart

      // Remove only fire
      const raw = (await alice.agent.removeReaction(
        convoId,
        msg.id,
        '\uD83D\uDD25',
      )) as ReactionResponse
      const res = raw.message

      // Heart should remain
      const heartReaction = res.reactions?.find(
        (r) => r.value === '\u2764\uFE0F' && r.sender.did === alice.did,
      )
      expect(heartReaction).toBeDefined()

      // Fire should be gone
      const fireReaction = res.reactions?.find(
        (r) => r.value === '\uD83D\uDD25' && r.sender.did === alice.did,
      )
      expect(fireReaction).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Reaction limits - max 5 per user per message
  // -----------------------------------------------------------------------

  describe('reaction limits', () => {
    it('allows up to 5 reactions per user per message', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Five reactions test',
      })) as MessageView

      const emojis = [
        '\uD83D\uDE00', // grinning
        '\uD83D\uDE02', // joy
        '\uD83D\uDE0D', // heart eyes
        '\uD83D\uDE0E', // sunglasses
        '\uD83E\uDD14', // thinking
      ]

      for (const emoji of emojis) {
        await alice.agent.addReaction(convoId, msg.id, emoji)
      }

      // All 5 should be present
      const raw = (await alice.agent.addReaction(
        convoId,
        msg.id,
        '\uD83D\uDE00', // re-add first (idempotent, should still be 5)
      )) as ReactionResponse
      const res = raw.message

      const aliceReactions = res.reactions!.filter(
        (r) => r.sender.did === alice.did,
      )
      expect(aliceReactions.length).toBe(5)
    })

    it('rejects the 6th different reaction from the same user', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Six reactions test',
      })) as MessageView

      const emojis = [
        '\uD83D\uDE00', // grinning
        '\uD83D\uDE02', // joy
        '\uD83D\uDE0D', // heart eyes
        '\uD83D\uDE0E', // sunglasses
        '\uD83E\uDD14', // thinking
      ]

      for (const emoji of emojis) {
        await alice.agent.addReaction(convoId, msg.id, emoji)
      }

      // The 6th different reaction should fail
      await expect(
        alice.agent.addReaction(convoId, msg.id, '\uD83D\uDE80'), // rocket
      ).rejects.toThrow()
    })

    it('other users have their own independent 5-reaction limit', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Independent limits test',
      })) as MessageView

      // Alice adds 5 reactions
      const aliceEmojis = [
        '\uD83D\uDE00',
        '\uD83D\uDE02',
        '\uD83D\uDE0D',
        '\uD83D\uDE0E',
        '\uD83E\uDD14',
      ]
      for (const emoji of aliceEmojis) {
        await alice.agent.addReaction(convoId, msg.id, emoji)
      }

      // Bob can still add his own reactions (separate limit)
      const raw = (await bob.agent.addReaction(
        convoId,
        msg.id,
        '\uD83D\uDE80', // rocket
      )) as ReactionResponse
      const res = raw.message

      const bobReactions = res.reactions!.filter(
        (r) => r.sender.did === bob.did,
      )
      expect(bobReactions.length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Reaction validation - must be exactly 1 grapheme
  // -----------------------------------------------------------------------

  describe('reaction validation', () => {
    it('rejects empty reaction value', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Empty reaction test',
      })) as MessageView

      await expect(
        alice.agent.addReaction(convoId, msg.id, ''),
      ).rejects.toThrow()
    })

    it('rejects multi-character text as reaction', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Multi-char reaction test',
      })) as MessageView

      await expect(
        alice.agent.addReaction(convoId, msg.id, 'hi'),
      ).rejects.toThrow()
    })

    it('rejects multi-emoji string as reaction', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Multi-emoji reaction test',
      })) as MessageView

      await expect(
        alice.agent.addReaction(convoId, msg.id, '\uD83D\uDE00\uD83D\uDE02'),
      ).rejects.toThrow()
    })

    it('accepts a single emoji grapheme', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Valid reaction test',
      })) as MessageView

      const raw = (await alice.agent.addReaction(
        convoId,
        msg.id,
        '\uD83C\uDF89', // party popper
      )) as ReactionResponse
      const res = raw.message

      expect(res.reactions).toBeDefined()
      const partyReaction = res.reactions!.find(
        (r) => r.value === '\uD83C\uDF89',
      )
      expect(partyReaction).toBeDefined()
    })

    it('validates reaction value on remove as well', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Validate remove test',
      })) as MessageView

      // Multi-character value should be rejected even on remove
      await expect(
        alice.agent.removeReaction(convoId, msg.id, 'hello'),
      ).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Reactions visible to all members
  // -----------------------------------------------------------------------

  describe('reaction visibility', () => {
    it('reactions are visible to all conversation members', async () => {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Visibility reaction test',
      })) as MessageView

      // Alice adds a reaction
      await alice.agent.addReaction(convoId, msg.id, '\uD83D\uDC4D') // thumbs up

      // Bob should see the reaction when fetching messages
      const bobMsgs = (await bob.agent.getMessages(convoId)) as {
        messages: MessageView[]
      }
      const bobMsg = bobMsgs.messages.find((m) => m.id === msg.id)
      expect(bobMsg).toBeDefined()
      expect(bobMsg!.reactions).toBeDefined()

      const thumbsUp = bobMsg!.reactions!.find(
        (r) => r.value === '\uD83D\uDC4D' && r.sender.did === alice.did,
      )
      expect(thumbsUp).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Reaction on deleted message
  // -----------------------------------------------------------------------

  describe('reaction on deleted message', () => {
    it('addReaction on a soft-deleted message returns ReactionMessageDeleted error', async () => {
      // Create a fresh conversation with a throwaway user who will delete their account
      const tempUser = await createTestUser(network, 'temp-react.test')
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        tempUser.did,
      ])) as ConvoForMembersResponse
      const freshConvoId = convoRes.convo.id
      await tempUser.agent.acceptConvo(freshConvoId)

      // tempUser sends a message
      const msg = (await tempUser.agent.sendMessage(freshConvoId, {
        text: 'Message that will be soft-deleted',
      })) as MessageView

      // tempUser deletes their account (soft-deletes their messages)
      await tempUser.agent.deleteAccount()

      // Alice tries to add a reaction to the now-deleted message
      await expect(
        alice.agent.addReaction(freshConvoId, msg.id, '\u2764\uFE0F'),
      ).rejects.toThrow(/Cannot react to deleted message|ReactionMessageDeleted/)
    })
  })
})
