import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  createTestNetwork,
  createTestUser,
  setAllowIncoming,
} from './_util'

/**
 * actor.declaration endpoint & allowIncoming privacy enforcement E2E tests.
 *
 * Covers:
 * - Default allowIncoming value for new users
 * - Setting allowIncoming to all / none / following
 * - Rejection of invalid allowIncoming values
 * - Persistence of the declaration across API calls
 * - allowIncoming=none blocks new conversation creation
 * - allowIncoming=following blocks non-follower conversation creation
 * - Changing allowIncoming affects future conversations only
 * - Existing accepted conversations are unaffected by declaration changes
 *
 * References:
 * - PRD 13.1 (allowIncoming Settings)
 * - PRD 17.7.1 (checkCanInitiateConvo)
 * - chat.bsky.actor.declaration (GET) / chat.bsky.actor.updateDeclaration (POST)
 */

// Type helpers for casting XRPC responses
interface DeclarationResponse {
  allowIncoming: string
}

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

describe('actor.declaration and allowIncoming privacy enforcement', () => {
  let network: TestNetwork

  beforeAll(async () => {
    network = await createTestNetwork()
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // 1. Default allowIncoming is "following"
  // -----------------------------------------------------------------------

  it('default allowIncoming is following', async () => {
    const user = await createTestUser(network, 'decl-default.test', {
      skipAllowIncoming: true,
    })

    // A brand-new user with no declaration should default to "following"
    const res = (await user.agent.getDeclaration()) as DeclarationResponse

    expect(res.allowIncoming).toBe('following')
  })

  // -----------------------------------------------------------------------
  // 2. Can set allowIncoming to "all"
  // -----------------------------------------------------------------------

  it('can set allowIncoming to all', async () => {
    const user = await createTestUser(network, 'decl-all.test')

    await user.agent.setDeclaration('all')
    const res = (await user.agent.getDeclaration()) as DeclarationResponse

    expect(res.allowIncoming).toBe('all')
  })

  // -----------------------------------------------------------------------
  // 3. Can set allowIncoming to "none"
  // -----------------------------------------------------------------------

  it('can set allowIncoming to none', async () => {
    const user = await createTestUser(network, 'decl-none.test')

    await user.agent.setDeclaration('none')
    const res = (await user.agent.getDeclaration()) as DeclarationResponse

    expect(res.allowIncoming).toBe('none')
  })

  // -----------------------------------------------------------------------
  // 4. Can set allowIncoming to "following" (after changing from all)
  // -----------------------------------------------------------------------

  it('can set allowIncoming to following', async () => {
    const user = await createTestUser(network, 'decl-fol.test')

    // First change to "all" so we can verify toggling back to "following"
    await user.agent.setDeclaration('all')
    const afterAll = (await user.agent.getDeclaration()) as DeclarationResponse
    expect(afterAll.allowIncoming).toBe('all')

    // Now change to "following"
    await user.agent.setDeclaration('following')
    const afterFollowing =
      (await user.agent.getDeclaration()) as DeclarationResponse
    expect(afterFollowing.allowIncoming).toBe('following')
  })

  // -----------------------------------------------------------------------
  // 5. Rejects invalid values
  // -----------------------------------------------------------------------

  it('rejects invalid values', async () => {
    // Use skipAllowIncoming so the user retains the server default ('following')
    const user = await createTestUser(network, 'decl-invalid.test', {
      skipAllowIncoming: true,
    })

    // Attempting to set an invalid allowIncoming value should throw
    await expect(user.agent.setDeclaration('invalid')).rejects.toThrow(
      /allowIncoming is required and must be one of: all, following, none/,
    )

    // The original default should remain intact
    const res = (await user.agent.getDeclaration()) as DeclarationResponse
    expect(res.allowIncoming).toBe('following')
  })

  // -----------------------------------------------------------------------
  // 6. Setting persists across API calls
  // -----------------------------------------------------------------------

  it('setting persists across API calls', async () => {
    const user = await createTestUser(network, 'decl-persist.test')

    // Set to "all", verify, set to "none", verify, set to "following", verify
    await user.agent.setDeclaration('all')
    const res1 = (await user.agent.getDeclaration()) as DeclarationResponse
    expect(res1.allowIncoming).toBe('all')

    await user.agent.setDeclaration('none')
    const res2 = (await user.agent.getDeclaration()) as DeclarationResponse
    expect(res2.allowIncoming).toBe('none')

    await user.agent.setDeclaration('following')
    const res3 = (await user.agent.getDeclaration()) as DeclarationResponse
    expect(res3.allowIncoming).toBe('following')

    // Re-read one more time to confirm the last value stuck
    const res4 = (await user.agent.getDeclaration()) as DeclarationResponse
    expect(res4.allowIncoming).toBe('following')
  })

  // -----------------------------------------------------------------------
  // 7. allowIncoming=none blocks new conversation creation
  // -----------------------------------------------------------------------

  it('allowIncoming=none blocks new conversation creation', async () => {
    const recipient = await createTestUser(network, 'decl-blk-rcpt.test')
    const sender = await createTestUser(network, 'decl-blk-sndr.test')

    // Recipient sets allowIncoming to 'none'
    await setAllowIncoming(recipient.agent, 'none')

    // Verify the declaration was persisted
    const decl =
      (await recipient.agent.getDeclaration()) as DeclarationResponse
    expect(decl.allowIncoming).toBe('none')

    // Sender tries to start a conversation -- should be rejected
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(/recipient has disabled incoming messages/)
  })

  // -----------------------------------------------------------------------
  // 8. allowIncoming=following blocks non-follower conversation creation
  // -----------------------------------------------------------------------

  it('allowIncoming=following blocks non-follower conversation creation', async () => {
    const recipient = await createTestUser(network, 'decl-nf-rcpt.test')
    const sender = await createTestUser(network, 'decl-nf-sndr.test')

    // Recipient sets allowIncoming to 'following'
    await setAllowIncoming(recipient.agent, 'following')

    // Verify the declaration was persisted
    const decl =
      (await recipient.agent.getDeclaration()) as DeclarationResponse
    expect(decl.allowIncoming).toBe('following')

    // Sender is NOT followed by recipient -- should be rejected
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(
      /recipient requires incoming messages to come from someone they follow/,
    )

    // Now establish a follow: recipient follows sender
    await createFollow(network, recipient, sender)

    // Sender should now be able to start a conversation
    const convoRes = (await sender.agent.getConvoForMembers([
      sender.did,
      recipient.did,
    ])) as ConvoForMembersResponse

    expect(convoRes.convo).toBeDefined()
    expect(convoRes.convo.id).toBeTruthy()
    expect(convoRes.convo.members).toHaveLength(2)
  })

  // -----------------------------------------------------------------------
  // 9. Changing allowIncoming affects future conversations only
  // -----------------------------------------------------------------------

  it('changing allowIncoming affects future conversations only', async () => {
    const userA = await createTestUser(network, 'decl-fut-a.test')
    const userB = await createTestUser(network, 'decl-fut-b.test')
    const userC = await createTestUser(network, 'decl-fut-c.test')

    // userB starts with allowIncoming='all' so conversation can be created
    await setAllowIncoming(userB.agent, 'all')

    // userA creates a conversation with userB
    const convoRes = (await userA.agent.getConvoForMembers([
      userA.did,
      userB.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    expect(convoId).toBeTruthy()

    // userB accepts the conversation
    await userB.agent.acceptConvo(convoId)

    // Send a message to confirm it works
    const msg1 = (await userA.agent.sendMessage(convoId, {
      text: 'Before privacy change',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    // Now userB changes their allowIncoming to 'none'
    await setAllowIncoming(userB.agent, 'none')

    // Verify the setting changed
    const decl = (await userB.agent.getDeclaration()) as DeclarationResponse
    expect(decl.allowIncoming).toBe('none')

    // userA can still send messages in the existing conversation
    const msg2 = (await userA.agent.sendMessage(convoId, {
      text: 'After privacy change to none',
    })) as MessageView
    expect(msg2.id).toBeTruthy()
    expect(msg2.text).toBe('After privacy change to none')

    // But a NEW user (userC) cannot start a conversation with userB
    await expect(
      userC.agent.getConvoForMembers([userC.did, userB.did]),
    ).rejects.toThrow(/recipient has disabled incoming messages/)
  })

  // -----------------------------------------------------------------------
  // 10. Existing accepted conversations are unaffected by declaration changes
  // -----------------------------------------------------------------------

  it('existing accepted conversations are unaffected by declaration changes', async () => {
    const userX = await createTestUser(network, 'decl-exist-x.test')
    const userY = await createTestUser(network, 'decl-exist-y.test')

    // userY starts with allowIncoming='all'
    await setAllowIncoming(userY.agent, 'all')

    // Create and accept a conversation
    const convoRes = (await userX.agent.getConvoForMembers([
      userX.did,
      userY.did,
    ])) as ConvoForMembersResponse
    const convoId = convoRes.convo.id
    await userY.agent.acceptConvo(convoId)

    // Exchange messages to establish the conversation
    const msg1 = (await userX.agent.sendMessage(convoId, {
      text: 'Hello from X',
    })) as MessageView
    expect(msg1.id).toBeTruthy()

    const msg2 = (await userY.agent.sendMessage(convoId, {
      text: 'Hello from Y',
    })) as MessageView
    expect(msg2.id).toBeTruthy()

    // userY changes allowIncoming to 'none'
    await setAllowIncoming(userY.agent, 'none')

    // Both users can still send messages in the existing conversation
    const msg3 = (await userX.agent.sendMessage(convoId, {
      text: 'X still messaging after none',
    })) as MessageView
    expect(msg3.id).toBeTruthy()
    expect(msg3.text).toBe('X still messaging after none')

    const msg4 = (await userY.agent.sendMessage(convoId, {
      text: 'Y still messaging after none',
    })) as MessageView
    expect(msg4.id).toBeTruthy()
    expect(msg4.text).toBe('Y still messaging after none')

    // Change to 'following' -- existing convo should still work
    await setAllowIncoming(userY.agent, 'following')

    const msg5 = (await userX.agent.sendMessage(convoId, {
      text: 'X still messaging after following',
    })) as MessageView
    expect(msg5.id).toBeTruthy()
    expect(msg5.text).toBe('X still messaging after following')

    const msg6 = (await userY.agent.sendMessage(convoId, {
      text: 'Y still messaging after following',
    })) as MessageView
    expect(msg6.id).toBeTruthy()
    expect(msg6.text).toBe('Y still messaging after following')

    // Change back to 'all' -- still works
    await setAllowIncoming(userY.agent, 'all')

    const msg7 = (await userX.agent.sendMessage(convoId, {
      text: 'X messaging after all',
    })) as MessageView
    expect(msg7.id).toBeTruthy()
    expect(msg7.text).toBe('X messaging after all')
  })
})
