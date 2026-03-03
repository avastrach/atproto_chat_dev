import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  createBlock,
  createTestNetwork,
  createTestUser,
} from './_util'

/**
 * ChatRepoSubscription firehose handler tests.
 *
 * These tests verify that the firehose subscription correctly syncs
 * repo writes into the chat service's local database tables:
 *
 *   - chat.bsky.actor.declaration  ->  actor_setting table
 *   - app.bsky.actor.profile       ->  profile table
 *   - app.bsky.graph.block         ->  log output (observability only)
 *
 * The approach:
 *   1. Write records to the PDS via com.atproto.repo.putRecord / deleteRecord.
 *   2. Call network.processAll() to flush the firehose events through the subscription.
 *   3. Query the chat DB directly to verify the data was synced correctly.
 */

// ---------------------------------------------------------------------------
// Helpers for writing records directly on the PDS
// ---------------------------------------------------------------------------

/** Create or update a chat.bsky.actor.declaration record on the PDS. */
async function putDeclaration(
  network: TestNetwork,
  user: TestUser,
  allowIncoming: string,
): Promise<void> {
  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.putRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${user.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: user.did,
        collection: 'chat.bsky.actor.declaration',
        rkey: 'self',
        record: {
          $type: 'chat.bsky.actor.declaration',
          allowIncoming,
        },
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`putDeclaration failed (${res.status}): ${body}`)
  }
}

/** Delete the chat.bsky.actor.declaration record from the PDS. */
async function deleteDeclaration(
  network: TestNetwork,
  user: TestUser,
): Promise<void> {
  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.deleteRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${user.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: user.did,
        collection: 'chat.bsky.actor.declaration',
        rkey: 'self',
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`deleteDeclaration failed (${res.status}): ${body}`)
  }
}

/** Create or update an app.bsky.actor.profile record on the PDS.
 *  Note: avatar must be omitted or be a valid blob ref; string URLs are rejected. */
async function putProfile(
  network: TestNetwork,
  user: TestUser,
  profile: { displayName?: string; description?: string },
): Promise<void> {
  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.putRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${user.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: user.did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: {
          $type: 'app.bsky.actor.profile',
          ...profile,
        },
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`putProfile failed (${res.status}): ${body}`)
  }
}

