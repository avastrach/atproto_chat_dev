import { TestNetwork } from '@atproto/dev-env'
import {
  TestUser,
  ChatApiClient,
  createTestNetwork,
  createTestUser,
  createModServiceClient,
} from './_util'

/**
 * Moderation endpoint authorization E2E tests.
 *
 * Covers:
 * - Standard users are denied access to moderation endpoints
 *   (getActorMetadata, getMessageContext, updateActorAccess)
 * - The moderation service client CAN call moderation endpoints
 *
 * The chat server's AuthVerifier.modService() restricts the `iss` claim
 * to the configured modServiceDid (or `{modServiceDid}#atproto_labeler`).
 * Standard user JWTs will fail with an "untrusted issuer" / auth error.
 *
 * References:
 * - auth-verifier.ts (modService verifier, UntrustedIss error)
 * - PRD 17.6.18 (getActorMetadata)
 * - PRD 17.6.19 (getMessageContext)
 * - PRD 17.6.20 (updateActorAccess)
 */

describe('moderation endpoint authorization', () => {
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
  // Standard users CANNOT call moderation endpoints
  // -----------------------------------------------------------------------

  describe('standard user denied access', () => {
    it('standard user cannot call getActorMetadata', async () => {
      // A regular user's JWT has an `iss` that is NOT the modServiceDid,
      // so the modService auth verifier should reject it with UntrustedIss.
      await expect(
        alice.agent.getActorMetadata(bob.did),
      ).rejects.toThrow()
    })

    it('standard user cannot call getMessageContext', async () => {
      // Even with a valid messageId, a regular user should be denied.
      // We use a dummy messageId since the auth check happens before
      // any parameter validation.
      await expect(
        alice.agent.getMessageContext('dummy-message-id'),
      ).rejects.toThrow()
    })

    it('standard user cannot call updateActorAccess', async () => {
      // A regular user should not be able to disable another user's
      // chat access. The auth check happens before body parsing.
      await expect(
        alice.agent.updateActorAccess(bob.did, false),
      ).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Moderation service CAN call moderation endpoints
  // -----------------------------------------------------------------------

  describe('moderation service granted access', () => {
    it('moderation service CAN call getActorMetadata', async () => {
      // The mod service client's JWT iss matches the configured modServiceDid,
      // so it should pass the modService auth verifier.
      const res = (await modClient.getActorMetadata(alice.did)) as {
        day: { messagesSent: number }
        month: { messagesSent: number }
        all: { messagesSent: number }
      }

      // The response should contain the expected time-period buckets
      expect(res).toBeDefined()
      expect(res.day).toBeDefined()
      expect(res.month).toBeDefined()
      expect(res.all).toBeDefined()
      expect(typeof res.day.messagesSent).toBe('number')
      expect(typeof res.month.messagesSent).toBe('number')
      expect(typeof res.all.messagesSent).toBe('number')
    })

    it('moderation service CAN call updateActorAccess', async () => {
      // Disable alice's chat access
      const disableRes = await modClient.updateActorAccess(alice.did, false)
      expect(disableRes).toBeDefined()

      // Re-enable alice's chat access so subsequent tests are unaffected
      const enableRes = await modClient.updateActorAccess(alice.did, true)
      expect(enableRes).toBeDefined()
    })
  })
})
