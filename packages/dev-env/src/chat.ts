import * as plc from '@did-plc/lib'
import getPort from 'get-port'
import * as ui8 from 'uint8arrays'
import { Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { ChatService, ServerConfig, ServerSecrets } from '@atproto/chat'
import { ChatConfig } from './types'

export class TestChat {
  constructor(
    public url: string,
    public port: number,
    public server: ChatService,
    public serverDid: string,
  ) {}

  static async create(config: ChatConfig): Promise<TestChat> {
    const serviceKeypair =
      config.signingKey ??
      (await Secp256k1Keypair.create({ exportable: true }))
    const signingKeyHex = ui8.toString(await serviceKeypair.export(), 'hex')

    let serverDid = config.serverDid
    if (!serverDid) {
      serverDid = await createChatDid(config.plcUrl, serviceKeypair)
    }

    const port = config.port || (await getPort())
    const url = `http://localhost:${port}`

    const cfg: ServerConfig = {
      service: {
        port,
        did: serverDid,
        version: '0.0.0-test',
        devMode: true,
      },
      db: {
        postgresUrl: config.dbPostgresUrl,
        postgresSchema: config.dbPostgresSchema,
        poolSize: 5,
        poolMaxUses: Infinity,
        poolIdleTimeoutMs: 30000,
      },
      redis: null,
      identity: {
        plcUrl: config.plcUrl,
        resolverTimeout: 3000,
        cacheStaleTTL: 0,
        cacheMaxTTL: 0,
      },
      appview: config.appviewUrl && config.appviewDid
        ? {
            url: config.appviewUrl,
            did: config.appviewDid,
          }
        : null,
      modService: config.modServiceDid
        ? {
            url: config.modServiceUrl ?? '',
            did: config.modServiceDid,
          }
        : null,
      rateLimits: { enabled: false },
    }

    const secrets: ServerSecrets = { signingKeyHex }

    const server = await ChatService.create(cfg, secrets)
    await server.start()

    return new TestChat(url, port, server, serverDid)
  }

  get ctx() {
    return this.server.ctx
  }

  async close() {
    await this.server.destroy()
  }
}

export const createChatDid = async (
  plcUrl: string,
  keypair: Keypair,
): Promise<string> => {
  const plcClient = new plc.Client(plcUrl)
  const plcOp = await plc.signOperation(
    {
      type: 'plc_operation',
      alsoKnownAs: [],
      rotationKeys: [keypair.did()],
      verificationMethods: {
        atproto: keypair.did(),
      },
      services: {
        atproto_chat: {
          type: 'AtprotoChatService',
          endpoint: 'https://chat.public.url',
        },
      },
      prev: null,
    },
    keypair,
  )
  const did = await plc.didForCreateOp(plcOp)
  await plcClient.sendOperation(did, plcOp)
  return did
}
