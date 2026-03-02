import express from 'express'
import { getVerificationMaterial } from '@atproto/common-web'
import { IdResolver, getDidKeyFromMultibase } from '@atproto/identity'
import {
  AuthRequiredError,
  InvalidRequestError,
  parseReqNsid,
  verifyJwt as verifyServiceJwt,
} from '@atproto/xrpc-server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReqCtx = {
  req: express.Request
}

export type ServiceAuthCredentials = {
  type: 'service'
  did: string // The user's DID (sub claim or resolved from iss)
  iss: string // The issuer's DID (PDS or mod service)
  audience: string // The verified audience
}

export type ServiceAuthOutput = {
  credentials: ServiceAuthCredentials
}

export type ModServiceAuthCredentials = {
  type: 'mod_service'
  did: string
  iss: string
  audience: string
}

export type ModServiceAuthOutput = {
  credentials: ModServiceAuthCredentials
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type AuthVerifierOpts = {
  serviceDid: string
  idResolver: IdResolver
  modServiceDid?: string
}

// ---------------------------------------------------------------------------
// AuthVerifier
// ---------------------------------------------------------------------------

export class AuthVerifier {
  public serviceDid: string
  public idResolver: IdResolver
  public modServiceDid?: string

  constructor(opts: AuthVerifierOpts) {
    this.serviceDid = opts.serviceDid
    this.idResolver = opts.idResolver
    this.modServiceDid = opts.modServiceDid
  }

  // --------------------------------------------------
  // Public verifiers (arrow fns to preserve `this` scope
  // so they can be passed directly as xrpc auth handlers)
  // --------------------------------------------------

  /**
   * Standard service-auth verifier for most chat endpoints.
   *
   * - Extracts Bearer token
   * - Verifies the JWT via `verifyServiceJwt`
   * - Checks `aud` matches this service's DID
   * - Checks `lxm` matches the NSID being called (per errata E8)
   * - Resolves the issuer's signing key via IdResolver
   * - Returns the user DID from `sub` (or `iss` if no `sub`)
   */
  standard = async (ctx: ReqCtx): Promise<ServiceAuthOutput> => {
    const { payload } = await this.verifyJwt(ctx, {
      audience: this.serviceDid,
      checkLxm: true,
      allowedIssuers: null, // any issuer
    })
    const userDid = payload.sub ?? payload.iss
    return {
      credentials: {
        type: 'service',
        did: userDid,
        iss: payload.iss,
        audience: payload.aud,
      },
    }
  }

  /**
   * Mod service auth verifier for privileged moderation endpoints:
   * - getActorMetadata
   * - getMessageContext
   * - updateActorAccess
   *
   * Same as standard but restricts `iss` to the configured modServiceDid
   * (or `{modServiceDid}#atproto_labeler`).
   */
  modService = async (ctx: ReqCtx): Promise<ModServiceAuthOutput> => {
    if (!this.modServiceDid) {
      throw new AuthRequiredError(
        'mod service auth not configured',
        'AuthMissing',
      )
    }
    const allowedIssuers = [
      this.modServiceDid,
      `${this.modServiceDid}#atproto_labeler`,
    ]
    const { payload } = await this.verifyJwt(ctx, {
      audience: this.serviceDid,
      checkLxm: true,
      allowedIssuers,
    })
    const userDid = payload.sub ?? payload.iss
    return {
      credentials: {
        type: 'mod_service',
        did: userDid,
        iss: payload.iss,
        audience: payload.aud,
      },
    }
  }

  // --------------------------------------------------
  // Core JWT verification
  // --------------------------------------------------

  private async verifyJwt(
    ctx: ReqCtx,
    opts: {
      audience: string
      checkLxm: boolean
      allowedIssuers: string[] | null // null = any issuer
    },
  ): Promise<{
    payload: {
      iss: string
      aud: string
      exp: number
      lxm?: string
      sub?: string
    }
  }> {
    const jwtStr = bearerTokenFromReq(ctx.req)
    if (!jwtStr) {
      throw new AuthRequiredError('authentication required', 'AuthMissing')
    }

    // Determine the expected lxm from the request URL.
    // Per errata E8: when we pass a non-null lxm, verifyServiceJwt REQUIRES
    // payload.lxm to match. If payload.lxm is missing but expected, it throws
    // BadJwtLexiconMethod.
    let lxm: string | null = null
    if (opts.checkLxm) {
      try {
        lxm = parseReqNsid(ctx.req)
      } catch {
        throw new InvalidRequestError('could not determine method from request')
      }
    }

    // Build the signing key resolver. This is called by verifyServiceJwt to
    // obtain the public key for the JWT issuer (a PDS or mod service DID).
    const getSigningKey = async (
      iss: string,
      forceRefresh: boolean,
    ): Promise<string> => {
      // Check issuer allowlist before resolving anything
      if (opts.allowedIssuers !== null && !opts.allowedIssuers.includes(iss)) {
        throw new AuthRequiredError('untrusted issuer', 'UntrustedIss')
      }

      // Handle DID fragments for labeler keys:
      // e.g. "did:plc:abc#atproto_labeler" -> did = "did:plc:abc", keyId = "atproto_label"
      const [did, serviceId] = iss.split('#')
      const keyId =
        serviceId === 'atproto_labeler' ? 'atproto_label' : 'atproto'

      try {
        if (keyId === 'atproto') {
          // Standard case: resolve the #atproto verification method key
          const atprotoData = await this.idResolver.did.resolveAtprotoData(
            did,
            forceRefresh,
          )
          return atprotoData.signingKey
        } else {
          // Labeler case: resolve the DID document and find the specific key.
          // The DID document uses typed verification methods (e.g.
          // EcdsaSecp256k1VerificationKey2019) whose publicKeyMultibase
          // contains raw key bytes without a multicodec prefix. We use
          // getDidKeyFromMultibase() (from @atproto/identity) which handles
          // all verification method types correctly by inspecting the `type`
          // field to determine the key algorithm.
          const doc = await this.idResolver.did.ensureResolve(
            did,
            forceRefresh,
          )
          const key = getVerificationMaterial(doc, keyId)
          if (!key) {
            throw new AuthRequiredError('missing or bad key')
          }
          const didKey = getDidKeyFromMultibase(key)
          if (!didKey) {
            throw new AuthRequiredError('missing or bad key in did doc')
          }
          return didKey
        }
      } catch (err) {
        if (err instanceof AuthRequiredError) throw err
        throw new AuthRequiredError(
          `could not resolve signing key for issuer: ${did}`,
        )
      }
    }

    // Per errata E4: Do NOT add any fabricated 60-second expiry rule for
    // method-less tokens. The only expiry check is what verifyServiceJwt does
    // natively (checking payload.exp against current time).
    //
    // Per errata E8: We pass `lxm` (non-null when checkLxm is true).
    // verifyServiceJwt will REQUIRE payload.lxm to match. If payload.lxm is
    // missing but expected, it throws BadJwtLexiconMethod.
    const payload = await verifyServiceJwt(
      jwtStr,
      opts.audience, // aud check: must match this service's DID
      lxm, // lxm check: must match the NSID being called
      getSigningKey,
    )

    return { payload: payload as typeof payload & { sub?: string } }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BEARER = 'Bearer '

const bearerTokenFromReq = (req: express.Request): string | null => {
  const header = req.headers.authorization || ''
  if (!header.startsWith(BEARER)) return null
  return header.slice(BEARER.length).trim() || null
}
