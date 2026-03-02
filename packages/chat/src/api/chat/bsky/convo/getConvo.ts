import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse convoId from query params
    const convoId = req.query.convoId
    if (!convoId || typeof convoId !== 'string') {
      throw new InvalidRequestError('convoId parameter is required')
    }

    const convo = await ctx.services.conversation.getConvo(
      requesterDid,
      convoId,
    )

    res.json({ convo })
  }
}
