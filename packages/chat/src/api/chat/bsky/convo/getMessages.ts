import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'
import type { MessageView } from '../../../../views'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse query params
    const convoId = req.query.convoId
    if (!convoId || typeof convoId !== 'string') {
      throw new InvalidRequestError('convoId parameter is required')
    }

    const limit = req.query.limit
      ? parseInt(String(req.query.limit), 10)
      : undefined
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined

    const result = await ctx.services.message.getMessages(
      requesterDid,
      convoId,
      { limit, cursor },
    )

    // Hydrate embeds (transform app.bsky.embed.record → #view)
    const messageViews = result.messages.filter(
      (m): m is MessageView =>
        m.$type === 'chat.bsky.convo.defs#messageView',
    )
    if (messageViews.length > 0) {
      await ctx.services.viewBuilder.hydrateMessageEmbeds(messageViews)
    }

    const response: Record<string, unknown> = {
      messages: result.messages,
    }
    if (result.cursor) {
      response.cursor = result.cursor
    }

    res.json(response)
  }
}
