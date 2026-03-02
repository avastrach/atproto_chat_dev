import { Keypair } from '@atproto/crypto'
import { TestNetwork } from '@atproto/dev-env'
import { createServiceJwt } from '@atproto/xrpc-server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestUser {
  did: string
  handle: string
  agent: ChatApiClient
  /** PDS access JWT for making raw XRPC calls (e.g. creating blocks/follows). */
  accessJwt: string
}

/** Result returned by {@link createBlock}. Includes the AT URI so the block
 *  can be deleted later via {@link removeBlock}. */
export interface BlockRef {
  uri: string
  cid: string
}

// ---------------------------------------------------------------------------
// ChatApiClient -- lightweight HTTP client for chat XRPC endpoints
// ---------------------------------------------------------------------------

/**
 * A thin HTTP wrapper around the chat service's XRPC endpoints.
 *
 * Each request is authenticated with a service-auth JWT signed by the user's
 * own keypair (the same key registered in their DID document). The JWT carries:
 *   iss = user DID
 *   aud = chat service DID
 *   lxm = the NSID of the endpoint being called
 *
 * The chat service's AuthVerifier resolves the issuer's signing key via
 * IdResolver and validates accordingly.
 */
export class ChatApiClient {
  constructor(
    private chatUrl: string,
    private userDid: string,
    private keypair: Keypair,
    private chatServiceDid: string,
  ) {}

  // --------------------------------------------------
  // GET (query) endpoints -- convo
  // --------------------------------------------------

  async getConvo(convoId: string) {
    return this.xrpcGet('chat.bsky.convo.getConvo', { convoId })
  }

  async listConvos(opts?: {
    limit?: number
    cursor?: string
    status?: string
    readState?: string
  }) {
    return this.xrpcGet('chat.bsky.convo.listConvos', opts)
  }

  async getConvoForMembers(members: string[]) {
    return this.xrpcGet('chat.bsky.convo.getConvoForMembers', { members })
  }

  async getMessages(
    convoId: string,
    opts?: { limit?: number; cursor?: string },
  ) {
    return this.xrpcGet('chat.bsky.convo.getMessages', {
      convoId,
      ...opts,
    })
  }

  async getLog(cursor?: string) {
    return this.xrpcGet('chat.bsky.convo.getLog', cursor ? { cursor } : {})
  }

  async getConvoAvailability(members: string[]) {
    return this.xrpcGet('chat.bsky.convo.getConvoAvailability', { members })
  }

  // --------------------------------------------------
  // GET (query) endpoints -- actor / declaration
  // --------------------------------------------------

  /** GET chat.bsky.actor.declaration – returns the caller's allowIncoming
   *  privacy setting (defaults to "following" when unset). */
  async getDeclaration() {
    return this.xrpcGet('chat.bsky.actor.declaration')
  }

  // --------------------------------------------------
  // POST (procedure) endpoints -- actor / declaration
  // --------------------------------------------------

  /** POST chat.bsky.actor.updateDeclaration – upserts the caller's
   *  allowIncoming chat privacy preference.
   *  @param allowIncoming One of "all" | "following" | "none". */
  async setDeclaration(allowIncoming: string) {
    return this.xrpcPost('chat.bsky.actor.updateDeclaration', {
      allowIncoming,
    })
  }

  // --------------------------------------------------
  // GET (query) endpoints -- moderation
  // --------------------------------------------------

  /** GET chat.bsky.moderation.getActorMetadata – requires mod-service auth.
   *  Returns metadata about the given actor's chat activity. */
  async getActorMetadata(did: string) {
    return this.xrpcGet('chat.bsky.moderation.getActorMetadata', {
      actor: did,
    })
  }

  /** GET chat.bsky.moderation.getMessageContext – requires mod-service auth.
   *  Returns messages surrounding the given messageId. */
  async getMessageContext(
    messageId: string,
    opts?: { convoId?: string; before?: number; after?: number },
  ) {
    return this.xrpcGet('chat.bsky.moderation.getMessageContext', {
      messageId,
      ...opts,
    })
  }

