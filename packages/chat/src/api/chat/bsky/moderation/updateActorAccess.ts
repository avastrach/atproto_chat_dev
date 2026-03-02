import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: mod service auth required
    await ctx.authVerifier.modService({ req })

    // Parse body (procedure = POST with JSON body)
    const body = req.body
    if (!body || typeof body.actor !== 'string') {
      throw new InvalidRequestError('actor is required')
    }
    if (typeof body.allowAccess !== 'boolean') {
      throw new InvalidRequestError('allowAccess is required')
    }

    const ref = typeof body.ref === 'string' ? body.ref : undefined

    await ctx.services.moderation.updateActorAccess(
      body.actor,
      body.allowAccess,
      ref,
    )

    res.json({})
  }
}
