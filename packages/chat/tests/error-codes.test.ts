import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

/**
 * Error code compliance E2E tests.
 *
 * Verifies that the chat service returns proper, spec-compliant error
 * messages and HTTP status codes for various failure scenarios:
 *
 * - Invalid / non-existent convo ID
 * - Non-member accessing a conversation
 * - Empty message text
 * - Message text exceeding grapheme / byte limits
 * - Invalid reaction value (not exactly 1 grapheme)
 * - Missing required parameters
 * - Unauthenticated requests (no Authorization header)
 *
 * References:
 * - auth-verifier.ts (AuthRequiredError, AuthMissing)
 * - message.ts (validateMessageText, validateReactionValue, ReactionInvalidValue)
 * - conversation.ts (Convo not found)
 * - Endpoint handlers in api/chat/bsky/convo/ (InvalidRequestError for missing params)
 */

// Type helpers
interface ConvoView {
  id: string
  members: Array<{ did: string }>
}

interface MessageView {
  id: string
  text: string
  sender: { did: string }
}

interface ConvoForMembersResponse {
  convo: ConvoView
}

describe('error code compliance', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser
  let convoId: string
  let messageId: string

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
    carol = await createTestUser(network, 'carol.test')

    // Create a conversation between alice and bob
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as ConvoForMembersResponse
    convoId = convoRes.convo.id

    // Accept the convo so both can send messages
    await bob.agent.acceptConvo(convoId)

    // Send a message for reaction tests
    const msg = (await alice.agent.sendMessage(convoId, {
      text: 'Message for error testing',
    })) as MessageView
    messageId = msg.id
  })

  afterAll(async () => {
    await network.close()
  })

  // -----------------------------------------------------------------------
  // Invalid / non-existent convo ID
  // -----------------------------------------------------------------------

  describe('invalid convoId', () => {
    it('invalid convoId returns proper error', async () => {
      // A convoId that does not exist should result in "Convo not found"
      // from the conversation service's membership check.
      try {
        await alice.agent.getConvo('nonexistent-convo-id-12345')
        // If we get here, the endpoint did not throw -- fail the test
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        // The ChatApiClient wraps the HTTP error: "Chat API GET ... failed (400): ..."
        // The response body should contain "Convo not found"
        expect(message).toMatch(/Convo not found/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Non-member accessing a conversation
  // -----------------------------------------------------------------------

  describe('non-member access', () => {
    it('non-member accessing convo returns proper error', async () => {
      // Carol is not a member of the alice-bob conversation.
      // Attempting to fetch it should return "Convo not found".
      try {
        await carol.agent.getConvo(convoId)
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/Convo not found/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Empty message text
  // -----------------------------------------------------------------------

  describe('empty message text', () => {
    it('empty message text returns proper error', async () => {
      // The message service's validateMessageText() rejects empty strings
      // with "Message text is required".
      try {
        await alice.agent.sendMessage(convoId, { text: '' })
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/Message text is required/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Exceeding grapheme limit
  // -----------------------------------------------------------------------

  describe('exceeding grapheme limit', () => {
    it('exceeding grapheme limit returns proper error', async () => {
      // MAX_TEXT_GRAPHEMES = 1000. A string of 1001 ASCII characters
      // exceeds the grapheme limit.
      const longText = 'a'.repeat(1001)

      try {
        await alice.agent.sendMessage(convoId, { text: longText })
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/exceeds maximum.*1000 graphemes/i)
      }
    })

    it('exceeding byte limit returns proper error', async () => {
      // MAX_TEXT_BYTES = 10000. Using multi-byte emoji characters that
      // are each 4 bytes (and 1 grapheme) to exceed the byte limit
      // while also exceeding the grapheme limit.
      // 2501 emoji = 10004 bytes > 10000
      const massiveText = '\u{1F600}'.repeat(2501)

      try {
        await alice.agent.sendMessage(convoId, { text: massiveText })
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        // Should hit either the byte or grapheme limit
        expect(message).toMatch(/exceeds maximum/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Invalid reaction value
  // -----------------------------------------------------------------------

  describe('invalid reaction value', () => {
    it('invalid reaction value returns proper error code', async () => {
      // The validateReactionValue() function requires exactly 1 grapheme.
      // A multi-character string like "hi" (2 graphemes) should be rejected
      // with error name "ReactionInvalidValue".
      try {
        await alice.agent.addReaction(convoId, messageId, 'hi')
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/Reaction must be exactly 1 emoji|ReactionInvalidValue/i)
      }
    })

    it('empty reaction value returns proper error code', async () => {
      try {
        await alice.agent.addReaction(convoId, messageId, '')
        throw new Error('Expected request to fail but it succeeded')
      } catch (err: unknown) {
        const message = (err as Error).message
        expect(message).toMatch(/Reaction value is required|ReactionInvalidValue|value is required/i)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Missing required parameters return InvalidRequest
  // -----------------------------------------------------------------------

  describe('missing required params return InvalidRequest', () => {
    it('getConvo without convoId returns error', async () => {
      // Directly call the XRPC endpoint without the required convoId param.
      // The ChatApiClient.getConvo() always passes convoId, so we make a
      // raw HTTP request to test the endpoint handler's param validation.
      const chatUrl = network.chat.url
      const { createServiceJwt } = await import('@atproto/xrpc-server')

      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)
      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.getConvo',
        keypair,
      })

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.getConvo`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
        },
      )

      // Should return a 400-level error for missing convoId
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.error).toBe('InvalidRequest')
      expect(body.message).toMatch(/convoId.*required/i)
    })

    it('sendMessage without message body returns error', async () => {
      const chatUrl = network.chat.url
      const { createServiceJwt } = await import('@atproto/xrpc-server')

      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)
      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.sendMessage',
        keypair,
      })

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.sendMessage`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ convoId }),
          // Missing "message" field
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.error).toBe('InvalidRequest')
      expect(body.message).toMatch(/message.*required/i)
    })

    it('addReaction without value returns error', async () => {
      const chatUrl = network.chat.url
      const { createServiceJwt } = await import('@atproto/xrpc-server')

      const keypair = await network.pds.ctx.actorStore.keypair(alice.did)
      const jwt = await createServiceJwt({
        iss: alice.did,
        aud: network.chat.serverDid,
        lxm: 'chat.bsky.convo.addReaction',
        keypair,
      })

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.addReaction`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            convoId,
            messageId,
            // Missing "value" field
          }),
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.error).toBe('InvalidRequest')
      expect(body.message).toMatch(/value.*required/i)
    })
  })

  // -----------------------------------------------------------------------
  // Pagination bounds (per errata E3: limit clamped to 1-100)
  // -----------------------------------------------------------------------

  describe('pagination bounds', () => {
    it('listConvos with limit=0 clamps to 1 (returns at most 1 result)', async () => {
      // Per errata E3, limit is clamped to range 1-100.
      // limit=0 should be clamped to 1 (not error).
      const res = (await alice.agent.listConvos({ limit: 0 })) as {
        convos: ConvoView[]
      }
      // Should return at most 1 convo (clamped to min=1)
      expect(res.convos.length).toBeLessThanOrEqual(1)
    })

    it('listConvos with limit=101 clamps to 100 (does not error)', async () => {
      // limit=101 should be clamped to 100 (not error)
      const res = (await alice.agent.listConvos({ limit: 101 })) as {
        convos: ConvoView[]
      }
      expect(res.convos).toBeDefined()
      expect(res.convos.length).toBeLessThanOrEqual(100)
    })

    it('getMessages with limit=0 clamps to 1 (returns at most 1 result)', async () => {
      // Per errata E3, limit is clamped to range 1-100.
      const res = (await alice.agent.getMessages(convoId, {
        limit: 0,
      })) as {
        messages: unknown[]
      }
      expect(res.messages.length).toBeLessThanOrEqual(1)
    })

    it('getMessages with limit=101 clamps to 100 (does not error)', async () => {
      const res = (await alice.agent.getMessages(convoId, {
        limit: 101,
      })) as {
        messages: unknown[]
      }
      expect(res.messages).toBeDefined()
      expect(res.messages.length).toBeLessThanOrEqual(100)
    })
  })

  // -----------------------------------------------------------------------
  // Unauthenticated requests return auth error
  // -----------------------------------------------------------------------

  describe('unauthenticated requests', () => {
    it('unauthenticated requests return auth error', async () => {
      // Make a raw HTTP request without any Authorization header.
      // The AuthVerifier.standard() should throw AuthRequiredError
      // with error name "AuthMissing".
      const chatUrl = network.chat.url

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.listConvos`,
        {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
          },
          // No Authorization header
        },
      )

      expect(res.ok).toBe(false)
      // Auth errors typically return 401
      expect(res.status).toBe(401)

      const body = await res.json()
      expect(body.error).toBe('AuthMissing')
      expect(body.message).toMatch(/authentication required/i)
    })

    it('unauthenticated POST request returns auth error', async () => {
      const chatUrl = network.chat.url

      const res = await fetch(
        `${chatUrl}/xrpc/chat.bsky.convo.sendMessage`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            convoId: 'some-convo-id',
            message: { text: 'hello' },
          }),
          // No Authorization header
        },
      )

      expect(res.ok).toBe(false)
      expect(res.status).toBe(401)

      const body = await res.json()
      expect(body.error).toBe('AuthMissing')
      expect(body.message).toMatch(/authentication required/i)
    })
  })
})
