import express from 'express'
import { AppContext } from '../../../../context'

export default function (ctx: AppContext) {
  return async (req: express.Request, res: express.Response) => {
    // Authenticate: standard service auth
    const auth = await ctx.authVerifier.standard({ req })
    const callerDid = auth.credentials.did

    await ctx.services.account.deleteAccount(callerDid)

    res.json({})
  }
}
