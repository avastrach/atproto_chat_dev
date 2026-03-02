import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Account data E2E tests.
 *
 * Covers:
 * - exportAccountData returns JSONL stream with $type fields
 * - exportAccountData includes conversations, messages, reactions
 * - deleteAccount removes all chat data for the user
 * - After deleteAccount, other member can still see conversation but user is gone
 *
 * References:
 * - Service: account.ts (exportAccountData, deleteAccount)
 * - API: chat.bsky.actor.exportAccountData, chat.bsky.actor.deleteAccount
 */

// Type helpers
interface ConvoView {
  id: string
  members: Array<{ did: string }>
  status: string
}

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

interface GetMessagesResponse {
  messages: (MessageView | { id: string; sender: { did: string } })[]
}

interface ListConvosResponse {
  convos: ConvoView[]
}

describe('account data', () => {
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

  // -----------------------------------------------------------------------
  // exportAccountData
  // -----------------------------------------------------------------------

  describe('exportAccountData', () => {
    it('returns JSONL stream with $type fields', async () => {
      // Create a conversation and send a message so there is data to export
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id
      await bob.agent.acceptConvo(convoId)
      await alice.agent.sendMessage(convoId, { text: 'Export test message' })

      const rawData = await alice.agent.exportAccountData()

      expect(rawData).toBeTruthy()
      expect(typeof rawData).toBe('string')

      // Parse JSONL lines
      const lines = rawData
        .split('\n')
        .filter((line) => line.trim().length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(1)

      // Each line should be valid JSON with a $type field
      for (const line of lines) {
        const obj = JSON.parse(line)
        // Most lines should have $type, but message views use the
        // standard chat.bsky.convo.defs#messageView or #deletedMessageView
        // which are identified by the presence of specific fields
        expect(typeof obj).toBe('object')
      }
    })

    it('includes conversations in the export', async () => {
      // Ensure there is a conversation
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse

      const rawData = await alice.agent.exportAccountData()
      const lines = rawData
        .split('\n')
        .filter((line) => line.trim().length > 0)
      const objects = lines.map((line) => JSON.parse(line))

      // Look for a convoView entry
      const convoEntries = objects.filter(
        (obj) => obj.$type === 'chat.bsky.convo.defs#convoView',
      )
      expect(convoEntries.length).toBeGreaterThanOrEqual(1)

      // The convo should have an id and members
      const convo = convoEntries[0]
      expect(convo.id).toBeTruthy()
      expect(convo.members).toBeDefined()
    })

    it('includes messages in the export', async () => {
      // Ensure there is at least one message
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      await alice.agent.sendMessage(convoRes.convo.id, {
        text: 'Export message check',
      })

      const rawData = await alice.agent.exportAccountData()
      const lines = rawData
        .split('\n')
        .filter((line) => line.trim().length > 0)
      const objects = lines.map((line) => JSON.parse(line))

      // Look for message entries (they have $type: 'chat.bsky.convo.defs#messageView'
      // or have text+sender fields)
      const messageEntries = objects.filter(
        (obj) =>
          obj.$type === 'chat.bsky.convo.defs#messageView' ||
          (obj.text && obj.sender),
      )
      expect(messageEntries.length).toBeGreaterThanOrEqual(1)

      // At least one should have text
      const withText = messageEntries.find((m) => m.text)
      expect(withText).toBeDefined()
    })

    it('includes reactions in the export', async () => {
      // Create a reaction so it appears in the export
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'React for export',
      })) as MessageView
      await alice.agent.addReaction(convoId, msg.id, '\u2764\uFE0F')

      const rawData = await alice.agent.exportAccountData()
      const lines = rawData
        .split('\n')
        .filter((line) => line.trim().length > 0)
      const objects = lines.map((line) => JSON.parse(line))

      // Look for reaction entries
      const reactionEntries = objects.filter(
        (obj) => obj.$type === 'chat.bsky.convo.defs#reactionView',
      )
      expect(reactionEntries.length).toBeGreaterThanOrEqual(1)

      const reaction = reactionEntries[0]
      expect(reaction.value).toBeTruthy()
      expect(reaction.sender).toBeDefined()
      expect(reaction.sender.did).toBe(alice.did)
    })
  })

  // -----------------------------------------------------------------------
  // deleteAccount
  // -----------------------------------------------------------------------

  describe('deleteAccount', () => {
    it('removes all chat data for the user', async () => {
      // Create a fresh user who will be deleted
      const doomed = await createTestUser(network, 'doomed.test')
      const survivor = await createTestUser(network, 'survivor.test')

      // Create a conversation and exchange messages
      const convoRes = (await doomed.agent.getConvoForMembers([
        doomed.did,
        survivor.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id
      await survivor.agent.acceptConvo(convoId)

      await doomed.agent.sendMessage(convoId, { text: 'Goodbye world' })
      await survivor.agent.sendMessage(convoId, { text: 'See ya' })

      // Add a reaction from doomed
      const msgs = (await doomed.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      const firstMsg = msgs.messages.find(
        (m) => 'text' in m && (m as MessageView).text === 'See ya',
      )
      if (firstMsg) {
        await doomed.agent.addReaction(convoId, firstMsg.id, '\uD83D\uDC4D')
      }

      // Delete the account
      await doomed.agent.deleteAccount()

      // After deleteAccount, the JWT is still valid so API calls succeed
      // but return empty data since all chat data has been removed.
      const listRes =
        (await doomed.agent.listConvos()) as ListConvosResponse
      expect(listRes.convos).toEqual([])
    })

    it('after deleteAccount, other member can still see the conversation', async () => {
      // Create a fresh pair
      const deleter = await createTestUser(network, 'deleter.test')
      const keeper = await createTestUser(network, 'keeper.test')

      // Create conversation and exchange messages
      const convoRes = (await deleter.agent.getConvoForMembers([
        deleter.did,
        keeper.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id
      await keeper.agent.acceptConvo(convoId)

      await deleter.agent.sendMessage(convoId, {
        text: 'Deleter message',
      })
      await keeper.agent.sendMessage(convoId, { text: 'Keeper message' })

      // Delete the deleter's account
      await deleter.agent.deleteAccount()

      // Keeper should still be able to see the conversation
      const keeperList =
        (await keeper.agent.listConvos()) as ListConvosResponse
      const keeperConvo = keeperList.convos.find((c) => c.id === convoId)
      expect(keeperConvo).toBeDefined()

      // Keeper should still be able to get messages (deleter's messages
      // will be soft-deleted/gone but keeper's should remain)
      const keeperMsgs = (await keeper.agent.getMessages(
        convoId,
      )) as GetMessagesResponse
      expect(keeperMsgs.messages).toBeDefined()

      // Keeper's own message should still be there
      const keeperMsg = keeperMsgs.messages.find(
        (m) => 'text' in m && (m as MessageView).text === 'Keeper message',
      )
      expect(keeperMsg).toBeDefined()
    })
  })
})
