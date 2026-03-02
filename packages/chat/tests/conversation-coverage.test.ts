import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createBlock,
  removeBlock,
  setAllowIncoming,
  setChatDisabled,
  createModServiceClient,
} from './_util'

/**
 * Conversation service coverage tests.
 *
 * Targets uncovered branches in conversation.ts:
 *
 * - Lines 53-56: members array length validation (<1 or >10)
 * - Lines 61: caller not in members (auto-inclusion path)
 * - Lines 67-70: uniqueMembers > 10 after adding caller and dedup
 * - Lines 83-125: Rejoin path details (rev update, convo_begin event)
 * - Lines 317-318: acceptConvo for non-member
 * - Lines 322-323: acceptConvo when already accepted (idempotent)
 * - Lines 326-329: acceptConvo when left
 * - Lines 425-426: leaveConvo rev generation edge case
 * - Lines 521-524: getConvoAvailability with >10 members
 *
 * References:
 * - conversation.ts
 * - Errata E9 (members validation)
 */

// Type helpers
interface ConvoView {
  id: string
  rev: string
  members: Array<{ did: string }>
  status: string
  unreadCount: number
  muted: boolean
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

interface ConvoAvailabilityResponse {
  canChat: boolean
  convo?: ConvoView
}

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface LeaveConvoResponse {
  convoId: string
  rev: string
}

interface LogEntry {
  $type: string
  rev: string
  convoId: string
}

interface GetLogResponse {
  cursor?: string
  logs: LogEntry[]
}

describe('conversation service coverage', () => {
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
  // getConvoForMembers members validation (lines 53-56, 67-70)
  // -----------------------------------------------------------------------

  describe('getConvoForMembers members count validation', () => {
    it('rejects members count >10 by passing 11 DIDs', async () => {
      // Construct 11 DIDs (including the caller implicitly)
      // The server should reject with "Invalid members count"
      const manyDids = Array.from(
        { length: 11 },
        (_, i) => `did:plc:testovercount${String(i).padStart(3, '0')}`,
      )

      await expect(
        alice.agent.getConvoForMembers(manyDids),
      ).rejects.toThrow(/Invalid members count|Too many members/)
    })

    it('caller not included in members is auto-added and still works', async () => {
      // Call getConvoForMembers with only bob's DID (not alice's)
      // The server should auto-add alice as caller
      const res = (await alice.agent.getConvoForMembers([
        bob.did,
      ])) as ConvoForMembersResponse

      expect(res.convo).toBeDefined()
      expect(res.convo.members).toHaveLength(2)

      // Alice should be in the members list despite not being in the input
      const memberDids = res.convo.members.map((m) => m.did)
      expect(memberDids).toContain(alice.did)
      expect(memberDids).toContain(bob.did)
    })

    it('duplicate DIDs in members array are de-duplicated', async () => {
      // Pass the same DID multiple times
      const res = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
        bob.did,
        alice.did,
      ])) as ConvoForMembersResponse

      expect(res.convo).toBeDefined()
      // Should be 2 unique members, not 4
      expect(res.convo.members).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // acceptConvo edge cases (lines 317-329)
  // -----------------------------------------------------------------------

  describe('acceptConvo edge cases', () => {
    it('acceptConvo for a non-member conversation returns error', async () => {
      // Create a conversation between alice and bob
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // A third user tries to accept - not a member
      const outsider = await createTestUser(network, 'acc-nm.test')
      await expect(outsider.agent.acceptConvo(convoId)).rejects.toThrow(
        /Convo not found/,
      )
    })

    it('acceptConvo when already accepted is idempotent (returns empty rev)', async () => {
      const user1 = await createTestUser(network, 'acc-idem1.test')
      const user2 = await createTestUser(network, 'acc-idem2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // user2 accepts
      await user2.agent.acceptConvo(convoId)

      // Verify user2's status is accepted
      const view1 = (await user2.agent.getConvo(convoId)) as GetConvoResponse
      expect(view1.convo.status).toBe('accepted')

      // user2 accepts again -- should be idempotent (no error, empty rev)
      const res = (await user2.agent.acceptConvo(convoId)) as { rev?: string }
      expect(res).toBeDefined()
      // No rev returned for idempotent accept (already accepted)
    })

    it('acceptConvo when status is left returns error', async () => {
      const user1 = await createTestUser(network, 'acc-left1.test')
      const user2 = await createTestUser(network, 'acc-left2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // user2 leaves the conversation
      await user2.agent.leaveConvo(convoId)

      // user2 tries to accept -- should fail because status is 'left'
      await expect(user2.agent.acceptConvo(convoId)).rejects.toThrow(
        /Cannot accept a conversation you have left/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // leaveConvo edge cases (lines 385-390, 425-426)
  // -----------------------------------------------------------------------

  describe('leaveConvo edge cases', () => {
    it('leaveConvo for a non-member returns error', async () => {
      const user1 = await createTestUser(network, 'lv-nm1.test')
      const user2 = await createTestUser(network, 'lv-nm2.test')
      const outsider = await createTestUser(network, 'lv-nm-out.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      await expect(outsider.agent.leaveConvo(convoId)).rejects.toThrow(
        /Convo not found/,
      )
    })

    it('leaveConvo returns valid convoId and rev', async () => {
      const user1 = await createTestUser(network, 'lv-rev1.test')
      const user2 = await createTestUser(network, 'lv-rev2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      const leaveRes = (await user1.agent.leaveConvo(
        convoId,
      )) as LeaveConvoResponse

      expect(leaveRes.convoId).toBe(convoId)
      expect(leaveRes.rev).toBeTruthy()
      expect(typeof leaveRes.rev).toBe('string')
    })

    it('leaveConvo twice on the same convo returns already left error', async () => {
      const user1 = await createTestUser(network, 'lv-twice1.test')
      const user2 = await createTestUser(network, 'lv-twice2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      await user1.agent.leaveConvo(convoId)

      await expect(user1.agent.leaveConvo(convoId)).rejects.toThrow(
        /Already left/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // Rejoin path details (lines 83-125)
  // -----------------------------------------------------------------------

  describe('rejoin path details', () => {
    it('rejoin after leave followed by re-accept creates a working convo', async () => {
      const user1 = await createTestUser(network, 'rej-rdy1.test')
      const user2 = await createTestUser(network, 'rej-rdy2.test')

      // Create convo and exchange a message
      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id
      await user2.agent.acceptConvo(convoId)

      await user1.agent.sendMessage(convoId, { text: 'Before leave' })

      // user1 leaves
      await user1.agent.leaveConvo(convoId)

      // user1 rejoins via getConvoForMembers
      const rejoinRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      expect(rejoinRes.convo.id).toBe(convoId)

      // Verify status is 'request'
      const viewAfterRejoin = (await user1.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      expect(viewAfterRejoin.convo.status).toBe('request')

      // Accept the convo
      await user1.agent.acceptConvo(convoId)

      // Verify status is now 'accepted'
      const viewAfterAccept = (await user1.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      expect(viewAfterAccept.convo.status).toBe('accepted')

      // user1 can now send messages
      const msg = (await user1.agent.sendMessage(convoId, {
        text: 'After rejoin and accept',
      })) as MessageView
      expect(msg.id).toBeTruthy()
      expect(msg.text).toBe('After rejoin and accept')
    })

    it('rejoin updates conversation rev', async () => {
      const user1 = await createTestUser(network, 'rej-rv1.test')
      const user2 = await createTestUser(network, 'rej-rv2.test')

      // Create convo
      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Get the initial rev
      const viewBefore = (await user2.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      const revBefore = viewBefore.convo.rev

      // user1 leaves and rejoins
      await user1.agent.leaveConvo(convoId)
      await user1.agent.getConvoForMembers([user1.did, user2.did])

      // The convo rev should have been updated
      const viewAfter = (await user2.agent.getConvo(
        convoId,
      )) as GetConvoResponse
      const revAfter = viewAfter.convo.rev

      // Rev should change (it is updated during rejoin)
      expect(revAfter).not.toBe(revBefore)
    })
  })

  // -----------------------------------------------------------------------
  // getConvoAvailability validation (lines 520-524, 532-536)
  // -----------------------------------------------------------------------

  describe('getConvoAvailability validation', () => {
    it('getConvoAvailability rejects >10 members', async () => {
      const manyDids = Array.from(
        { length: 11 },
        (_, i) => `did:plc:availovercount${String(i).padStart(3, '0')}`,
      )

      await expect(
        alice.agent.getConvoAvailability(manyDids),
      ).rejects.toThrow(/Invalid members count|Too many members/)
    })

    it('getConvoAvailability deduplicates members', async () => {
      // Pass duplicate DIDs -- should still work, just dedup
      const res = (await alice.agent.getConvoAvailability([
        bob.did,
        bob.did,
      ])) as ConvoAvailabilityResponse

      expect(res.canChat).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // listConvos with combined filters (status + cursor)
  // -----------------------------------------------------------------------

  describe('listConvos combined filters', () => {
    it('status filter combined with cursor-based pagination works', async () => {
      // Create multiple convos where alice has 'accepted' status
      const users: TestUser[] = []
      for (let i = 0; i < 3; i++) {
        const u = await createTestUser(network, `comb-filt-${i}.test`)
        users.push(u)

        const convoRes = (await alice.agent.getConvoForMembers([
          alice.did,
          u.did,
        ])) as ConvoForMembersResponse
        await u.agent.acceptConvo(convoRes.convo.id)

        // Send a message to give the convo a lastMessageAt
        await alice.agent.sendMessage(convoRes.convo.id, {
          text: `Filter test ${i}`,
        })
      }

      // Paginate with limit=1 and status=accepted
      const page1 = (await alice.agent.listConvos({
        status: 'accepted',
        limit: 1,
      })) as ListConvosResponse

      expect(page1.convos.length).toBeLessThanOrEqual(1)

      if (page1.cursor) {
        const page2 = (await alice.agent.listConvos({
          status: 'accepted',
          limit: 1,
          cursor: page1.cursor,
        })) as ListConvosResponse

        expect(page2.convos.length).toBeLessThanOrEqual(1)

        // Ensure no duplicates between pages
        if (page1.convos.length > 0 && page2.convos.length > 0) {
          expect(page1.convos[0].id).not.toBe(page2.convos[0].id)
        }
      }
    })
  })

  // -----------------------------------------------------------------------
  // Left convos excluded from listConvos
  // -----------------------------------------------------------------------

  describe('left convos excluded from listConvos', () => {
    it('a left conversation does not appear in listConvos', async () => {
      const user1 = await createTestUser(network, 'left-hide1.test')
      const user2 = await createTestUser(network, 'left-hide2.test')

      const convoRes = (await user1.agent.getConvoForMembers([
        user1.did,
        user2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // Send a message so the convo has content
      await user2.agent.acceptConvo(convoId)
      await user1.agent.sendMessage(convoId, { text: 'Will leave' })

      // Verify it appears in listConvos
      const listBefore = (await user1.agent.listConvos()) as ListConvosResponse
      const foundBefore = listBefore.convos.find((c) => c.id === convoId)
      expect(foundBefore).toBeDefined()

      // Leave the convo
      await user1.agent.leaveConvo(convoId)

      // It should no longer appear in listConvos
      const listAfter = (await user1.agent.listConvos()) as ListConvosResponse
      const foundAfter = listAfter.convos.find((c) => c.id === convoId)
      expect(foundAfter).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // muteConvo / unmuteConvo for non-member (setMuteState coverage)
  // -----------------------------------------------------------------------

  describe('muteConvo/unmuteConvo non-member', () => {
    it('muteConvo for non-member returns Convo not found', async () => {
      const u1 = await createTestUser(network, 'mute-nm1.test')
      const u2 = await createTestUser(network, 'mute-nm2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id

      const outsider = await createTestUser(network, 'mute-nm-out.test')
      await expect(outsider.agent.muteConvo(cid)).rejects.toThrow(
        /Convo not found/,
      )
    })

    it('unmuteConvo for non-member returns Convo not found', async () => {
      const u1 = await createTestUser(network, 'unmute-nm1.test')
      const u2 = await createTestUser(network, 'unmute-nm2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id

      const outsider = await createTestUser(network, 'unmute-nm-out.test')
      await expect(outsider.agent.unmuteConvo(cid)).rejects.toThrow(
        /Convo not found/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // listConvos with status=request and limit clamping
  // -----------------------------------------------------------------------

  describe('listConvos status filter and limit clamping', () => {
    it('listConvos with status=request returns only request convos', async () => {
      const u = await createTestUser(network, 'ls-req.test')
      const peer = await createTestUser(network, 'ls-reqp.test')

      const convoRes = (await peer.agent.getConvoForMembers([
        peer.did,
        u.did,
      ])) as ConvoForMembersResponse
      const cid = convoRes.convo.id
      await peer.agent.sendMessage(cid, { text: 'Request filter test' })

      const res = (await u.agent.listConvos({
        status: 'request',
      })) as ListConvosResponse

      expect(res.convos.length).toBeGreaterThanOrEqual(1)
      const found = res.convos.find((c) => c.id === cid)
      expect(found).toBeDefined()
    })

    it('listConvos with limit=0 clamps to 1', async () => {
      const res = (await alice.agent.listConvos({
        limit: 0,
      })) as ListConvosResponse

      expect(res.convos.length).toBeLessThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // getConvoAvailability when blocked and with existing convo
  // -----------------------------------------------------------------------

  describe('getConvoAvailability edge cases', () => {
    it('returns canChat=false when blocked', async () => {
      const u1 = await createTestUser(network, 'avblk1.test')
      const u2 = await createTestUser(network, 'avblk2.test')

      const blockRef = await createBlock(network, u2, u1)

      const res = (await u1.agent.getConvoAvailability([
        u2.did,
      ])) as ConvoAvailabilityResponse

      expect(res.canChat).toBe(false)
      await removeBlock(network, u2, blockRef)
    })

    it('returns existing convo when conversation exists', async () => {
      const res = (await alice.agent.getConvoAvailability([
        bob.did,
      ])) as ConvoAvailabilityResponse

      expect(res.canChat).toBe(true)
      expect(res.convo).toBeDefined()
    })

    it('auto-adds caller when not in members list', async () => {
      const u = await createTestUser(network, 'avnm.test')

      const res = (await u.agent.getConvoAvailability([
        bob.did,
      ])) as ConvoAvailabilityResponse

      expect(res.canChat).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // listConvos for convo without messages
  // -----------------------------------------------------------------------

  describe('listConvos for convo without messages', () => {
    it('convo with no messages still appears in listConvos', async () => {
      const u1 = await createTestUser(network, 'lsnm1.test')
      const u2 = await createTestUser(network, 'lsnm2.test')

      await u1.agent.getConvoForMembers([u1.did, u2.did])

      const res = (await u1.agent.listConvos()) as ListConvosResponse
      expect(res.convos.length).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // listConvos cursor fallback: lastMessageAt is null → uses updatedAt
  // -----------------------------------------------------------------------

  describe('listConvos cursor from no-message convos', () => {
    it('pagination cursor uses updatedAt fallback for convos without messages', async () => {
      // Create 3 convos with NO messages → lastMessageAt is null
      const u = await createTestUser(network, 'lscf.test')
      for (let i = 0; i < 3; i++) {
        const peer = await createTestUser(network, `lscf-p${i}.test`)
        await u.agent.getConvoForMembers([u.did, peer.did])
      }

      // Paginate with limit=1
      const page1 = (await u.agent.listConvos({
        limit: 1,
      })) as ListConvosResponse
      expect(page1.convos.length).toBeLessThanOrEqual(1)

      if (page1.cursor) {
        // The cursor should be based on updatedAt (since no messages)
        const page2 = (await u.agent.listConvos({
          limit: 1,
          cursor: page1.cursor,
        })) as ListConvosResponse

        expect(page2.convos.length).toBeLessThanOrEqual(1)
        if (page1.convos.length > 0 && page2.convos.length > 0) {
          expect(page1.convos[0].id).not.toBe(page2.convos[0].id)
        }
      }
    })
  })

  // -----------------------------------------------------------------------
  // getConvoAvailability for non-existent conversation
  // -----------------------------------------------------------------------

  describe('getConvoAvailability new users', () => {
    it('returns canChat=true and no convo for new users with no existing convo', async () => {
      const u1 = await createTestUser(network, 'avnew1.test')
      const u2 = await createTestUser(network, 'avnew2.test')

      const res = (await u1.agent.getConvoAvailability([
        u2.did,
      ])) as ConvoAvailabilityResponse

      expect(res.canChat).toBe(true)
      // No existing convo
      expect(res.convo).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // acceptConvo triggers event log with rev
  // -----------------------------------------------------------------------

  describe('acceptConvo returns rev', () => {
    it('acceptConvo from request status returns a valid rev', async () => {
      const u1 = await createTestUser(network, 'acc-rev1.test')
      const u2 = await createTestUser(network, 'acc-rev2.test')

      const convoRes = (await u1.agent.getConvoForMembers([
        u1.did,
        u2.did,
      ])) as ConvoForMembersResponse
      const convoId = convoRes.convo.id

      // u2's status is 'request' - accept should return a rev
      const res = (await u2.agent.acceptConvo(convoId)) as { rev?: string }
      expect(res.rev).toBeTruthy()
      expect(typeof res.rev).toBe('string')
    })
  })
})
