import express from 'express'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: standard service auth
    const auth = await ctx.authVerifier.standard({ req })
    const callerDid = auth.credentials.did

    // Set streaming JSONL response headers
    res.setHeader('Content-Type', 'application/jsonl')
    res.setHeader('Transfer-Encoding', 'chunked')

    // Stream each line using the Express response write
    const writeLine = (obj: Record<string, unknown>) => {
      res.write(JSON.stringify(obj) + '\n')
    }

    await ctx.services.account.exportAccountData(callerDid, writeLine)

    res.end()
  }
}
