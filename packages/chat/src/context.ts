import { Redis } from 'ioredis'
import { AtpAgent } from '@atproto/api'
import * as crypto from '@atproto/crypto'
import { IdResolver } from '@atproto/identity'
import { AuthVerifier } from './auth-verifier'
import { ServerConfig, ServerSecrets } from './config'
import { Database } from './db'
import { getRedisClient } from './redis'
import { AccountService, ConversationService, EventLogService, MessageService, ModerationService, PrivacyService, ProfileSyncService, ReadStateService } from './services'
import { ChatRepoSubscription } from './subscription'
import { ViewBuilder } from './views'

export interface Services {
  eventLog: EventLogService
  viewBuilder: ViewBuilder
  privacy: PrivacyService
  profileSync: ProfileSyncService
  conversation: ConversationService
  message: MessageService
  readState: ReadStateService
  moderation: ModerationService
  account: AccountService
}

export interface AppContextOptions {
  db: Database
  redis: Redis | undefined
  cfg: ServerConfig
  idResolver: IdResolver
  signingKey: crypto.Keypair
  authVerifier: AuthVerifier
  appviewAgent: AtpAgent | undefined
  services: Services
  subscription?: ChatRepoSubscription
}

export class AppContext {
  public db: Database
  public redis: Redis | undefined
  public cfg: ServerConfig
  public idResolver: IdResolver
  public signingKey: crypto.Keypair
  public authVerifier: AuthVerifier
  public appviewAgent: AtpAgent | undefined
  public services: Services
  public subscription?: ChatRepoSubscription

  constructor(opts: AppContextOptions) {
    this.db = opts.db
    this.redis = opts.redis
    this.cfg = opts.cfg
    this.idResolver = opts.idResolver
    this.signingKey = opts.signingKey
    this.authVerifier = opts.authVerifier
    this.appviewAgent = opts.appviewAgent
    this.services = opts.services
    this.subscription = opts.subscription
  }

  static async fromConfig(
    cfg: ServerConfig,
    secrets: ServerSecrets,
  ): Promise<AppContext> {
    const db = Database.create({
      url: cfg.db.postgresUrl,
      schema: cfg.db.postgresSchema,
      poolSize: cfg.db.poolSize,
      poolMaxUses: cfg.db.poolMaxUses,
      poolIdleTimeoutMs: cfg.db.poolIdleTimeoutMs,
    })

    await db.migrateToLatestOrThrow()

    const redis = cfg.redis
      ? getRedisClient(cfg.redis.address, cfg.redis.password)
      : undefined

    const idResolver = new IdResolver({
      plcUrl: cfg.identity.plcUrl,
      timeout: cfg.identity.resolverTimeout,
    })

    const signingKey = await crypto.Secp256k1Keypair.import(
      secrets.signingKeyHex,
    )

    const authVerifier = new AuthVerifier({
      serviceDid: cfg.service.did,
      idResolver,
      modServiceDid: cfg.modService?.did,
    })

    // Initialize AppView agent for graph queries (blocks, follows)
    const appviewAgent = cfg.appview
      ? new AtpAgent({ service: cfg.appview.url })
      : undefined

    // Initialize services
    const eventLog = new EventLogService()
    const viewBuilder = new ViewBuilder()
    const privacy = new PrivacyService(appviewAgent)
    const profileSync = new ProfileSyncService(appviewAgent)

    // Wire profile sync into the view builder so buildConvoView can
    // refresh stale / missing member profiles on the fly.
    viewBuilder.setProfileSyncService(profileSync)

    // Wire AppView agent into the view builder for embed hydration
    if (appviewAgent) {
      viewBuilder.setAppviewAgent(appviewAgent)
    }

    const conversation = new ConversationService(
      db,
      eventLog,
      viewBuilder,
      privacy,
    )
    const message = new MessageService(db, eventLog, viewBuilder, privacy)
    const readState = new ReadStateService(db, eventLog, viewBuilder)
    const moderation = new ModerationService(db, viewBuilder)
    const account = new AccountService(db, eventLog, viewBuilder)

    const services: Services = {
      eventLog,
      viewBuilder,
      privacy,
      profileSync,
      conversation,
      message,
      readState,
      moderation,
      account,
    }

    // Create firehose subscription if repoProvider is configured
    const subscription = cfg.service.repoProvider
      ? new ChatRepoSubscription({
          service: cfg.service.repoProvider,
          db,
          idResolver,
        })
      : undefined

    return new AppContext({
      db,
      redis,
      cfg,
      idResolver,
      signingKey,
      authVerifier,
      appviewAgent,
      services,
      subscription,
    })
  }
}

export default AppContext