/** Delete the app.bsky.actor.profile record from the PDS. */
async function deleteProfile(
  network: TestNetwork,
  user: TestUser,
): Promise<void> {
  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.deleteRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${user.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: user.did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`deleteProfile failed (${res.status}): ${body}`)
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ChatRepoSubscription firehose handlers', () => {
  let network: TestNetwork

  beforeAll(async () => {
    network = await createTestNetwork()
  })

  afterAll(async () => {
    if (network) {
      await network.close()
    }
  })

  /** Helper: get the chat service database handle. */
  function chatDb() {
    return network.chat.ctx.db.db
  }

  // =========================================================================
  // Declaration subscriber: chat.bsky.actor.declaration -> actor_setting
  // =========================================================================

  describe('declaration subscriber', () => {
    it('create declaration -> actor_setting row appears with correct allowIncoming', async () => {
      // Create a user WITHOUT auto-setting allowIncoming so there is no prior row
      const user = await createTestUser(network, 'sd-create.test', {
        skipAllowIncoming: true,
      })

      // Verify no actor_setting row exists yet for this user
      const before = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()
      expect(before).toBeUndefined()

      // Write a declaration record to the PDS repo (firehose path)
      await putDeclaration(network, user, 'all')
      // Flush firehose events through the chat subscription
      await network.processAll()

      // Verify the actor_setting row was created
      const after = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()

      expect(after).toBeDefined()
      expect(after!.did).toBe(user.did)
      expect(after!.allowIncoming).toBe('all')
      expect(after!.updatedAt).toBeTruthy()
    })

    it('update declaration -> actor_setting row updated', async () => {
      const user = await createTestUser(network, 'sd-update.test', {
        skipAllowIncoming: true,
      })

      // Create initial declaration via firehose
      await putDeclaration(network, user, 'all')
      await network.processAll()

      const initial = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()
      expect(initial).toBeDefined()
      expect(initial!.allowIncoming).toBe('all')

      // Update the declaration to 'none' via firehose
      await putDeclaration(network, user, 'none')
      await network.processAll()

      const updated = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()

      expect(updated).toBeDefined()
      expect(updated!.allowIncoming).toBe('none')
      // updatedAt should have been refreshed
      expect(updated!.updatedAt).toBeTruthy()
    })

    it('delete declaration -> actor_setting row removed, privacy defaults to following', async () => {
      const user = await createTestUser(network, 'sd-delete.test', {
        skipAllowIncoming: true,
      })

      // Create a declaration first via firehose
      await putDeclaration(network, user, 'all')
      await network.processAll()

      const before = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()
      expect(before).toBeDefined()
      expect(before!.allowIncoming).toBe('all')

      // Delete the declaration record via PDS
      await deleteDeclaration(network, user)
      await network.processAll()

      // The row should be gone
      const after = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()
      expect(after).toBeUndefined()

      // Verify that the API layer now returns the default 'following'
      const decl = (await user.agent.getDeclaration()) as {
        allowIncoming: string
      }
      expect(decl.allowIncoming).toBe('following')
    })
  })

  // =========================================================================
  // Profile subscriber: app.bsky.actor.profile -> profile
  // =========================================================================

  describe('profile subscriber', () => {
    it('create profile -> profile row appears with displayName', async () => {
      const user = await createTestUser(network, 'sp-create.test', {
        skipAllowIncoming: true,
      })

      // Write a profile record to the PDS repo (firehose path).
      // Note: avatar must be a blob ref so we only set displayName.
      await putProfile(network, user, {
        displayName: 'Test User',
        description: 'A test user for subscription tests',
      })
      await network.processAll()

      // Verify the profile row was created in the chat DB
      const row = await chatDb()
        .selectFrom('profile')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()

      expect(row).toBeDefined()
      expect(row!.did).toBe(user.did)
      expect(row!.displayName).toBe('Test User')
      // avatar should be null since we did not upload a blob
      expect(row!.avatar).toBeNull()
      expect(row!.updatedAt).toBeTruthy()
    })

    it('update profile -> profile row updated, chatDisabled NOT touched', async () => {
      const user = await createTestUser(network, 'sp-update.test', {
        skipAllowIncoming: true,
      })

      // Create initial profile via firehose
      await putProfile(network, user, {
        displayName: 'Original Name',
      })
      await network.processAll()

      const initial = await chatDb()
        .selectFrom('profile')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()
      expect(initial).toBeDefined()
      expect(initial!.displayName).toBe('Original Name')
      // chatDisabled should default to false
      expect(initial!.chatDisabled).toBe(false)

      // Update the profile via firehose
      await putProfile(network, user, {
        displayName: 'Updated Name',
      })
      await network.processAll()

      const updated = await chatDb()
        .selectFrom('profile')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()

      expect(updated).toBeDefined()
      expect(updated!.displayName).toBe('Updated Name')
      // chatDisabled should NOT have been changed by the profile subscription handler
      expect(updated!.chatDisabled).toBe(false)
    })

    it('delete profile -> displayName and avatar nullified, row retained', async () => {
      const user = await createTestUser(network, 'sp-delete.test', {
        skipAllowIncoming: true,
      })

      // Create a profile first via firehose
      await putProfile(network, user, {
        displayName: 'Soon To Be Deleted',
      })
      await network.processAll()

      const before = await chatDb()
        .selectFrom('profile')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()
      expect(before).toBeDefined()
      expect(before!.displayName).toBe('Soon To Be Deleted')

      // Delete the profile record via PDS
      await deleteProfile(network, user)
      await network.processAll()

      // The row should still exist but displayName and avatar should be null
      const after = await chatDb()
        .selectFrom('profile')
        .where('did', '=', user.did)
        .selectAll()
        .executeTakeFirst()

      expect(after).toBeDefined()
      expect(after!.did).toBe(user.did)
      expect(after!.displayName).toBeNull()
      expect(after!.avatar).toBeNull()
      // chatDisabled should remain untouched
      expect(after!.chatDisabled).toBe(false)
    })
  })

  // =========================================================================
  // Block subscriber: app.bsky.graph.block -> log (minimal)
  // =========================================================================

  describe('block subscriber', () => {
    it('create block -> event is processed without error', async () => {
      const alice = await createTestUser(network, 'sb-alice.test')
      const bob = await createTestUser(network, 'sb-bob.test')

      // Create a block record -- this goes through the firehose subscription.
      // The block handler currently only logs; we verify no error is thrown
      // and the network processes successfully.
      const blockRef = await createBlock(network, alice, bob)
      expect(blockRef.uri).toBeTruthy()
      expect(blockRef.cid).toBeTruthy()

      // processAll() already called by createBlock helper.
      // If the block handler threw an error, createBlock + processAll would
      // propagate it. Reaching here means it was processed cleanly.
    })
  })

  // =========================================================================
  // Integration: full flow - allowIncoming via repo write -> privacy check
  // =========================================================================

  describe('integration', () => {
    it('full flow: set allowIncoming=all via repo write -> privacy check allows chat', async () => {
      // Create two users with default privacy (following)
      const sender = await createTestUser(network, 'si-sndr.test', {
        skipAllowIncoming: true,
      })
      const recipient = await createTestUser(network, 'si-rcpt.test', {
        skipAllowIncoming: true,
      })

      // Sender sets allowIncoming='all' via firehose so they can receive
      await putDeclaration(network, sender, 'all')
      await network.processAll()

      // Recipient is still at default ('following'), so sender cannot initiate
      // a convo with recipient (sender is not followed by recipient).
      // Verify the declaration was synced to the DB.
      const recipientSetting = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', recipient.did)
        .selectAll()
        .executeTakeFirst()
      // No actor_setting row means default 'following' applies
      expect(recipientSetting).toBeUndefined()

      // Now the recipient writes a declaration via PDS repo (firehose path)
      // setting allowIncoming='all'
      await putDeclaration(network, recipient, 'all')
      await network.processAll()

      // Verify the DB was updated via firehose
      const updatedSetting = await chatDb()
        .selectFrom('actor_setting')
        .where('did', '=', recipient.did)
        .selectAll()
        .executeTakeFirst()
      expect(updatedSetting).toBeDefined()
      expect(updatedSetting!.allowIncoming).toBe('all')

      // Now sender should be able to start a conversation with recipient
      const convoRes = (await sender.agent.getConvoForMembers([
        sender.did,
        recipient.did,
      ])) as { convo: { id: string; members: Array<{ did: string }> } }

      expect(convoRes.convo).toBeDefined()
      expect(convoRes.convo.id).toBeTruthy()
      expect(convoRes.convo.members).toHaveLength(2)
    })
  })
})
