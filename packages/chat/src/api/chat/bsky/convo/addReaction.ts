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
    if (typeof body.value !== 'string') {
      throw new InvalidRequestError('value is required')
    }

    const messageView = await ctx.services.message.addReaction(
      requesterDid,
      body.convoId,
      body.messageId,
      body.value,
    )

    res.json({ message: messageView })
  }
}
