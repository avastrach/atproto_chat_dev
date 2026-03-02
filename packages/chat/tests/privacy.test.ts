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
 * Privacy controls and chat-disabled E2E tests.
 *
 * Covers:
 * - allowIncoming=none rejects new conversations
 * - allowIncoming=following rejects non-followers
 * - allowIncoming=following allows followers
 * - allowIncoming=all allows anyone
 * - Existing conversations continue regardless of allowIncoming setting
 * - chatDisabled user cannot send messages
 *
 * References:
 * - PRD 13.1 (allowIncoming Settings)
 * - PRD 13.3 (Privacy Error Messages)
 * - PRD 14.1 (chatDisabled Flag Detection)
 * - PRD 17.7.1 (checkCanInitiateConvo)
 * - Error code 13: "Account is disabled"
 * - Error code 14: "recipient has disabled incoming messages"
 * - Error code 15: "recipient requires incoming messages to come from someone they follow"
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

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface ConvoAvailabilityResponse {
  canChat: boolean
  convo?: ConvoView
}

// ---------------------------------------------------------------------------
// Follow helper -- creates an app.bsky.graph.follow record on the PDS
// ---------------------------------------------------------------------------

/**
 * Create a follow relationship from `follower` to `followed`.
 *
 * Uses raw HTTP fetch against the PDS XRPC endpoint, authenticated
 * with the follower's access JWT from the SeedClient account store.
 */
