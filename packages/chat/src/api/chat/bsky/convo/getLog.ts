import express from 'express'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate
    const auth = await ctx.authVerifier.standard({ req })
    const requesterDid = auth.credentials.did

    // Parse query params
    const cursor =
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined

    const result = await ctx.services.eventLog.getLog(
      ctx.db,
      requesterDid,
      cursor,
    )

    // Filter out events from conversations the caller has rejoined,
    // where the event was created before the rejoin timestamp.
    // This prevents stale pre-leave events from leaking after rejoin.
    const convoIds = [...new Set(result.logs.map((l) => l.convoId))]
    let rejoinedAtMap: Map<string, string> | undefined
    if (convoIds.length > 0) {
      const memberRows = await ctx.db.db
        .selectFrom('conversation_member')
        .where('memberDid', '=', requesterDid)
        .where('convoId', 'in', convoIds)
        .where('rejoinedAt', 'is not', null)
        .select(['convoId', 'rejoinedAt'])
        .execute()
      if (memberRows.length > 0) {
        rejoinedAtMap = new Map(
          memberRows.map((r) => [r.convoId, r.rejoinedAt!]),
        )
      }
    }

    let filteredLogs = result.logs
    if (rejoinedAtMap) {
      filteredLogs = result.logs.filter((entry) => {
        const rejoinedAt = rejoinedAtMap!.get(entry.convoId)
        if (!rejoinedAt) return true
        // For message events, check the message sentAt
        const message = entry.message as
          | { sentAt?: string }
          | undefined
        if (message?.sentAt) {
          return new Date(message.sentAt) >= new Date(rejoinedAt)
        }
        // For non-message events, check the event rev timestamp.
        // TID revs encode a timestamp, so lexicographic comparison works:
        // events created after rejoin will have rev >= the rejoinedAt value.
        // However, rev is per-user not per-convo, so we fall back to
        // including non-message events (they don't leak content).
        return true
      })
    }

    const response: Record<string, unknown> = {
      logs: filteredLogs,
    }
    if (result.cursor) {
      response.cursor = result.cursor
    }

    res.json(response)
  }
}
