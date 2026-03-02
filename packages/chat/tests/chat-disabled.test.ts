import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  setChatDisabled,
  createModServiceClient,
} from './_util'

/**
 * Chat-disabled enforcement E2E tests.
 *
 * Covers:
 * - chatDisabled user cannot send messages
 * - Moderator can disable chat for an actor via updateActorAccess
 * - Moderator can re-enable chat after disabling
 * - Existing conversations remain visible but sending is blocked when disabled
 * - Non-mod user cannot call updateActorAccess
 *
 * References:
 * - PRD 14.1 (chatDisabled Flag Detection)
 * - PRD 17.6.20 (updateActorAccess)
 * - Service: message.ts (chatDisabled check before sendMessage)
 * - Error code 13: "Account is disabled"
 */

// Type helpers for casting XRPC responses
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

interface ListConvosResponse {
  convos: ConvoView[]
  cursor?: string
}

interface MessageView {
  id: string
  text: string
  sender: { did: string }
  sentAt: string
  rev: string
}

describe('chat-disabled enforcement', () => {
  let network: TestNetwork
  let modClient: ChatApiClient

  beforeAll(async () => {
    network = await createTestNetwork()
    modClient = await createModServiceClient(network)
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // chatDisabled user cannot send messages
  // -----------------------------------------------------------------------

  it('chatDisabled user cannot send messages', async () => {
    const alice = await createTestUser(network, 'dis-alice.test')
    const bob = await createTestUser(network, 'dis-bob.test')

    // Create a conversation and accept it so both sides can message
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Verify messaging works before disabling
    const msg1 = (await alice.agent.sendMessage(convoId, {
      text: 'Before disable',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Moderator disables alice's chat
    await setChatDisabled(modClient, alice.did, true)

    // Alice tries to send a message -- should fail with "Account is disabled"
    await expect(
      alice.agent.sendMessage(convoId, { text: 'After disable' }),
    ).rejects.toThrow(/Account is disabled/)
  })

  // -----------------------------------------------------------------------
  // Moderator can disable chat for actor
  // -----------------------------------------------------------------------

  it('moderator can disable chat for actor', async () => {
    const target = await createTestUser(network, 'dis-target.test')
    const other = await createTestUser(network, 'dis-other.test')

    // Create a conversation so we have a messaging context
    const convoRes = (await target.agent.getConvoForMembers([
      target.did,
      other.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await other.agent.acceptConvo(convoId)

    // Verify target can send before disabling
    const msg1 = (await target.agent.sendMessage(convoId, {
      text: 'Still enabled',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Moderator calls updateActorAccess(did, allowAccess=false)
    await modClient.updateActorAccess(target.did, false)

    // Verify that chatDisabled is now enforced -- target cannot send
    await expect(
      target.agent.sendMessage(convoId, { text: 'Should fail' }),
    ).rejects.toThrow(/Account is disabled/)
  })

  // -----------------------------------------------------------------------
  // Moderator can re-enable chat
  // -----------------------------------------------------------------------

  it('moderator can re-enable chat', async () => {
    const user = await createTestUser(network, 'dis-reenable.test')
    const peer = await createTestUser(network, 'dis-reenpeer.test')

    // Create a conversation and accept
    const convoRes = (await user.agent.getConvoForMembers([
      user.did,
      peer.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await peer.agent.acceptConvo(convoId)

    // Verify messaging works
    const msg1 = (await user.agent.sendMessage(convoId, {
      text: 'Before disable',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Disable chat
    await setChatDisabled(modClient, user.did, true)

    // Confirm it is disabled
    await expect(
      user.agent.sendMessage(convoId, { text: 'While disabled' }),
    ).rejects.toThrow(/Account is disabled/)

    // Re-enable chat
    await setChatDisabled(modClient, user.did, false)

    // Verify user can send messages again
    const msg2 = (await user.agent.sendMessage(convoId, {
      text: 'After re-enable',
    })) as MessageView
    expect(msg2.id).toBeTruthy()
    expect(msg2.text).toBe('After re-enable')
  })

  // -----------------------------------------------------------------------
  // Existing conversations visible but send blocked when disabled
  // -----------------------------------------------------------------------

  it('existing conversations visible but send blocked when disabled', async () => {
    const userA = await createTestUser(network, 'dis-vis-a.test')
    const userB = await createTestUser(network, 'dis-vis-b.test')

    // Create a conversation and exchange messages while chat is enabled
    const convoRes = (await userA.agent.getConvoForMembers([
      userA.did,
      userB.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userB.agent.acceptConvo(convoId)

    // Send some messages so the conversation has content
    await userA.agent.sendMessage(convoId, { text: 'Hello from A' })
    await userB.agent.sendMessage(convoId, { text: 'Hello from B' })

    // Disable chat for userA
    await setChatDisabled(modClient, userA.did, true)

    // listConvos should still work -- userA can see existing conversations
    const listRes = (await userA.agent.listConvos()) as ListConvosResponse
    expect(listRes.convos).toBeDefined()
    expect(Array.isArray(listRes.convos)).toBe(true)
    const foundConvo = listRes.convos.find((c) => c.id === convoId)
    expect(foundConvo).toBeDefined()

    // getConvo should still work -- userA can view the conversation details
    const getRes = (await userA.agent.getConvo(convoId)) as GetConvoResponse
    expect(getRes.convo).toBeDefined()
    expect(getRes.convo.id).toBe(convoId)
    expect(getRes.convo.members).toHaveLength(2)

    // But sendMessage should fail
    await expect(
      userA.agent.sendMessage(convoId, { text: 'Should fail' }),
    ).rejects.toThrow(/Account is disabled/)

    // The other user (userB) should still be able to send
    const msg = (await userB.agent.sendMessage(convoId, {
      text: 'B can still send',
    })) as MessageView
    expect(msg.id).toBeTruthy()
    expect(msg.text).toBe('B can still send')
  })

  // -----------------------------------------------------------------------
  // Non-mod user cannot call updateActorAccess
  // -----------------------------------------------------------------------

  it('non-mod user cannot call updateActorAccess', async () => {
    const regularUser = await createTestUser(network, 'dis-nomod.test')
    const targetUser = await createTestUser(network, 'dis-nomod-t.test')

    // A standard user (not the mod service) tries to call updateActorAccess
    // This should fail because the endpoint requires mod-service authentication
    await expect(
      regularUser.agent.updateActorAccess(targetUser.did, false),
    ).rejects.toThrow()
  })
})
