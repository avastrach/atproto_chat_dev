import { IncomingMessage } from 'node:http'
import { stdSerializers } from 'pino'
import { pinoHttp } from 'pino-http'
import { obfuscateHeaders, subsystemLogger } from '@atproto/common'

export const dbLogger: ReturnType<typeof subsystemLogger> =
  subsystemLogger('chat:db')
export const redisLogger: ReturnType<typeof subsystemLogger> =
  subsystemLogger('chat:redis')
export const httpLogger: ReturnType<typeof subsystemLogger> =
  subsystemLogger('chat')

export const loggerMiddleware = pinoHttp({
  logger: httpLogger,
  serializers: {
    err: (err: unknown) => ({
      code: err?.['code'],
      message: err?.['message'],
    }),
    req: (req: IncomingMessage) => {
      const serialized = stdSerializers.req(req)
      const headers = obfuscateHeaders(serialized.headers)
      return { ...serialized, headers }
    },
  },
})
