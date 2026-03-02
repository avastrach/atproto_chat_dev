import { TestNetwork } from '@atproto/dev-env'
import { createTestNetwork } from './_util'

/**
 * Basic routes E2E tests.
 *
 * Covers the non-XRPC HTTP routes defined in basic-routes.ts:
 * - GET / (root landing page)
 * - GET /robots.txt (crawler directives)
 * - GET /xrpc/_health (health check with version info)
 *
 * These routes do not require authentication and are accessed via raw
 * HTTP fetch against the chat server URL.
 *
 * References:
 * - basic-routes.ts (createRouter)
 */

describe('basic routes', () => {
  let network: TestNetwork
  let chatUrl: string

  beforeAll(async () => {
    network = await createTestNetwork()
    chatUrl = network.chat.url
  })

  afterAll(async () => {
    if (network) {
      try {
        await network.close()
      } catch {
        // Coverage mode may cause close to take long; swallow
      }
    }
  }, 300000)

  // -----------------------------------------------------------------------
  // GET / -- root landing page
  // -----------------------------------------------------------------------

  describe('GET /', () => {
    it('returns 200 with text containing "AT Protocol Chat"', async () => {
      const res = await fetch(`${chatUrl}/`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')

      const body = await res.text()
      expect(body).toContain('AT Protocol Chat')
    })
  })

  // -----------------------------------------------------------------------
  // GET /robots.txt -- crawler directives
  // -----------------------------------------------------------------------

  describe('GET /robots.txt', () => {
    it('returns 200 with text containing "Disallow"', async () => {
      const res = await fetch(`${chatUrl}/robots.txt`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')

      const body = await res.text()
      expect(body).toContain('Disallow')
    })

    it('contains User-agent directive', async () => {
      const res = await fetch(`${chatUrl}/robots.txt`)
      const body = await res.text()
      expect(body).toContain('User-agent')
    })
  })

  // -----------------------------------------------------------------------
  // GET /xrpc/_health -- health check
  // -----------------------------------------------------------------------

  describe('GET /xrpc/_health', () => {
    it('returns 200 with JSON containing version', async () => {
      const res = await fetch(`${chatUrl}/xrpc/_health`)

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.version).toBeDefined()
      expect(typeof body.version).toBe('string')
    })

    it('does not include an error field when healthy', async () => {
      const res = await fetch(`${chatUrl}/xrpc/_health`)
      const body = await res.json()

      // A healthy response should not have an error field
      expect(body.error).toBeUndefined()
    })
  })
})
