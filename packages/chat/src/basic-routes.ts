import { Router } from 'express'
import { sql } from 'kysely'
import { AppContext } from './context'

export const createRouter = (ctx: AppContext): Router => {
  const router = Router()

  router.get('/', function (_req, res) {
    res.type('text/plain')
    res.send(
      'AT Protocol Chat Service\n\nMost API routes are under /xrpc/\n',
    )
  })

  router.get('/robots.txt', function (_req, res) {
    res.type('text/plain')
    res.send(
      '# Hello!\n\nUser-agent: *\nDisallow: /',
    )
  })

  router.get('/xrpc/_health', async function (req, res) {
    const { version } = ctx.cfg.service
    try {
      await sql`select 1`.execute(ctx.db.db)
    } catch (err) {
      req.log.error({ err }, 'failed health check')
      res.status(503).send({ version: version ?? '0.0.0', error: 'Service Unavailable' })
      return
    }
    res.send({ version: version ?? '0.0.0' })
  })

  return router
}
