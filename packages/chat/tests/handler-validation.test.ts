import { TestNetwork } from '@atproto/dev-env'
import { createServiceJwt } from '@atproto/xrpc-server'
import {
  TestUser,
  createTestNetwork,
  createTestUser,
  createModServiceClient,
  ChatApiClient,
} from './_util'

/**
 * Handler-level input validation tests via raw HTTP.
 *
 * The ChatApiClient always sends well-formed requests, so the handler-level
 * validation branches (missing convoId, missing messageId, missing value, etc.)
 * are only reachable via raw HTTP. These tests cover the validation code in
 * each XRPC handler file.
 *
 * Targets uncovered branches in:
 * - removeReaction.ts (lines 13-14, 16-17, 19-20)
 * - addReaction.ts (lines 13-14, 16-17, 19-20)
 * - sendMessage.ts (lines 13-14, 16-17)
 * - deleteMessageForSelf.ts (lines 13-14, 16-17)
 * - getConvo.ts (lines 12-14)
 * - getMessages.ts (lines 13-14)
 * - getConvoForMembers.ts (lines 15-21)
 * - sendMessageBatch.ts (lines 13, 20-21, 23-25)
 * - updateRead.ts (lines 13-14)
 * - listConvos.ts (parsing paths)
 * - getLog.ts (parsing paths)
 * - updateAllRead.ts (parsing paths)
 */

