import { AtpAgent } from '@atproto/api'
import { Database } from '../db'

/**
 * Staleness threshold for cached profiles: 1 hour in milliseconds.
 */
const PROFILE_STALE_MS = 60 * 60 * 1000

/**
 * Row returned from the profile table after selection.
 */
export interface ProfileRecord {
  did: string
  handle: string | null
  displayName: string | null
  avatar: string | null
  chatDisabled: boolean
  updatedAt: string
}

/**
 * ProfileSyncService provides on-demand profile synchronisation from the
 * AppView. Profiles are fetched when they are missing from the local cache
 * or when the cached copy is older than {@link PROFILE_STALE_MS}.
 */
export class ProfileSyncService {
  constructor(private appviewAgent?: AtpAgent) {}

  /**
   * Ensure a fresh profile record exists in the local database.
   *
   * 1. Looks up the profile in the `profile` table.
   * 2. If the row is missing or its `updatedAt` is older than 1 hour,
   *    fetches the canonical profile from the AppView via
   *    `app.bsky.actor.getProfile` and upserts the result.
   * 3. Returns the (possibly refreshed) profile record.
   *
   * If the AppView is unavailable or returns an error the method falls back
   * to the cached row (if any) or returns a minimal stub so callers are
   * never blocked by a transient AppView outage.
   */
  async ensureProfile(db: Database, did: string): Promise<ProfileRecord> {
    // Check the local cache first
    const cached = await db.db
      .selectFrom('profile')
      .where('did', '=', did)
      .selectAll()
      .executeTakeFirst()

    const now = Date.now()
    const isStale =
      !cached ||
      !cached.handle ||
      now - new Date(cached.updatedAt).getTime() > PROFILE_STALE_MS

    if (!isStale && cached) {
      return cached as ProfileRecord
    }

    // Attempt to refresh from AppView
    if (this.appviewAgent) {
      try {
        const res = await this.appviewAgent.api.app.bsky.actor.getProfile({
          actor: did,
        })

        const profile = res.data

        const record: ProfileRecord = {
          did,
          handle: profile.handle ?? null,
          displayName: profile.displayName ?? null,
          avatar: profile.avatar ?? null,
          chatDisabled: !!(profile as unknown as Record<string, unknown>).chatDisabled,
          updatedAt: new Date().toISOString(),
        }

        // Upsert into the profile table
        await db.db
          .insertInto('profile')
          .values({
            did: record.did,
            handle: record.handle,
            displayName: record.displayName,
            avatar: record.avatar,
            chatDisabled: record.chatDisabled,
            updatedAt: record.updatedAt,
          })
          .onConflict((oc) =>
            oc.column('did').doUpdateSet({
              handle: record.handle,
              displayName: record.displayName,
              avatar: record.avatar,
              chatDisabled: record.chatDisabled,
              updatedAt: record.updatedAt,
            }),
          )
          .execute()

        return record
      } catch {
        // AppView unavailable: fall through to cached / stub
      }
    }

    // Return cached row if available, otherwise a minimal stub
    if (cached) {
      return cached as ProfileRecord
    }

    return {
      did,
      handle: null,
      displayName: null,
      avatar: null,
      chatDisabled: false,
      updatedAt: new Date().toISOString(),
    }
  }
}