  // --------------------------------------------------
  // POST (procedure) endpoints -- moderation
  // --------------------------------------------------

  /** POST chat.bsky.moderation.updateActorAccess – requires mod-service auth.
   *  Enables or disables a user's access to chat. */
  async updateActorAccess(did: string, allowAccess: boolean) {
    return this.xrpcPost('chat.bsky.moderation.updateActorAccess', {
      actor: did,
      allowAccess,
    })
  }

  // --------------------------------------------------
  // POST (procedure) endpoints -- convo
  // --------------------------------------------------

  async sendMessage(
    convoId: string,
    message: { text: string; facets?: unknown[]; embed?: unknown },
  ) {
    return this.xrpcPost('chat.bsky.convo.sendMessage', { convoId, message })
  }

  async sendMessageBatch(
    items: Array<{ convoId: string; message: { text: string } }>,
  ) {
    return this.xrpcPost('chat.bsky.convo.sendMessageBatch', { items })
  }

  async acceptConvo(convoId: string) {
    return this.xrpcPost('chat.bsky.convo.acceptConvo', { convoId })
  }

  async leaveConvo(convoId: string) {
    return this.xrpcPost('chat.bsky.convo.leaveConvo', { convoId })
  }

  async deleteMessageForSelf(convoId: string, messageId: string) {
    return this.xrpcPost('chat.bsky.convo.deleteMessageForSelf', {
      convoId,
      messageId,
    })
  }

  async updateRead(convoId: string, messageId?: string) {
    return this.xrpcPost('chat.bsky.convo.updateRead', {
      convoId,
      ...(messageId ? { messageId } : {}),
    })
  }

  async updateAllRead(opts?: { status?: string }) {
    return this.xrpcPost('chat.bsky.convo.updateAllRead', opts ?? {})
  }

  async addReaction(convoId: string, messageId: string, value: string) {
    return this.xrpcPost('chat.bsky.convo.addReaction', {
      convoId,
      messageId,
      value,
    })
  }

  async removeReaction(convoId: string, messageId: string, value: string) {
    return this.xrpcPost('chat.bsky.convo.removeReaction', {
      convoId,
      messageId,
      value,
    })
  }

  async muteConvo(convoId: string) {
    return this.xrpcPost('chat.bsky.convo.muteConvo', { convoId })
  }

  async unmuteConvo(convoId: string) {
    return this.xrpcPost('chat.bsky.convo.unmuteConvo', { convoId })
  }

  // --------------------------------------------------
  // GET (query) endpoints -- account
  // --------------------------------------------------

  /** GET chat.bsky.actor.exportAccountData -- returns a JSONL stream of
   *  all chat data for the authenticated user. */
  async exportAccountData(): Promise<string> {
    return this.xrpcGetRaw('chat.bsky.actor.exportAccountData')
  }

  // --------------------------------------------------
  // POST (procedure) endpoints -- account
  // --------------------------------------------------

  /** POST chat.bsky.actor.deleteAccount -- deletes all chat data for the
   *  authenticated user. */
  async deleteAccount() {
    return this.xrpcPost('chat.bsky.actor.deleteAccount', {})
  }

  // --------------------------------------------------
  // Internal helpers
  // --------------------------------------------------

  private async getAuthHeaders(nsid: string): Promise<Record<string, string>> {
    const jwt = await createServiceJwt({
      iss: this.userDid,
      aud: this.chatServiceDid,
      lxm: nsid,
      keypair: this.keypair,
    })
    return {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    }
  }

