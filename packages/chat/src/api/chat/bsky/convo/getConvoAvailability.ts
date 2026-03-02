import express from 'express'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse members from query params
    // XRPC array params come as repeated query params: ?members=did1&members=did2
    const membersParam = req.query.members
    let members: string[]
    if (Array.isArray(membersParam)) {
      members = membersParam.map(String)
    } else if (typeof membersParam === 'string') {
      members = [membersParam]
    } else {
      throw new InvalidRequestError('members parameter is required')
    }

    // Validate members array (per errata E9: length >= 1 && length <= 10)
    if (members.length < 1 || members.length > 10) {
      throw new InvalidRequestError(
        `Invalid members count: ${members.length}. Must be between 1 and 10.`,
      )
    }

    const result = await ctx.services.conversation.getConvoAvailability(
      requesterDid,
      members,
    )

    const response: Record<string, unknown> = {
      canChat: result.canChat,
    }
    if (result.convo) {
      response.convo = result.convo
    }

    res.json(response)
  }
}
