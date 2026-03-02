import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Mute operations E2E tests.
 *
 * Covers:
 * - Muting a conversation (muteConvo)
 * - Unmuting a conversation (unmuteConvo)
 * - Mute is per-user (does not affect other members)
 * - Mute/unmute returns updated ConvoView
 * - Mute state is reflected in getConvo and listConvos
 *
 * References:
 * - PRD 16.7.9 (Muting a Conversation)
 * - Service: conversation.ts (setMuteState -- self-only event, per errata E5)
 */

// Type helpers
interface ConvoView {
  id: string
  members: Array<{ did: string }>
  muted: boolean
  status: string
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

interface GetConvoResponse {
  convo: ConvoView
}

interface MuteConvoResponse {
  convo: ConvoView
}

interface ListConvosResponse {
  convos: ConvoView[]
}

describe('mute operations', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')

    // Create a conversation
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id

    // Accept the convo
    await bob.agent.acceptConvo(convoId)
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // muteConvo
  // -----------------------------------------------------------------------

  describe('muteConvo', () => {
    it('sets muted=true on the ConvoView', async () => {
      const res = (await alice.agent.muteConvo(
        convoId,
      )) as MuteConvoResponse

      expect(res.convo).toBeDefined()
      expect(res.convo.muted).toBe(true)
    })

    it('muted state is reflected in getConvo', async () => {
      // Ensure muted
      await alice.agent.muteConvo(convoId)

      const res = (await alice.agent.getConvo(convoId)) as GetConvoResponse
      expect(res.convo.muted).toBe(true)
    })

    it('muted state is reflected in listConvos', async () => {
      // Ensure muted
      await alice.agent.muteConvo(convoId)

      const res = (await alice.agent.listConvos()) as ListConvosResponse
      const convo = res.convos.find((c) => c.id === convoId)
      expect(convo).toBeDefined()
      expect(convo!.muted).toBe(true)
    })

    it('is idempotent - muting an already muted convo does not error', async () => {
      await alice.agent.muteConvo(convoId)
      const res = (await alice.agent.muteConvo(
        convoId,
      )) as MuteConvoResponse

      expect(res.convo.muted).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // unmuteConvo
  // -----------------------------------------------------------------------

  describe('unmuteConvo', () => {
    it('sets muted=false on the ConvoView', async () => {
      // Mute first
      await alice.agent.muteConvo(convoId)

      // Unmute
      const res = (await alice.agent.unmuteConvo(
        convoId,
      )) as MuteConvoResponse

      expect(res.convo).toBeDefined()
      expect(res.convo.muted).toBe(false)
    })

    it('unmuted state is reflected in getConvo', async () => {
      // Mute then unmute
      await alice.agent.muteConvo(convoId)
      await alice.agent.unmuteConvo(convoId)

      const res = (await alice.agent.getConvo(convoId)) as GetConvoResponse
      expect(res.convo.muted).toBe(false)
    })

    it('is idempotent - unmuting an already unmuted convo does not error', async () => {
      // Ensure unmuted
      await alice.agent.unmuteConvo(convoId)
      const res = (await alice.agent.unmuteConvo(
        convoId,
      )) as MuteConvoResponse

      expect(res.convo.muted).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Per-user mute isolation
  // -----------------------------------------------------------------------

  describe('per-user mute isolation', () => {
    it('muting does not affect the other member', async () => {
      // Alice mutes
      await alice.agent.muteConvo(convoId)

      // Bob's view should NOT be muted
      const bobView = (await bob.agent.getConvo(convoId)) as GetConvoResponse
      expect(bobView.convo.muted).toBe(false)

      // Clean up
      await alice.agent.unmuteConvo(convoId)
    })

    it('each user has independent mute state', async () => {
      // Alice mutes, Bob does not
      await alice.agent.muteConvo(convoId)

      const aliceView = (await alice.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      const bobView = (await bob.agent.getConvo(convoId)) as GetConvoResponse

      expect(aliceView.convo.muted).toBe(true)
      expect(bobView.convo.muted).toBe(false)

      // Bob mutes too
      await bob.agent.muteConvo(convoId)

      const aliceView2 = (await alice.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      const bobView2 = (await bob.agent.getConvo(convoId)) as GetConvoResponse

      expect(aliceView2.convo.muted).toBe(true)
      expect(bobView2.convo.muted).toBe(true)

      // Alice unmutes, Bob stays muted
      await alice.agent.unmuteConvo(convoId)

      const aliceView3 = (await alice.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      const bobView3 = (await bob.agent.getConvo(convoId)) as GetConvoResponse

      expect(aliceView3.convo.muted).toBe(false)
      expect(bobView3.convo.muted).toBe(true)

      // Clean up
      await bob.agent.unmuteConvo(convoId)
    })
  })

  // -----------------------------------------------------------------------
  // Mute fails for non-member
  // -----------------------------------------------------------------------

  describe('mute authorization', () => {
    it('fails when caller is not a member of the conversation', async () => {
      const carol = await createTestUser(network, 'carol.test')

      await expect(carol.agent.muteConvo(convoId)).rejects.toThrow()
    })
  })
})