async function createFollow(
  network: TestNetwork,
  follower: TestUser,
  followed: TestUser,
): Promise<{ uri: string; cid: string }> {
  const accessJwt = follower.accessJwt

  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: follower.did,
        collection: 'app.bsky.graph.follow',
        record: {
          $type: 'app.bsky.graph.follow',
          subject: followed.did,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createFollow failed (${res.status}): ${body}`)
  }

  const data = (await res.json()) as { uri: string; cid: string }
  // Propagate the follow record to appview/chat
  await network.processAll()
  return { uri: data.uri, cid: data.cid }
}

describe('privacy controls', () => {
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
  // allowIncoming=none rejects new conversations
  // -----------------------------------------------------------------------

  it('allowIncoming=none rejects new conversations', async () => {
    const recipient = await createTestUser(network, 'priv-none-rcpt.test')
    const sender = await createTestUser(network, 'priv-none-sndr.test')

    // Recipient sets allowIncoming to 'none'
    await setAllowIncoming(recipient.agent, 'none')

    // Sender tries to start a conversation -- should be rejected
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(/recipient has disabled incoming messages/)
  })

  // -----------------------------------------------------------------------
  // allowIncoming=following rejects non-followers
  // -----------------------------------------------------------------------

  it('allowIncoming=following rejects non-followers', async () => {
    const recipient = await createTestUser(network, 'priv-fol-rcpt.test')
    const sender = await createTestUser(network, 'priv-fol-sndr.test')

    // Recipient sets allowIncoming to 'following'
    await setAllowIncoming(recipient.agent, 'following')

    // Sender is NOT followed by recipient -- should be rejected
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(
      /recipient requires incoming messages to come from someone they follow/,
    )
  })

  // -----------------------------------------------------------------------
  // allowIncoming=following allows followers
  // -----------------------------------------------------------------------

  it('allowIncoming=following allows followers', async () => {
    const recipient = await createTestUser(network, 'priv-foly-rcpt.test')
    const sender = await createTestUser(network, 'priv-foly-sndr.test')

    // Recipient sets allowIncoming to 'following'
    await setAllowIncoming(recipient.agent, 'following')

    // Recipient follows sender -- this establishes the follow relationship
    await createFollow(network, recipient, sender)

    // Now sender can start a conversation with recipient
    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      recipient.did,
    ])) as ConvoForMembersResponse

    expect(convoRes.convo).toBeDefined()
    expect(convoRes.convo.id).toBeTruthy()
    expect(convoRes.convo.members).toHaveLength(2)

    const memberDids = convoRes.convo.members.map((m) => m.did).sort()
    expect(memberDids).toEqual([sender.did, recipient.did].sort())
  })

  // -----------------------------------------------------------------------
  // allowIncoming=all allows anyone
  // -----------------------------------------------------------------------

  it('allowIncoming=all allows anyone', async () => {
    const recipient = await createTestUser(network, 'priv-all-rcpt.test')
    const sender = await createTestUser(network, 'priv-all-sndr.test')

    // Recipient sets allowIncoming to 'all'
    await setAllowIncoming(recipient.agent, 'all')

    // Any user can start a conversation -- no follow relationship needed
    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      recipient.did,
    ])) as ConvoForMembersResponse

    expect(convoRes.convo).toBeDefined()
    expect(convoRes.convo.id).toBeTruthy()
    expect(convoRes.convo.members).toHaveLength(2)
  })

  // -----------------------------------------------------------------------
  // Existing conversations continue regardless of allowIncoming setting
  // -----------------------------------------------------------------------

  it('existing conversations continue regardless of allowIncoming setting', async () => {
    const userA = await createTestUser(network, 'priv-exist-a.test')
    const userB = await createTestUser(network, 'priv-exist-b.test')

    // Start with allowIncoming='all' so conversation can be created
    await setAllowIncoming(userB.agent, 'all')

    // Create a conversation and accept it
    const convoRes = (await userA.agent.getConvoForMembers([
      userA.did,
      userB.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userB.agent.acceptConvo(convoId)

    // Send a message to confirm it works
    const msg1 = (await userA.agent.sendMessage(convoId, {
      text: 'Before privacy change',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Now userB changes their allowIncoming to 'none'
    await setAllowIncoming(userB.agent, 'none')

    // userA can still send messages in the existing conversation
    // (allowIncoming only applies to NEW conversation creation,
    // not to existing conversations -- only block checks apply to sends)
    const msg2 = (await userA.agent.sendMessage(convoId, {
      text: 'After privacy change to none',
    })) as MessageView
    expect(msg2.id).toBeTruthy()
    expect(msg2.text).toBe('After privacy change to none')

    // userB can also still send in the existing conversation
    const msg3 = (await userB.agent.sendMessage(convoId, {
      text: 'Reply after privacy change',
    })) as MessageView
    expect(msg3.id).toBeTruthy()
    expect(msg3.text).toBe('Reply after privacy change')
  })

  // -----------------------------------------------------------------------
  // chatDisabled user cannot send messages
  // -----------------------------------------------------------------------

  it('chatDisabled user cannot send messages', async () => {
    const userX = await createTestUser(network, 'priv-dis-x.test')
    const userY = await createTestUser(network, 'priv-dis-y.test')

    // Create a conversation while chat is enabled
    const convoRes = (await userX.agent.getConvoForMembers([
      userX.did,
      userY.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userY.agent.acceptConvo(convoId)

    // Verify messaging works before disabling
    const msg1 = (await userX.agent.sendMessage(convoId, {
      text: 'Before disable',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Moderator disables userX's chat
    await setChatDisabled(modClient, userX.did, true)

    // userX tries to send a message -- should fail with "Account is disabled"
    await expect(
      userX.agent.sendMessage(convoId, { text: 'After disable' }),
    ).rejects.toThrow(/Account is disabled/)

    // userX also cannot create new conversations
    const userZ = await createTestUser(network, 'priv-dis-z.test')
    await expect(
      userX.agent.getConvoForMembers([userX.did, userZ.did]),
    ).rejects.toThrow(/Account is disabled/)

    // Re-enable chat and verify messaging works again
    await setChatDisabled(modClient, userX.did, false)

    const msg2 = (await userX.agent.sendMessage(convoId, {
      text: 'After re-enable',
    })) as MessageView
    expect(msg2.id).toBeTruthy()
    expect(msg2.text).toBe('After re-enable')
  })

  // -----------------------------------------------------------------------
  // chatDisabled on caller blocks getConvoAvailability
  // -----------------------------------------------------------------------

  it('chatDisabled caller gets canChat=false from getConvoAvailability', async () => {
    const caller = await createTestUser(network, 'priv-disa-c.test')
    const recipient = await createTestUser(network, 'priv-disa-r.test')

    // Moderator disables caller's chat
    await setChatDisabled(modClient, caller.did, true)

    // getConvoAvailability calls checkCanInitiateConvo which checks
    // callerProfile.chatDisabled first. This should return canChat=false.
    const res = (await caller.agent.getConvoAvailability([
      recipient.did,
    ])) as ConvoAvailabilityResponse

    expect(res.canChat).toBe(false)

    // Restore access for cleanup
    await setChatDisabled(modClient, caller.did, false)
  })

  // -----------------------------------------------------------------------
  // chatDisabled on recipient blocks new conversation creation
  // -----------------------------------------------------------------------

  it('chatDisabled recipient blocks new conversation creation', async () => {
    const sender = await createTestUser(network, 'priv-disb-s.test')
    const recipient = await createTestUser(network, 'priv-disb-r.test')

    // Moderator disables recipient's chat
    await setChatDisabled(modClient, recipient.did, true)

    // Sender tries to create a conversation with the disabled recipient
    // checkCanInitiateConvo checks recipientProfile.chatDisabled
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(/recipient has disabled incoming messages/)

    // Restore access for cleanup
    await setChatDisabled(modClient, recipient.did, false)
  })

  // -----------------------------------------------------------------------
  // allowIncoming=following via getConvoAvailability (not getConvoForMembers)
  // -----------------------------------------------------------------------

  it('getConvoAvailability returns canChat=false when allowIncoming=following and no follow', async () => {
    const sender = await createTestUser(network, 'priv-avnf-s.test')
    const recipient = await createTestUser(network, 'priv-avnf-r.test')

    // Recipient sets allowIncoming to 'following'
    await setAllowIncoming(recipient.agent, 'following')

    // Sender is NOT followed by recipient
    const res = (await sender.agent.getConvoAvailability([
      recipient.did,
    ])) as ConvoAvailabilityResponse

    expect(res.canChat).toBe(false)
  })

  it('getConvoAvailability returns canChat=true when allowIncoming=following and follow exists', async () => {
    const sender = await createTestUser(network, 'priv-avyf-s.test')
    const recipient = await createTestUser(network, 'priv-avyf-r.test')

    // Recipient sets allowIncoming to 'following'
    await setAllowIncoming(recipient.agent, 'following')

    // Recipient follows sender
    await createFollow(network, recipient, sender)

    const res = (await sender.agent.getConvoAvailability([
      recipient.did,
    ])) as ConvoAvailabilityResponse

    expect(res.canChat).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Default allowIncoming behavior (no explicit setting)
  // -----------------------------------------------------------------------

  it('default allowIncoming (no explicit setting) uses following behavior', async () => {
    // Create a user WITHOUT setting allowIncoming -- server defaults to 'following'
    const recipient = await createTestUser(
      network,
      'priv-def-r.test',
      { skipAllowIncoming: true },
    )
    const sender = await createTestUser(network, 'priv-def-s.test')

    // Without a follow relationship, should be rejected (default = 'following')
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(
      /recipient requires incoming messages to come from someone they follow/,
    )

    // After recipient follows sender, it should work
    await createFollow(network, recipient, sender)

    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      recipient.did,
    ])) as ConvoForMembersResponse

    expect(convoRes.convo).toBeDefined()
    expect(convoRes.convo.id).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // Block checks in existing conversations (checkCanSendToMember)
  // -----------------------------------------------------------------------

  it('block prevents sending messages in existing conversations (checkCanSendToMember)', async () => {
    // This exercises checkCanSendToMember (privacy.ts lines 150-176):
    // - The isBlocked call within checkCanSendToMember
    // - The block detection and rejection path
    // Different from checkCanInitiateConvo: does NOT check allowIncoming.
    const userA = await createTestUser(network, 'priv-blksend-a.test')
    const userB = await createTestUser(network, 'priv-blksend-b.test')

    // Create a conversation while no blocks exist
    const convoRes = (await userA.agent.getConvoForMembers([
      userA.did,
      userB.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userB.agent.acceptConvo(convoId)

    // Verify messaging works
    const msg1 = (await userA.agent.sendMessage(convoId, {
      text: 'Before block',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // userB blocks userA
    await createBlock(network, userB, userA)

    // userA tries to send -- checkCanSendToMember should detect the block
    await expect(
      userA.agent.sendMessage(convoId, { text: 'After block' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // userB also cannot send to userA (block is bilateral)
    await expect(
      userB.agent.sendMessage(convoId, { text: 'Blocked too' }),
    ).rejects.toThrow(/block between recipient and sender/)
  })

  // -----------------------------------------------------------------------
  // chatDisabled on recipient does NOT block existing conversations
  // -----------------------------------------------------------------------

  it('chatDisabled recipient can still receive messages in existing convos', async () => {
    // checkCanSendToMember does NOT check recipient's chatDisabled.
    // Only the caller's chatDisabled is checked.
    // This tests that the recipient's chatDisabled flag does not prevent
    // the OTHER party from sending messages (privacy.ts lines 150-176).
    const sender = await createTestUser(network, 'priv-rdis-s.test')
    const recipient = await createTestUser(network, 'priv-rdis-r.test')

    // Create a conversation
    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      recipient.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await recipient.agent.acceptConvo(convoId)

    // Disable recipient's chat
    await setChatDisabled(modClient, recipient.did, true)

    // Sender can still send (recipient's chatDisabled is not checked in
    // checkCanSendToMember -- only caller's chatDisabled is checked)
    const msg = (await sender.agent.sendMessage(convoId, {
      text: 'Recipient disabled but I can still send',
    })) as MessageView
    expect(msg.id).toBeTruthy()

    // Recipient tries to send -- THEIR chatDisabled should prevent it
    // (message.ts line 152 checks callerProfile.chatDisabled before
    // calling checkCanSendToMember)
    await expect(
      recipient.agent.sendMessage(convoId, { text: 'I am disabled' }),
    ).rejects.toThrow(/Account is disabled/)

    // Restore
    await setChatDisabled(modClient, recipient.did, false)
  })

  // -----------------------------------------------------------------------
  // isBlocked: no blocks returns blocked=false
  // -----------------------------------------------------------------------

  it('isBlocked returns blocked=false when there are no blocks', async () => {
    // This exercises privacy.ts isBlocked lines 204-213, 228-245.
    // When there are no blocks, the function returns { blocked: false }
    // through the normal path (line 245).
    // We test this by checking that two users with no blocks can
    // create conversations and send messages without issue.
    const u1 = await createTestUser(network, 'priv-noblock-a.test')
    const u2 = await createTestUser(network, 'priv-noblock-b.test')

    const convoRes = (await u1.agent.getConvoForMembers([
      u1.did,
      u2.did,
    ])) as ConvoForMembersResponse
    expect(convoRes.convo.id).toBeTruthy()
    expect(convoRes.convo.members).toHaveLength(2)
  })

  // -----------------------------------------------------------------------
  // getFollowState: follow relationship detected correctly
  // -----------------------------------------------------------------------

  it('getFollowState detects follow relationship for allowIncoming=following', async () => {
    // This exercises privacy.ts getFollowState lines 280-315.
    // Create users, establish a follow, and verify the follow-based
    // allowIncoming check succeeds.
    const recipient = await createTestUser(network, 'priv-gfs-r.test')
    const sender = await createTestUser(network, 'priv-gfs-s.test')

    // Set recipient to following-only
    await setAllowIncoming(recipient.agent, 'following')

    // Verify sender cannot initiate without follow
    const avail1 = (await sender.agent.getConvoAvailability([
      recipient.did,
    ])) as ConvoAvailabilityResponse
    expect(avail1.canChat).toBe(false)

    // Recipient follows sender
    await createFollow(network, recipient, sender)

    // Now getFollowState should detect the relationship
    const avail2 = (await sender.agent.getConvoAvailability([
      recipient.did,
    ])) as ConvoAvailabilityResponse
    expect(avail2.canChat).toBe(true)
  })

  // -----------------------------------------------------------------------
  // isBlocked: caller-blocks-recipient direction
  // -----------------------------------------------------------------------

  it('caller blocking recipient prevents conversation creation', async () => {
    // This exercises isBlocked lines 228-239: callerBlocksRecipient path.
    // Previous tests only tested recipient-blocks-caller direction.
    const blocker = await createTestUser(network, 'priv-cblk-a.test')
    const target = await createTestUser(network, 'priv-cblk-b.test')

    // blocker creates a block on target
    const blockRef = await createBlock(network, blocker, target)

    // blocker tries to create a conversation with target → should fail
    await expect(
      blocker.agent.getConvoForMembers([blocker.did, target.did]),
    ).rejects.toThrow(/block between recipient and sender/)

    // Clean up
    await removeBlock(network, blocker, blockRef)
  })

  it('caller blocking recipient shows canChat=false in getConvoAvailability', async () => {
    const blocker = await createTestUser(network, 'priv-cblkav-a.test')
    const target = await createTestUser(network, 'priv-cblkav-b.test')

    const blockRef = await createBlock(network, blocker, target)

    const res = (await blocker.agent.getConvoAvailability([
      target.did,
    ])) as ConvoAvailabilityResponse

    expect(res.canChat).toBe(false)

    await removeBlock(network, blocker, blockRef)
  })

  // -----------------------------------------------------------------------
  // isBlocked: mutual blocks (both directions)
  // -----------------------------------------------------------------------

  it('mutual blocks prevent conversation creation from either side', async () => {
    // This exercises isBlocked lines 235-236: both callerBlocksRecipient
    // AND recipientBlocksCaller are true.
    const userA = await createTestUser(network, 'priv-mutblk-a.test')
    const userB = await createTestUser(network, 'priv-mutblk-b.test')

    // Both users block each other
    const blockRefAB = await createBlock(network, userA, userB)
    const blockRefBA = await createBlock(network, userB, userA)

    // Neither can create a conversation
    await expect(
      userA.agent.getConvoForMembers([userA.did, userB.did]),
    ).rejects.toThrow(/block between recipient and sender/)

    await expect(
      userB.agent.getConvoForMembers([userB.did, userA.did]),
    ).rejects.toThrow(/block between recipient and sender/)

    // Both show canChat=false
    const resA = (await userA.agent.getConvoAvailability([
      userB.did,
    ])) as ConvoAvailabilityResponse
    expect(resA.canChat).toBe(false)

    const resB = (await userB.agent.getConvoAvailability([
      userA.did,
    ])) as ConvoAvailabilityResponse
    expect(resB.canChat).toBe(false)

    // Clean up
    await removeBlock(network, userA, blockRefAB)
    await removeBlock(network, userB, blockRefBA)
  })

  // -----------------------------------------------------------------------
  // isBlocked: caller blocks recipient in existing convo (checkCanSendToMember)
  // -----------------------------------------------------------------------

  it('caller blocking recipient prevents sending in existing conversations', async () => {
    // This tests checkCanSendToMember with the caller-blocks-recipient direction.
    // Previous test 'block prevents sending' only tested recipient-blocks-caller.
    const userA = await createTestUser(network, 'priv-cblksnd-a.test')
    const userB = await createTestUser(network, 'priv-cblksnd-b.test')

    // Create convo
    const convoRes = (await userA.agent.getConvoForMembers([
      userA.did,
      userB.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userB.agent.acceptConvo(convoId)

    // Verify messaging works
    const msg1 = (await userA.agent.sendMessage(convoId, {
      text: 'Before I block you',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // userA blocks userB (caller blocking recipient direction)
    const blockRef = await createBlock(network, userA, userB)

    // userA tries to send — should fail because userA blocks userB
    await expect(
      userA.agent.sendMessage(convoId, { text: 'After I block you' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Clean up
    await removeBlock(network, userA, blockRef)
  })

  // -----------------------------------------------------------------------
  // checkCanSendToMember: mutual blocks in existing convo
  // -----------------------------------------------------------------------

  it('mutual blocks prevent both users from sending in existing conversations', async () => {
    const userA = await createTestUser(network, 'priv-mutblksnd-a.test')
    const userB = await createTestUser(network, 'priv-mutblksnd-b.test')

    // Create and accept convo
    const convoRes = (await userA.agent.getConvoForMembers([
      userA.did,
      userB.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userB.agent.acceptConvo(convoId)

    // Both block each other
    const blockRefAB = await createBlock(network, userA, userB)
    const blockRefBA = await createBlock(network, userB, userA)

    // Neither can send
    await expect(
      userA.agent.sendMessage(convoId, { text: 'Blocked both ways A' }),
    ).rejects.toThrow(/block between recipient and sender/)

    await expect(
      userB.agent.sendMessage(convoId, { text: 'Blocked both ways B' }),
    ).rejects.toThrow(/block between recipient and sender/)

    // Clean up
    await removeBlock(network, userA, blockRefAB)
    await removeBlock(network, userB, blockRefBA)
  })

  // -----------------------------------------------------------------------
  // allowIncoming change from 'none' to 'all' allows new conversations
  // -----------------------------------------------------------------------

  it('changing allowIncoming from none to all allows new conversations', async () => {
    const recipient = await createTestUser(network, 'priv-toggle-r.test')
    const sender = await createTestUser(network, 'priv-toggle-s.test')

    // Initially set to 'none' — cannot create convo
    await setAllowIncoming(recipient.agent, 'none')
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(/recipient has disabled incoming messages/)

    // Change to 'all' — now should succeed
    await setAllowIncoming(recipient.agent, 'all')
    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      recipient.did,
    ])) as ConvoForMembersResponse
    expect(convoRes.convo).toBeDefined()
    expect(convoRes.convo.id).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // chatDisabled on recipient for getConvoAvailability
  // -----------------------------------------------------------------------

  it('chatDisabled recipient shows canChat=false in getConvoAvailability', async () => {
    const sender = await createTestUser(network, 'priv-rdisav-s.test')
    const recipient = await createTestUser(network, 'priv-rdisav-r.test')

    // Disable recipient's chat
    await setChatDisabled(modClient, recipient.did, true)

    const res = (await sender.agent.getConvoAvailability([
      recipient.did,
    ])) as ConvoAvailabilityResponse
    expect(res.canChat).toBe(false)

    // Restore
    await setChatDisabled(modClient, recipient.did, false)
  })
})
