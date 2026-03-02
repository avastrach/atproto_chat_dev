import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse request body
    const body = req.body
    if (!body || typeof body.convoId !== 'string') {
      throw new InvalidRequestError('convoId is required')
    }
    if (!body.message || typeof body.message.text !== 'string') {
      throw new InvalidRequestError('message with text is required')
    }

    const messageView = await ctx.services.message.sendMessage(
      requesterDid,
      body.convoId,
      {
        text: body.message.text,
        facets: body.message.facets,
        embed: body.message.embed,
      },
    )

    res.json(messageView)
  }
}