  private async xrpcGetRaw(
    nsid: string,
    params?: Record<string, unknown>,
  ): Promise<string> {
    const url = new URL(`/xrpc/${nsid}`, this.chatUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item))
          }
        } else {
          url.searchParams.set(key, String(value))
        }
      }
    }
    const headers = await this.getAuthHeaders(nsid)
    const res = await fetch(url.toString(), { method: 'GET', headers })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(
        `Chat API GET ${nsid} failed (${res.status}): ${body}`,
      )
    }
    return res.text()
  }

  private async xrpcGet(
    nsid: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL(`/xrpc/${nsid}`, this.chatUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          // XRPC array params are repeated query params
          for (const item of value) {
            url.searchParams.append(key, String(item))
          }
        } else {
          url.searchParams.set(key, String(value))
        }
      }
    }
    const headers = await this.getAuthHeaders(nsid)
    const res = await fetch(url.toString(), { method: 'GET', headers })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(
        `Chat API GET ${nsid} failed (${res.status}): ${body}`,
      )
    }
    return res.json()
  }

  private async xrpcPost(
    nsid: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL(`/xrpc/${nsid}`, this.chatUrl)
    const headers = await this.getAuthHeaders(nsid)
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const resBody = await res.text()
      throw new Error(
        `Chat API POST ${nsid} failed (${res.status}): ${resBody}`,
      )
    }
    // Some POST endpoints may return empty body (204)
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }
}

// ---------------------------------------------------------------------------
// Network & User Helpers
// ---------------------------------------------------------------------------

/**
 * Create a full TestNetwork (PLC, PDS, AppView, Ozone, Chat).
 *
 * This uses the standard TestNetwork.create() from @atproto/dev-env which
 * already provisions a TestChat instance. The caller must have Docker running
 * (PostgreSQL + Redis) or the DB_POSTGRES_URL / REDIS_HOST env vars set.
 */
export async function createTestNetwork(): Promise<TestNetwork> {
  // Use a unique schema name per test network to avoid collisions when
  // multiple test files run concurrently (pg_namespace unique constraint).
  // Schema names must only contain [A-Za-z_] per the DB validation.
  const suffix = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 12)
  const uniqueId = `chat_test_${suffix}`
  const network = await TestNetwork.create({
    dbPostgresSchema: uniqueId,
    chat: {},
  })
  return network
}

/**
 * Create a test user account on the PDS and return a ChatApiClient wired to
 * talk directly to the chat service.
 *
 * The client authenticates using service-auth JWTs signed with the user's
 * signing key (the one stored in the PDS actorStore and registered in PLC).
 */
export interface CreateTestUserOpts {
  /** When true, skip setting allowIncoming='all' so the server default
   *  ('following') remains in effect.  Useful for tests that verify
   *  the default privacy behavior. */
  skipAllowIncoming?: boolean
}

export async function createTestUser(
  network: TestNetwork,
  handle: string,
  opts?: CreateTestUserOpts,
): Promise<TestUser> {
  const sc = network.getSeedClient()
  const shortName = handle.replace('.test', '')

  await sc.createAccount(shortName, {
    handle,
    email: `${shortName}@test.com`,
    password: `${shortName}-pass`,
  })

  const did = sc.dids[shortName]
  const accessJwt = sc.accounts[did]?.accessJwt
  if (!accessJwt) {
    throw new Error(
      `No access token found for ${did} after createAccount -- SeedClient issue`,
    )
  }

  // Process PDS events so the account is visible to the appview/chat
  await network.processAll()

  // Retrieve the user's signing keypair from the PDS actor store
  const keypair = await network.pds.ctx.actorStore.keypair(did)

  const agent = new ChatApiClient(
    network.chat.url,
    did,
    keypair,
    network.chat.serverDid,
  )

  // Default to allowIncoming='all' so tests that don't specifically test
  // privacy controls can create conversations without follow relationships.
  // Tests that need to verify privacy behavior can pass
  // { skipAllowIncoming: true } or override via setAllowIncoming().
  if (!opts?.skipAllowIncoming) {
    await agent.setDeclaration('all')
  }

  return { did, handle, agent, accessJwt }
}

/**
 * Convenience: create multiple test users at once.
 */
export async function createTestUsers(
  network: TestNetwork,
  handles: string[],
): Promise<TestUser[]> {
  const users: TestUser[] = []
  for (const handle of handles) {
    users.push(await createTestUser(network, handle))
  }
  return users
}

