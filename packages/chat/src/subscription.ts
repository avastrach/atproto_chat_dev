import { IdResolver } from '@atproto/identity'
import {
  Event as FirehoseEvent,
  Firehose,
  MemoryRunner,
} from '@atproto/sync'
import { subsystemLogger } from '@atproto/common'
import { Database } from './db'

const log = subsystemLogger('chat:subscription')

// Collections the chat backend subscribes to on the firehose
const FILTER_COLLECTIONS = [
  'chat.bsky.actor.declaration',
  'app.bsky.actor.profile',
  'app.bsky.graph.block',
]

export class ChatRepoSubscription {
  firehose: Firehose
  runner: MemoryRunner

  constructor(
    public opts: {
      service: string
      db: Database
      idResolver: IdResolver
    },
  ) {
    const { runner, firehose } = createFirehose({
      service: opts.service,
      db: opts.db,
      idResolver: opts.idResolver,
    })
    this.runner = runner
    this.firehose = firehose
  }

  start() {
    this.firehose.start()
  }

  async processAll() {
    await this.runner.processAll()
  }

  async destroy() {
    await this.firehose.destroy()
    await this.runner.destroy()
  }
}

function createFirehose(opts: {
  service: string
  db: Database
  idResolver: IdResolver
}) {
  const { service, db, idResolver } = opts
  const runner = new MemoryRunner({ startCursor: 0 })
  const firehose = new Firehose({
    idResolver,
    runner,
    service,
    filterCollections: FILTER_COLLECTIONS,
    unauthenticatedCommits: true,
    unauthenticatedHandles: true,
    excludeIdentity: false,
    excludeAccount: true,
    excludeSync: true,
    onError: (err) => log.error({ err }, 'error in chat subscription'),
    handleEvent: async (evt: FirehoseEvent) => {
      // Handle identity events (handle updates)
      if (evt.event === 'identity') {
        try {
          await handleIdentity(db, evt)
        } catch (err) {
          log.error(
            { err, did: evt.did, event: evt.event },
            'failed to handle identity event',
          )
        }
        return
      }

      // We only care about commit events (create, update, delete)
      if (
        evt.event !== 'create' &&
        evt.event !== 'update' &&
        evt.event !== 'delete'
      ) {
        return
      }

      const { collection, did } = evt

      try {
        if (collection === 'chat.bsky.actor.declaration') {
          await handleDeclaration(db, evt)
        } else if (collection === 'app.bsky.actor.profile') {
          await handleProfile(db, evt)
        } else if (collection === 'app.bsky.graph.block') {
          await handleBlock(evt)
        }
      } catch (err) {
        log.error(
          { err, did, collection, event: evt.event },
          'failed to handle firehose event',
        )
      }
    },
  })
  return { firehose, runner }
}

// ---------------------------------------------------------------------------
// DeclarationSubscriber: chat.bsky.actor.declaration -> actor_setting
// ---------------------------------------------------------------------------

async function handleDeclaration(
  db: Database,
  evt: FirehoseEvent,
): Promise<void> {
  if (evt.event === 'delete') {
    // When a declaration record is deleted, remove the setting row
    // (the default 'following' behaviour takes effect implicitly)
    await db.db
      .deleteFrom('actor_setting')
      .where('did', '=', evt.did)
      .execute()
    return
  }

  // create or update
  if (evt.event !== 'create' && evt.event !== 'update') return
  const record = evt.record as Record<string, unknown> | undefined
  if (!record) return

  const allowIncoming = record.allowIncoming
  if (
    typeof allowIncoming !== 'string' ||
    !['all', 'following', 'none'].includes(allowIncoming)
  ) {
    return
  }

  const now = new Date().toISOString()

  await db.db
    .insertInto('actor_setting')
    .values({
      did: evt.did,
      allowIncoming: allowIncoming as 'all' | 'following' | 'none',
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.column('did').doUpdateSet({
        allowIncoming: allowIncoming as 'all' | 'following' | 'none',
        updatedAt: now,
      }),
    )
    .execute()
}

// ---------------------------------------------------------------------------
// IdentityHandler: identity events -> profile.handle
// ---------------------------------------------------------------------------

async function handleIdentity(
  db: Database,
  evt: FirehoseEvent,
): Promise<void> {
  // Identity events carry the current handle for a DID
  const handle = (evt as { handle?: string }).handle
  if (!handle) return

  const now = new Date().toISOString()

  // Upsert: if profile row exists, update handle; if not, create a minimal row
  await db.db
    .insertInto('profile')
    .values({
      did: evt.did,
      handle,
      displayName: null,
      avatar: null,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.column('did').doUpdateSet({
        handle,
        updatedAt: now,
      }),
    )
    .execute()
}

// ---------------------------------------------------------------------------
// ProfileSubscriber: app.bsky.actor.profile -> profile
// ---------------------------------------------------------------------------

async function handleProfile(
  db: Database,
  evt: FirehoseEvent,
): Promise<void> {
  if (evt.event === 'delete') {
    // Nullify profile fields but keep the row (the DID still exists,
    // and there may be conversations referencing this profile)
    const existing = await db.db
      .selectFrom('profile')
      .where('did', '=', evt.did)
      .select('did')
      .executeTakeFirst()

    if (existing) {
      await db.db
        .updateTable('profile')
        .set({
          displayName: null,
          avatar: null,
          updatedAt: new Date().toISOString(),
        })
        .where('did', '=', evt.did)
        .execute()
    }
    return
  }

  // create or update
  if (evt.event !== 'create' && evt.event !== 'update') return
  const record = evt.record as Record<string, unknown> | undefined
  if (!record) return

  const displayName =
    typeof record.displayName === 'string' ? record.displayName : null
  const avatar = typeof record.avatar === 'string' ? record.avatar : null

  const now = new Date().toISOString()

  await db.db
    .insertInto('profile')
    .values({
      did: evt.did,
      handle: null, // handle comes from identity events, not profile records
      displayName,
      avatar,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.column('did').doUpdateSet({
        displayName,
        avatar,
        updatedAt: now,
      }),
    )
    .execute()
}

// ---------------------------------------------------------------------------
// BlockCacheSubscriber: app.bsky.graph.block -> log + future cache hook
// ---------------------------------------------------------------------------

async function handleBlock(evt: FirehoseEvent): Promise<void> {
  // Log block events for observability. The PrivacyService currently
  // queries the AppView for block status on demand.  When a Redis
  // block-pair cache is added, this handler should invalidate the
  // relevant cache keys so canChat() picks up changes immediately.
  if (evt.event === 'create') {
    const record = evt.record as Record<string, unknown> | undefined
    const subject = record?.subject
    log.info(
      { blocker: evt.did, subject, rkey: evt.rkey },
      'block created',
    )
  } else if (evt.event === 'delete') {
    log.info({ blocker: evt.did, rkey: evt.rkey }, 'block deleted')
  }

  // TODO: When Redis block cache is implemented, invalidate here:
  // if (redis) {
  //   const cacheKey = blockCacheKey(evt.did, subject)
  //   await redis.del(cacheKey)
  // }
}