describe('handler-level validation via raw HTTP', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let chatUrl: string
  let convoId: string

  /**
   * Helper: create a service-auth JWT for a given user and NSID.
   */
  async function createJwt(user: TestUser, nsid: string): Promise<string> {
    const keypair = await network.pds.ctx.actorStore.keypair(user.did)
    return createServiceJwt({
      iss: user.did,
      aud: network.chat.serverDid,
      lxm: nsid,
      keypair,
    })
  }

  /**
   * Helper: POST to a chat XRPC endpoint with a raw body.
   */
  async function rawPost(
    nsid: string,
    jwt: string,
    body: unknown,
  ): Promise<Response> {
    return fetch(`${chatUrl}/xrpc/${nsid}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  /**
   * Helper: GET a chat XRPC endpoint with optional query params.
   */
  async function rawGet(
    nsid: string,
    jwt: string,
    params?: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(`/xrpc/${nsid}`, chatUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
    }
    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
    })
  }

  beforeAll(async () => {
    network = await createTestNetwork()
    chatUrl = network.chat.url
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')

    // Create a conversation for tests
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as { convo: { id: string } }
    convoId = convoRes.convo.id
    await bob.agent.acceptConvo(convoId)
  })

  afterAll(async () => {
    if (network) await network.close()
  }, 30000)

  // -----------------------------------------------------------------------
  // addReaction handler validation
  // -----------------------------------------------------------------------

  describe('addReaction handler validation', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.addReaction')
      const res = await rawPost('chat.bsky.convo.addReaction', jwt, {
        messageId: 'some-id',
        value: '\u2764\uFE0F',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })

    it('rejects missing messageId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.addReaction')
      const res = await rawPost('chat.bsky.convo.addReaction', jwt, {
        convoId,
        value: '\u2764\uFE0F',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('messageId')
    })

    it('rejects missing value', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.addReaction')
      const res = await rawPost('chat.bsky.convo.addReaction', jwt, {
        convoId,
        messageId: 'some-id',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('value')
    })
  })

  // -----------------------------------------------------------------------
  // removeReaction handler validation
  // -----------------------------------------------------------------------

  describe('removeReaction handler validation', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.removeReaction')
      const res = await rawPost('chat.bsky.convo.removeReaction', jwt, {
        messageId: 'some-id',
        value: '\u2764\uFE0F',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })

    it('rejects missing messageId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.removeReaction')
      const res = await rawPost('chat.bsky.convo.removeReaction', jwt, {
        convoId,
        value: '\u2764\uFE0F',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('messageId')
    })

    it('rejects missing value', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.removeReaction')
      const res = await rawPost('chat.bsky.convo.removeReaction', jwt, {
        convoId,
        messageId: 'some-id',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('value')
    })
  })

  // -----------------------------------------------------------------------
  // sendMessage handler validation
  // -----------------------------------------------------------------------

  describe('sendMessage handler validation', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.sendMessage')
      const res = await rawPost('chat.bsky.convo.sendMessage', jwt, {
        message: { text: 'hello' },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })

    it('rejects missing message', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.sendMessage')
      const res = await rawPost('chat.bsky.convo.sendMessage', jwt, {
        convoId,
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('message with text')
    })

    it('rejects message without text property', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.sendMessage')
      const res = await rawPost('chat.bsky.convo.sendMessage', jwt, {
        convoId,
        message: { facets: [] },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('message with text')
    })
  })

  // -----------------------------------------------------------------------
  // deleteMessageForSelf handler validation
  // -----------------------------------------------------------------------

  describe('deleteMessageForSelf handler validation', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(
        alice,
        'chat.bsky.convo.deleteMessageForSelf',
      )
      const res = await rawPost(
        'chat.bsky.convo.deleteMessageForSelf',
        jwt,
        { messageId: 'some-id' },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })

    it('rejects missing messageId', async () => {
      const jwt = await createJwt(
        alice,
        'chat.bsky.convo.deleteMessageForSelf',
      )
      const res = await rawPost(
        'chat.bsky.convo.deleteMessageForSelf',
        jwt,
        { convoId },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('messageId')
    })
  })

  // -----------------------------------------------------------------------
  // sendMessageBatch handler validation
  // -----------------------------------------------------------------------

  describe('sendMessageBatch handler validation', () => {
    it('rejects missing items array', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.sendMessageBatch')
      const res = await rawPost('chat.bsky.convo.sendMessageBatch', jwt, {})
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('items array')
    })

    it('rejects non-array items', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.sendMessageBatch')
      const res = await rawPost('chat.bsky.convo.sendMessageBatch', jwt, {
        items: 'not-array',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('items array')
    })
  })

  // -----------------------------------------------------------------------
  // getConvo handler validation
  // -----------------------------------------------------------------------

  describe('getConvo handler validation', () => {
    it('rejects missing convoId query param', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.getConvo')
      const res = await rawGet('chat.bsky.convo.getConvo', jwt, {})
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })
  })

  // -----------------------------------------------------------------------
  // getMessages handler validation
  // -----------------------------------------------------------------------

  describe('getMessages handler validation', () => {
    it('rejects missing convoId query param', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.getMessages')
      const res = await rawGet('chat.bsky.convo.getMessages', jwt, {})
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })

    it('parses limit and cursor query params correctly', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.getMessages')
      const res = await rawGet('chat.bsky.convo.getMessages', jwt, {
        convoId,
        limit: '10',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.messages).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // getConvoForMembers handler validation
  // -----------------------------------------------------------------------

  describe('getConvoForMembers handler validation', () => {
    it('rejects missing members param', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.getConvoForMembers')
      const res = await rawGet('chat.bsky.convo.getConvoForMembers', jwt, {})
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('members')
    })

    it('accepts single member as string (not array)', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.getConvoForMembers')
      // Single query param value comes as string, not array
      const res = await rawGet('chat.bsky.convo.getConvoForMembers', jwt, {
        members: bob.did,
      })
      expect(res.status).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // updateRead handler validation
  // -----------------------------------------------------------------------

  describe('updateRead handler validation', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.updateRead')
      const res = await rawPost('chat.bsky.convo.updateRead', jwt, {})
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.message).toContain('convoId')
    })

    it('accepts updateRead without messageId (reads to latest)', async () => {
      // First send a message so there's something to read
      await alice.agent.sendMessage(convoId, { text: 'For updateRead test' })

      const jwt = await createJwt(bob, 'chat.bsky.convo.updateRead')
      const res = await rawPost('chat.bsky.convo.updateRead', jwt, {
        convoId,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.convo).toBeDefined()
      expect(body.convo.unreadCount).toBe(0)
    })

    it('accepts updateRead with specific messageId', async () => {
      // Send messages
      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Specific read marker',
      })) as { id: string }

      const jwt = await createJwt(bob, 'chat.bsky.convo.updateRead')
      const res = await rawPost('chat.bsky.convo.updateRead', jwt, {
        convoId,
        messageId: msg.id,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.convo).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // updateAllRead handler paths
  // -----------------------------------------------------------------------

  describe('updateAllRead handler', () => {
    it('accepts empty body (marks all as read)', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.updateAllRead')
      const res = await rawPost('chat.bsky.convo.updateAllRead', jwt, {})
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.updatedCount).toBeDefined()
      expect(typeof body.updatedCount).toBe('number')
    })

    it('accepts status filter param', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.updateAllRead')
      const res = await rawPost('chat.bsky.convo.updateAllRead', jwt, {
        status: 'accepted',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.updatedCount).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // getLog handler cursor parsing
  // -----------------------------------------------------------------------

  describe('getLog handler', () => {
    it('returns logs without cursor', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.getLog')
      const res = await rawGet('chat.bsky.convo.getLog', jwt, {})
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.logs).toBeDefined()
      expect(Array.isArray(body.logs)).toBe(true)
    })

    it('returns logs with cursor', async () => {
      // First get logs to find a cursor
      const jwt = await createJwt(alice, 'chat.bsky.convo.getLog')
      const first = await rawGet('chat.bsky.convo.getLog', jwt, {})
      const firstBody = await first.json()

      if (firstBody.logs.length > 0) {
        const cursor = firstBody.logs[0].rev
        const res = await rawGet('chat.bsky.convo.getLog', jwt, { cursor })
        expect(res.status).toBe(200)
      }
    })
  })

  // -----------------------------------------------------------------------
  // listConvos handler paths
  // -----------------------------------------------------------------------

  describe('listConvos handler', () => {
    it('parses readState=unread filter', async () => {
      // Send a message so bob has unread
      await alice.agent.sendMessage(convoId, { text: 'Unread filter test' })

      const res = (await bob.agent.listConvos({
        readState: 'unread',
      })) as { convos: Array<{ id: string; unreadCount: number }> }

      expect(res.convos).toBeDefined()
      // At least the convo with alice should show up as unread
      expect(res.convos.length).toBeGreaterThanOrEqual(1)
      for (const c of res.convos) {
        expect(c.unreadCount).toBeGreaterThan(0)
      }
    })

    it('parses limit query param', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.listConvos')
      const res = await rawGet('chat.bsky.convo.listConvos', jwt, {
        limit: '1',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.convos.length).toBeLessThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // getConvoAvailability handler paths
  // -----------------------------------------------------------------------

  describe('getConvoAvailability handler', () => {
    it('accepts single member as string', async () => {
      const jwt = await createJwt(
        alice,
        'chat.bsky.convo.getConvoAvailability',
      )
      const res = await rawGet('chat.bsky.convo.getConvoAvailability', jwt, {
        members: bob.did,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.canChat).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // acceptConvo handler validation
  // -----------------------------------------------------------------------

  describe('acceptConvo handler', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.acceptConvo')
      const res = await rawPost('chat.bsky.convo.acceptConvo', jwt, {})
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // leaveConvo handler validation
  // -----------------------------------------------------------------------

  describe('leaveConvo handler', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.leaveConvo')
      const res = await rawPost('chat.bsky.convo.leaveConvo', jwt, {})
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // muteConvo/unmuteConvo handler validation
  // -----------------------------------------------------------------------

  describe('muteConvo handler', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.muteConvo')
      const res = await rawPost('chat.bsky.convo.muteConvo', jwt, {})
      expect(res.status).toBe(400)
    })
  })

  describe('unmuteConvo handler', () => {
    it('rejects missing convoId', async () => {
      const jwt = await createJwt(alice, 'chat.bsky.convo.unmuteConvo')
      const res = await rawPost('chat.bsky.convo.unmuteConvo', jwt, {})
      expect(res.status).toBe(400)
    })
  })
})