// ---------------------------------------------------------------------------
// Block Helpers
// ---------------------------------------------------------------------------

/**
 * Create a block record (app.bsky.graph.block) on the PDS via
 * com.atproto.repo.createRecord.
 *
 * Uses raw HTTP fetch against the PDS XRPC endpoint, authenticated with the
 * blocker's access JWT from the SeedClient account store.
 *
 * @returns A {@link BlockRef} with the AT URI and CID of the created record.
 */
export async function createBlock(
  network: TestNetwork,
  blocker: TestUser,
  blocked: TestUser,
): Promise<BlockRef> {
  const accessJwt = blocker.accessJwt

  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: blocker.did,
        collection: 'app.bsky.graph.block',
        record: {
          $type: 'app.bsky.graph.block',
          subject: blocked.did,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`createBlock failed (${res.status}): ${body}`)
  }

  const data = (await res.json()) as { uri: string; cid: string }
  // Let the network propagate the new record to the appview
  await network.processAll()
  return { uri: data.uri, cid: data.cid }
}

/**
 * Remove a previously-created block record via
 * com.atproto.repo.deleteRecord on the PDS.
 *
 * The rkey is extracted from the block's AT URI (stored in the
 * {@link BlockRef} returned by {@link createBlock}).
 */
export async function removeBlock(
  network: TestNetwork,
  blocker: TestUser,
  blockRef: BlockRef,
): Promise<void> {
  const accessJwt = blocker.accessJwt

  // AT URI format: at://did/collection/rkey
  const rkey = blockRef.uri.split('/').pop()

  const res = await fetch(
    `${network.pds.url}/xrpc/com.atproto.repo.deleteRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repo: blocker.did,
        collection: 'app.bsky.graph.block',
        rkey,
      }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`removeBlock failed (${res.status}): ${body}`)
  }

  // Let the network propagate the deletion
  await network.processAll()
}

// ---------------------------------------------------------------------------
// Privacy / Declaration Helpers
// ---------------------------------------------------------------------------

/**
 * Set a user's allowIncoming chat privacy declaration.
 *
 * Wraps {@link ChatApiClient.setDeclaration} for concise test setup.
 *
 * @param client  The user's ChatApiClient.
 * @param value   One of "all" | "following" | "none".
 */
export async function setAllowIncoming(
  client: ChatApiClient,
  value: string,
): Promise<unknown> {
  return client.setDeclaration(value)
}

// ---------------------------------------------------------------------------
// Moderation Helpers
// ---------------------------------------------------------------------------

/**
 * Enable or disable a user's access to chat via the moderation endpoint.
 *
 * @param modClient  A ChatApiClient authenticated as the mod service
 *                   (see {@link createModServiceClient}).
 * @param userDid    The DID of the user whose access is being toggled.
 * @param disabled   When true the user's chat access is revoked;
 *                   when false it is restored.
 */
export async function setChatDisabled(
  modClient: ChatApiClient,
  userDid: string,
  disabled: boolean,
): Promise<unknown> {
  return modClient.updateActorAccess(userDid, !disabled)
}

/**
 * Create a ChatApiClient authenticated as the moderation service.
 *
 * The mod service endpoints (getActorMetadata, getMessageContext,
 * updateActorAccess) require JWTs whose issuer matches the chat server's
 * configured modServiceDid. In the dev-env this is the Ozone service
 * profile's DID, and its signing key is available on the Ozone context.
 */
export async function createModServiceClient(
  network: TestNetwork,
): Promise<ChatApiClient> {
  // The Ozone service DID registers its key under the #atproto_label
  // verification method (not #atproto), so we must issue JWTs with the
  // `#atproto_labeler` fragment so the chat auth verifier resolves the
  // correct key from the DID document.
  const modServiceDid = network.ozone.ctx.cfg.service.did
  const modServiceKeypair = network.ozone.ctx.signingKey

  return new ChatApiClient(
    network.chat.url,
    `${modServiceDid}#atproto_labeler`,
    modServiceKeypair,
    network.chat.serverDid,
  )
}
