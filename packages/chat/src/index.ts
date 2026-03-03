// catch errors that get thrown in async route handlers
// this is a relatively non-invasive change to express
// they get handled in the error.handler middleware
// leave at top of file before importing Routes
import 'express-async-errors'

import events from 'node:events'
import http from 'node:http'
import compression from 'compression'
import cors from 'cors'
import express from 'express'
import { HttpTerminator, createHttpTerminator } from 'http-terminator'
import { DAY, SECOND } from '@atproto/common'
import { createRouter as createApiRouter } from './api'
import * as basicRoutes from './basic-routes'
import { ServerConfig, ServerSecrets } from './config'
import { AppContext } from './context'
import * as error from './error'
import { loggerMiddleware } from './logger'
import { createRateLimiterMiddleware } from './rate-limiter'

export * from './config'
export { AppContext } from './context'
export { Database } from './db'
export { httpLogger } from './logger'
export { ChatRepoSubscription } from './subscription'

export class ChatService {
  public ctx: AppContext
  public app: express.Application
  public server?: http.Server
  private terminator?: HttpTerminator

  constructor(opts: { ctx: AppContext; app: express.Application }) {
    this.ctx = opts.ctx
    this.app = opts.app
  }

  static async create(
    cfg: ServerConfig,
    secrets: ServerSecrets,
  ): Promise<ChatService> {
    const ctx = await AppContext.fromConfig(cfg, secrets)

    const app = express()
    app.set('trust proxy', true)
    app.use(loggerMiddleware)
    app.use(compression())
    app.use(cors({ maxAge: DAY / SECOND }))
    app.use(basicRoutes.createRouter(ctx))
    app.use(createRateLimiterMiddleware(ctx))
    app.use(createApiRouter(ctx))
    app.use(error.handler)

    return new ChatService({
      ctx,
      app,
    })
  }

  async start(): Promise<http.Server> {
    const server = this.app.listen(this.ctx.cfg.service.port)
    this.server = server
    this.server.keepAliveTimeout = 90000
    this.terminator = createHttpTerminator({ server })
    await events.once(server, 'listening')
    // Start firehose subscription if configured
    this.ctx.subscription?.start()
    return server
  }

  async destroy(): Promise<void> {
    // Stop firehose subscription before tearing down other resources
    await this.ctx.subscription?.destroy()
    await this.terminator?.terminate()
    await this.ctx.redis?.quit()
    await this.ctx.db.close()
  }
}

export default ChatService
