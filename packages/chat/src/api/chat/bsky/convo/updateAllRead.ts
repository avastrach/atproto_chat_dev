import express from 'express'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse request body (all fields optional)
    const body = req.body ?? {}
    const status =
      typeof body.status === 'string' ? body.status : undefined

    const result = await ctx.services.readState.updateAllRead(
      requesterDid,
      status,
    )

    res.json({ updatedCount: result.updatedCount })
  }
}
