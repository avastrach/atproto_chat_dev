import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse convoId from request body (procedure = POST with JSON body)
    const body = req.body
    if (!body || typeof body.convoId !== 'string') {
      throw new InvalidRequestError('convoId is required')
    }

    const result = await ctx.services.conversation.acceptConvo(
      requesterDid,
      body.convoId,
    )

    const response: Record<string, unknown> = {}
    if (result.rev) {
      response.rev = result.rev
    }

    res.json(response)
  }
}
