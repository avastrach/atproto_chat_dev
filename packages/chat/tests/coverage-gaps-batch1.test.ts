import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  createTestNetwork,
  createTestUser,
  setAllowIncoming,
} from './_util'

// ---------------------------------------------------------------------------
// Type helpers for casting XRPC responses
// ---------------------------------------------------------------------------

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
  rev: string
  text: string
  sender: { did: string }
  sentAt: string
  $type?: string
  facets?: unknown[]
  embed?: unknown
}

interface GetMessagesResponse {
  messages: Array<MessageView>
  cursor?: string
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

// ===========================================================================
// SECTION A: Post-as-Embed Sharing (Gap #1)
// ===========================================================================

describe('post-as-embed sharing (coverage gap #1)', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'embed-alice.test')
    bob = await createTestUser(network, 'embed-bob.test')

    // Create a conversation and accept it
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)
  })

  afterAll(async () => {
    await network.close()
  })

  it('sendMessage with app.bsky.embed.record embed -- message is stored with embed', async () => {
    const postEmbed = {
      $type: 'app.bsky.embed.record',
      record: {
        uri: 'at://did:plc:fake/app.bsky.feed.post/abc123',
        cid: 'bafyreifake',
      },
    }

    const res = (await alice.agent.sendMessage(convoId, {
      text: 'Check this out',
      embed: postEmbed,
    })) as MessageView

    expect(res.id).toBeTruthy()
    expect(res.text).toBe('Check this out')
    expect(res.embed).toBeDefined()

    const embed = res.embed as {
      $type: string
      record: { uri: string; cid: string }
    }
    expect(embed.$type).toBe('app.bsky.embed.record')
    expect(embed.record.uri).toBe(
      'at://did:plc:fake/app.bsky.feed.post/abc123',
    )
    expect(embed.record.cid).toBe('bafyreifake')

    // Verify via getMessages that the embed persists
    const msgs = (await alice.agent.getMessages(
      convoId,
    )) as GetMessagesResponse
    const found = msgs.messages.find((m) => m.id === res.id)
    expect(found).toBeDefined()
    expect(found!.embed).toBeDefined()

    const storedEmbed = found!.embed as {
      $type: string
      record: { uri: string; cid: string }
    }
    expect(storedEmbed.$type).toBe('app.bsky.embed.record')
    expect(storedEmbed.record.uri).toBe(
      'at://did:plc:fake/app.bsky.feed.post/abc123',
    )
  })

  it('sendMessage with embed and empty text -- backend rejects empty text even with embed', async () => {
    // The backend validates text via validateMessageText which requires non-empty text.
    // Even when an embed is provided, empty text is rejected.
    const postEmbed = {
      $type: 'app.bsky.embed.record',
      record: {
        uri: 'at://did:plc:fake/app.bsky.feed.post/xyz789',
        cid: 'bafyreifake2',
      },
    }

    await expect(
      alice.agent.sendMessage(convoId, {
        text: '',
        embed: postEmbed,
      }),
    ).rejects.toThrow(/Message text is required/)
  })

  it('other user sees the embed when fetching messages', async () => {
    const postEmbed = {
      $type: 'app.bsky.embed.record',
      record: {
        uri: 'at://did:plc:fake/app.bsky.feed.post/shared456',
        cid: 'bafyreifakeshared',
      },
    }

    const sentMsg = (await alice.agent.sendMessage(convoId, {
      text: 'Sharing a post with you',
      embed: postEmbed,
    })) as MessageView

    // Bob fetches messages and should see the embed
    const bobMsgs = (await bob.agent.getMessages(
      convoId,
    )) as GetMessagesResponse

    const bobFound = bobMsgs.messages.find((m) => m.id === sentMsg.id)
    expect(bobFound).toBeDefined()
    expect(bobFound!.text).toBe('Sharing a post with you')
    expect(bobFound!.embed).toBeDefined()

    const bobEmbed = bobFound!.embed as {
      $type: string
      record: { uri: string; cid: string }
    }
    expect(bobEmbed.$type).toBe('app.bsky.embed.record')
    expect(bobEmbed.record.uri).toBe(
      'at://did:plc:fake/app.bsky.feed.post/shared456',
    )
    expect(bobEmbed.record.cid).toBe('bafyreifakeshared')
  })
})

// ===========================================================================
// SECTION B: Privacy allowIncoming "following" Mode (Gap #3)
// ===========================================================================

