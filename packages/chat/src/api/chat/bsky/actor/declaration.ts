import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

const ALLOWED_VALUES = ['all', 'following', 'none'] as const
type AllowIncoming = (typeof ALLOWED_VALUES)[number]

/**
 * GET handler – chat.bsky.actor.declaration
 *
 * Returns the caller's current allowIncoming chat privacy preference.
 * Defaults to "following" when no record exists.
 */
export function getDeclaration(ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: standard service auth
    const auth = await ctx.authVerifier.standard({ req })
    const callerDid = auth.credentials.did

    const row = await ctx.db.db
      .selectFrom('actor_setting')
      .select('allowIncoming')
      .where('did', '=', callerDid)
      .executeTakeFirst()

    const allowIncoming: AllowIncoming = row?.allowIncoming ?? 'following'

    res.json({ allowIncoming })
  }
}

/**
 * POST handler – chat.bsky.actor.updateDeclaration
 *
 * Upserts the caller's allowIncoming chat privacy preference.
 * Accepts body: { allowIncoming: "all" | "following" | "none" }
 * Returns the updated setting.
 */
export function updateDeclaration(ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: standard service auth
    const auth = await ctx.authVerifier.standard({ req })
    const callerDid = auth.credentials.did

    // Parse and validate request body
    const body = req.body
    if (
      !body ||
      typeof body.allowIncoming !== 'string' ||
      !ALLOWED_VALUES.includes(body.allowIncoming as AllowIncoming)
    ) {
      throw new InvalidRequestError(
        'allowIncoming is required and must be one of: all, following, none',
      )
    }

    const allowIncoming = body.allowIncoming as AllowIncoming
    const now = new Date().toISOString()

    // Upsert: insert or update on conflict
    await ctx.db.db
      .insertInto('actor_setting')
      .values({
        did: callerDid,
        allowIncoming,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.column('did').doUpdateSet({
          allowIncoming,
          updatedAt: now,
        }),
      )
      .execute()

    res.json({ allowIncoming })
  }
}
