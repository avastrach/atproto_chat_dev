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

  router.get('/.well-known/did.json', function (_req, res) {
    const did = ctx.cfg.service.did
    if (!did.startsWith('did:web:')) {
      res.status(404).send({ error: 'Not a did:web service' })
      return
    }
    res.json({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: ctx.signingKey.did().replace('did:key:', ''),
        },
      ],
      service: [
        {
          id: `${did}#bsky_chat`,
          type: 'BskyChatService',
          serviceEndpoint: `http://localhost:${ctx.cfg.service.port}`,
        },
      ],
    })
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
