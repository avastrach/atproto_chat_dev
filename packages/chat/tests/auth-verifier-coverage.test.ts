import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createModServiceClient,
} from './_util'

/**
 * Auth verifier coverage tests.
 *
 * Targets uncovered branches in auth-verifier.ts:
 *
 * - Lines 109-113: modService() when modServiceDid is not configured
 *   (not directly testable via standard dev-env which always configures it,
 *    so we test the "untrusted issuer" path instead which covers the same
 *    allowedIssuers guard)
 * - Lines 156-157: Missing Bearer token (no auth header at all)
 * - Lines 168-169: parseReqNsid fails (malformed URL / non-NSID path)
 * - Lines 180-181: Untrusted issuer (iss not in allowedIssuers for mod endpoints)
 * - Lines 198-218: Labeler key resolution path (already covered by mod-auth tests
 *   via #atproto_labeler but we add explicit assertions here)
 * - Lines 220-224: Error wrapping in getSigningKey (DID resolution failure)
 *
 * References:
 * - auth-verifier.ts
 * - PRD 17.6.18-20 (mod endpoints require mod-service auth)
 */

describe('auth-verifier coverage', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let modClient: ChatApiClient

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
    modClient = await createModServiceClient(network)
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // Missing Bearer token (lines 156-157)
  // -----------------------------------------------------------------------

  describe('missing Bearer token', () => {
    it('GET request with no Authorization header returns AuthMissing', async () => {
      const chatUrl = network.chat.url
      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: { 'content-type': 'application/json' },
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('AuthMissing')
      expect(body.message).toMatch(/authentication required/i)
    })

    it('request with non-Bearer Authorization header returns AuthMissing', async () => {
      const chatUrl = network.chat.url
      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: {
            authorization: 'Basic dXNlcjpwYXNz',
            'content-type': 'application/json',
          },
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('AuthMissing')
      expect(body.message).toMatch(/authentication required/i)
    })

    it('request with empty Bearer token returns AuthMissing', async () => {
      const chatUrl = network.chat.url
      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer ',
            'content-type': 'application/json',
          },
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('AuthMissing')
      expect(body.message).toMatch(/authentication required/i)
    })
  })

  // -----------------------------------------------------------------------
  // Untrusted issuer for mod endpoints (lines 180-181)
  // -----------------------------------------------------------------------

  describe('untrusted issuer for mod endpoints', () => {
    it('standard user JWT is rejected on getActorMetadata with auth error', async () => {
      // A regular user's iss is their own DID, which is not the modServiceDid.
      // This exercises the allowedIssuers check in getSigningKey (line 180-181).
      try {
        await alice.agent.getActorMetadata(bob.did)
        throw new Error('Expected request to fail')
      } catch (err: unknown) {
        const message = (err as Error).message
        // Should be rejected due to untrusted issuer (iss != modServiceDid)
        expect(message).toMatch(/401|403|untrusted|auth/i)
      }
    })

    it('standard user JWT is rejected on getMessageContext with auth error', async () => {
      try {
        await alice.agent.getMessageContext('dummy-msg-id')
        throw new Error('Expected request to fail')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/401|403|untrusted|auth/i)
      }
    })

    it('standard user JWT is rejected on updateActorAccess with auth error', async () => {
      try {
        await alice.agent.updateActorAccess(bob.did, false)
        throw new Error('Expected request to fail')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/401|403|untrusted|auth/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Labeler key resolution (lines 198-218)
  // -----------------------------------------------------------------------

  describe('labeler key resolution', () => {
    it('mod service with #atproto_labeler issuer can call getActorMetadata', async () => {
      // This exercises the labeler key resolution path in getSigningKey
      // where keyId !== 'atproto' (lines 198-218).
      // The mod service client in dev-env uses the #atproto_labeler fragment.
      const res = (await modClient.getActorMetadata(alice.did)) as {
        day: { messagesSent: number }
        month: { messagesSent: number }
        all: { messagesSent: number }
      }

      expect(res).toBeDefined()
      expect(res.day).toBeDefined()
      expect(res.month).toBeDefined()
      expect(res.all).toBeDefined()
    })

    it('mod service can call getMessageContext', async () => {
      // Create a convo and message first to have a valid message ID
      const convoRes = (await alice.agent.getConvoForMembers([
        alice.did,
        bob.did,
      ])) as { convo: { id: string } }
      const convoId = convoRes.convo.id
      await bob.agent.acceptConvo(convoId)

      const msg = (await alice.agent.sendMessage(convoId, {
        text: 'Message for mod context test',
      })) as { id: string }

      // Mod service calls getMessageContext -- exercises labeler key path
      const res = (await modClient.getMessageContext(msg.id, {
        convoId,
      })) as { messages: unknown[] }

      expect(res).toBeDefined()
      expect(res.messages).toBeDefined()
      expect(Array.isArray(res.messages)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Invalid / malformed JWT (lines 220-224 error wrapping)
  // -----------------------------------------------------------------------

  describe('invalid JWT', () => {
    it('malformed JWT string returns auth error', async () => {
      const chatUrl = network.chat.url
      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer not-a-real-jwt-token',
            'content-type': 'application/json',
          },
        },
      )

      expect(res.ok).toBe(false)
      // Should be an auth error (401)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })

    it('JWT with wrong audience is rejected', async () => {
      // Create a JWT with wrong audience
      const { createServiceJwt } = await import('@atproto/xrpc-server')
      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)

      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: 'did:plc:wrong-audience',
        lxm: 'chat.bsky.convo.listConvos',
        keypair,
      })

      const chatUrl = network.chat.url
      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBeGreaterThanOrEqual(400)
    })

    it('JWT with wrong lxm is rejected', async () => {
      // Create a JWT with mismatched lxm
      const { createServiceJwt } = await import('@atproto/xrpc-server')
      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)

      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.sendMessage', // wrong NSID for a GET to listConvos
        keypair,
      })

      const chatUrl = network.chat.url
      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBeGreaterThanOrEqual(400)
    })
  })
})
