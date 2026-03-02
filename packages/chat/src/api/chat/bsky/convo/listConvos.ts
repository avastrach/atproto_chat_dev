import express from 'express'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse optional query params
    const limit = req.query.limit
      ? parseInt(String(req.query.limit), 10)
      : undefined
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    const readState =
      typeof req.query.readState === 'string' ? req.query.readState : undefined
    const status =
      typeof req.query.status === 'string' ? req.query.status : undefined

    const result = await ctx.services.conversation.listConvos(requesterDid, {
      limit,
      cursor,
      readState,
      status,
    })

    const response: Record<string, unknown> = {
      convos: result.convos,
    }
    if (result.cursor) {
      response.cursor = result.cursor
    }

    res.json(response)
  }
}
