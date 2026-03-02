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
    if (!body || !Array.isArray(body.items)) {
      throw new InvalidRequestError('items array is required')
    }

    // Validate each item has required fields
    const items = body.items.map(
      (item: { convoId?: string; message?: { text?: string; facets?: unknown[]; embed?: unknown } }) => {
        if (!item.convoId || typeof item.convoId !== 'string') {
          throw new InvalidRequestError('Each item must have a convoId')
        }
        if (
          !item.message ||
          typeof item.message.text !== 'string'
        ) {
          throw new InvalidRequestError(
            'Each item must have a message with text',
          )
        }
        return {
          convoId: item.convoId,
          message: {
            text: item.message.text,
            facets: item.message.facets,
            embed: item.message.embed,
          },
        }
      },
    )

    const messageViews = await ctx.services.message.sendMessageBatch(
      requesterDid,
      items,
    )

    res.json({ items: messageViews })
  }
}
