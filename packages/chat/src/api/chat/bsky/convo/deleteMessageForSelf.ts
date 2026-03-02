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
    if (typeof body.messageId !== 'string') {
      throw new InvalidRequestError('messageId is required')
    }

    const deletedView = await ctx.services.message.deleteMessageForSelf(
      requesterDid,
      body.convoId,
      body.messageId,
    )

    res.json(deletedView)
  }
}
