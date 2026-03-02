import express from 'express'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse query params
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined

    const result = await ctx.services.eventLog.getLog(
      ctx.db,
      requesterDid,
      cursor,
    )

    const response: Record<string, unknown> = {
      logs: result.logs,
    }
    if (result.cursor) {
      response.cursor = result.cursor
    }

    res.json(response)
  }
}
