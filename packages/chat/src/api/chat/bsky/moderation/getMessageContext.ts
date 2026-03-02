import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: mod service auth required
    await ctx.authVerifier.modService({ req })

    // Parse query params
    const messageId = req.query.messageId
    if (!messageId || typeof messageId !== 'string') {
      throw new InvalidRequestError('messageId parameter is required')
    }

    const convoId =
      typeof req.query.convoId === 'string' ? req.query.convoId : undefined

    const before = req.query.before
      ? parseInt(String(req.query.before), 10)
      : 5
    const after = req.query.after ? parseInt(String(req.query.after), 10) : 5

    const result = await ctx.services.moderation.getMessageContext(
      messageId,
      convoId,
      before,
      after,
    )

    res.json(result)
  }
}
