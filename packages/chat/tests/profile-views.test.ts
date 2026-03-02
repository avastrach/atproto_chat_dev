import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Profile data in conversation views E2E tests.
 *
 * Covers:
 * - Conversation members have profile data (ProfileViewBasic)
 * - Profile data includes handle field
 * - Convo view members array length matches the number of participants
 *
 * References:
 * - Views: index.ts (ViewBuilder.buildConvoView, buildProfileViewBasic)
 * - Lexicon: chat.bsky.actor.defs#profileViewBasic
 * - Errata E6: $type must be 'chat.bsky.actor.defs#profileViewBasic'
 */

// Type helpers for casting XRPC responses
interface ProfileViewBasic {
  $type?: string
  did: string
  handle?: string
  displayName?: string
  avatar?: string
  chatDisabled?: boolean
}

interface ConvoView {
  id: string
  rev: string
  members: ProfileViewBasic[]
  status: string
  unreadCount: number
  muted: boolean
  lastMessage?: unknown
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

describe('profile data in conversation views', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser
  let convoIdAliceBob: string
  let convoIdAliceCarol: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'prof-alice.test')
    bob = await createTestUser(network, 'prof-bob.test')
    carol = await createTestUser(network, 'prof-carol.test')

    // Create conversations for profile view tests
    const convoRes1 = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoIdAliceBob = convoRes1.convo.id

    const convoRes2 = (await alice.agent.getConvoForMembers([
      alice.did,
      carol.did,
    ])) as ConvoForMembersResponse
    convoIdAliceCarol = convoRes2.convo.id
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // Conversation members have profile data
  // -----------------------------------------------------------------------

  it('conversation members have profile data', async () => {
    const res = (await alice.agent.getConvo(
      convoIdAliceBob,
    )) as GetConvoResponse

    expect(res.convo).toBeDefined()
    expect(res.convo.members).toBeDefined()
    expect(Array.isArray(res.convo.members)).toBe(true)
    expect(res.convo.members).toHaveLength(2)

    // Each member should have a 'did' field at minimum
    for (const member of res.convo.members) {
      expect(member.did).toBeTruthy()
      expect(typeof member.did).toBe('string')
      // DID should start with 'did:'
      expect(member.did).toMatch(/^did:/)
    }

    // Verify both alice and bob are present in the members list
    const memberDids = res.convo.members.map((m) => m.did).sort()
    expect(memberDids).toEqual([alice.did, bob.did].sort())
  })

  // -----------------------------------------------------------------------
  // Profile data includes handle
  // -----------------------------------------------------------------------

  it('profile data includes handle', async () => {
    const res = (await alice.agent.getConvo(
      convoIdAliceBob,
    )) as GetConvoResponse

    expect(res.convo.members).toHaveLength(2)

    // Find alice's and bob's profile views in the members array
    const aliceProfile = res.convo.members.find((m) => m.did === alice.did)
    const bobProfile = res.convo.members.find((m) => m.did === bob.did)

    expect(aliceProfile).toBeDefined()
    expect(bobProfile).toBeDefined()

    // Both profiles should have a handle field
    expect(aliceProfile!.handle).toBeDefined()
    expect(typeof aliceProfile!.handle).toBe('string')
    expect(aliceProfile!.handle).toBeTruthy()

    expect(bobProfile!.handle).toBeDefined()
    expect(typeof bobProfile!.handle).toBe('string')
    expect(bobProfile!.handle).toBeTruthy()

    // Handles should match the handles used at creation time
    expect(aliceProfile!.handle).toBe(alice.handle)
    expect(bobProfile!.handle).toBe(bob.handle)
  })

  // -----------------------------------------------------------------------
  // Convo view includes member count matching participants
  // -----------------------------------------------------------------------

  it('convo view includes member count matching participants', async () => {
    // Two-person convo: alice + bob
    const twoPersonConvo = (await alice.agent.getConvo(
      convoIdAliceBob,
    )) as GetConvoResponse
    expect(twoPersonConvo.convo.members).toHaveLength(2)

    // Verify from both sides -- bob should also see 2 members
    const bobView = (await bob.agent.getConvo(
      convoIdAliceBob,
    )) as GetConvoResponse
    expect(bobView.convo.members).toHaveLength(2)

    // Different convo: alice + carol -- also 2 members
    const aliceCarolConvo = (await alice.agent.getConvo(
      convoIdAliceCarol,
    )) as GetConvoResponse
    expect(aliceCarolConvo.convo.members).toHaveLength(2)

    // Verify from carol's side
    const carolView = (await carol.agent.getConvo(
      convoIdAliceCarol,
    )) as GetConvoResponse
    expect(carolView.convo.members).toHaveLength(2)

    // Members array in listConvos should also have correct length
    const listRes = (await alice.agent.listConvos()) as ListConvosResponse
    expect(listRes.convos.length).toBeGreaterThanOrEqual(2)

    for (const convo of listRes.convos) {
      // Each conversation should have exactly 2 members (DM-style)
      expect(convo.members).toHaveLength(2)
    }
  })
})
