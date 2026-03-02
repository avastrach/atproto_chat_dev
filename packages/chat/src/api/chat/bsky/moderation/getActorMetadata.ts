import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: mod service auth required
    await ctx.authVerifier.modService({ req })

    // Parse query params
    const actor = req.query.actor
    if (!actor || typeof actor !== 'string') {
      throw new InvalidRequestError('actor parameter is required')
    }

    const result = await ctx.services.moderation.getActorMetadata(actor)

    res.json(result)
  }
}