describe('privacy allowIncoming following -- additional coverage (gap #3)', () => {
  let network: TestNetwork

  beforeAll(async () => {
    network = await createTestNetwork()
  })

  afterAll(async () => {
    await network.close()
  })

  // -------------------------------------------------------------------------
  // Test: one-way follow where the INITIATOR follows the recipient,
  // but the RECIPIENT does NOT follow back. Since the check is whether
  // the recipient follows the caller, this should still block.
  // -------------------------------------------------------------------------

  it('allowIncoming=following -- one-way follow where initiator follows recipient still blocks', async () => {
    const recipient = await createTestUser(
      network,
      'fol-oneway-r.test',
      { skipAllowIncoming: true },
    )
    const sender = await createTestUser(network, 'fol-oneway-s.test')

    // Recipient sets allowIncoming to 'following'
    await recipient.agent.setDeclaration('following')

    // Sender follows recipient (but recipient does NOT follow sender)
    await createFollow(network, sender, recipient)

    // Sender tries to start chat -- should fail because recipient does NOT
    // follow sender. The privacy check is: does the RECIPIENT follow the CALLER?
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(
      /recipient requires incoming messages to come from someone they follow/,
    )
  })

  // -------------------------------------------------------------------------
  // Test: mutual follow -- both users follow each other. The recipient
  // has allowIncoming=following. Since recipient follows sender, this works.
  // This is different from existing tests where only recipient -> sender
  // follow exists; here both directions are present.
  // -------------------------------------------------------------------------

  it('allowIncoming=following -- mutual followers CAN start chat', async () => {
    const recipient = await createTestUser(
      network,
      'fol-mutual-r.test',
      { skipAllowIncoming: true },
    )
    const sender = await createTestUser(network, 'fol-mutual-s.test')

    // Recipient sets allowIncoming to 'following'
    await recipient.agent.setDeclaration('following')

    // Create mutual follows: recipient follows sender AND sender follows recipient
    await createFollow(network, recipient, sender)
    await createFollow(network, sender, recipient)

    // Sender starts chat -- should succeed because recipient follows sender
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

  // -------------------------------------------------------------------------
  // Test: non-follower cannot start chat via getConvoForMembers
  // Uses skipAllowIncoming + setDeclaration to avoid relying on defaults.
  // -------------------------------------------------------------------------

  it('allowIncoming=following -- non-follower cannot start chat (explicit setDeclaration)', async () => {
    const recipient = await createTestUser(
      network,
      'fol-nonfol-r.test',
      { skipAllowIncoming: true },
    )
    const sender = await createTestUser(network, 'fol-nonfol-s.test')

    // Explicitly set via setDeclaration (not relying on server default)
    await recipient.agent.setDeclaration('following')

    // No follow relationship exists in either direction
    // Sender tries to start chat -- should fail
    await expect(
      sender.agent.getConvoForMembers([sender.did, recipient.did]),
    ).rejects.toThrow(
      /recipient requires incoming messages to come from someone they follow/,
    )
  })
})

// ===========================================================================
// SECTION C: Message History Pagination (Gap #4)
// ===========================================================================

describe('message history pagination (coverage gap #4)', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let convoId: string
  const sentMessageIds: string[] = []

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'page-alice.test')
    bob = await createTestUser(network, 'page-bob.test')

    // Create and accept a conversation
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)

    // Send 10 messages sequentially to have deterministic ordering
    for (let i = 1; i <= 10; i++) {
      const msg = (await alice.agent.sendMessage(convoId, {
        text: `Pagination message ${i}`,
      })) as MessageView
      sentMessageIds.push(msg.id)
    }
  })

  afterAll(async () => {
    await network.close()
  })

  it('getMessages with limit returns exactly N messages', async () => {
    const res = (await alice.agent.getMessages(convoId, {
      limit: 3,
    })) as GetMessagesResponse

    expect(res.messages).toHaveLength(3)
    // Should also have a cursor since there are more messages
    expect(res.cursor).toBeTruthy()
  })

  it('getMessages cursor pagination loads older messages', async () => {
    // First page: get 3 newest messages
    const page1 = (await alice.agent.getMessages(convoId, {
      limit: 3,
    })) as GetMessagesResponse

    expect(page1.messages).toHaveLength(3)
    expect(page1.cursor).toBeTruthy()

    // Second page: use cursor to get next 3 messages
    const page2 = (await alice.agent.getMessages(convoId, {
      limit: 3,
      cursor: page1.cursor,
    })) as GetMessagesResponse

    expect(page2.messages).toHaveLength(3)

    // Pages should contain completely different messages
    const page1Ids = page1.messages.map((m) => m.id)
    const page2Ids = page2.messages.map((m) => m.id)

    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id)
    }

    // Messages are returned newest-first (descending by ID).
    // Page 1 should have newer messages than page 2.
    // Since TID-based IDs are sortable, the last ID on page 1
    // should be greater than the first ID on page 2.
    const lastPage1Id = page1Ids[page1Ids.length - 1]
    const firstPage2Id = page2Ids[0]
    expect(lastPage1Id > firstPage2Id).toBe(true)
  })

  it('getMessages pagination exhausts all messages', async () => {
    const allCollected: string[] = []
    let cursor: string | undefined
    let pages = 0

    // Paginate with limit=2 until cursor is exhausted
    do {
      const res = (await alice.agent.getMessages(convoId, {
        limit: 2,
        cursor,
      })) as GetMessagesResponse

      for (const msg of res.messages) {
        allCollected.push(msg.id)
      }

      cursor = res.cursor
      pages++

      // Safety: prevent infinite loop
      if (pages > 20) break
    } while (cursor)

    // We sent exactly 10 messages; all should be collected
    expect(allCollected).toHaveLength(10)

    // All message IDs should be unique (no duplicates across pages)
    const uniqueIds = new Set(allCollected)
    expect(uniqueIds.size).toBe(10)

    // Every sent message ID should appear in the collected results
    for (const sentId of sentMessageIds) {
      expect(allCollected).toContain(sentId)
    }
  })
})
