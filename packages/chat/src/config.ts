export interface ServerConfig {
  service: ServiceConfig
  db: DatabaseConfig
  redis: RedisConfig | null
  identity: IdentityConfig
  appview: AppviewConfig | null
  modService: ModServiceConfig | null
  rateLimits: RateLimitsConfig
}

export interface ServiceConfig {
  port: number
  did: string
  version?: string
  devMode: boolean
}

export interface DatabaseConfig {
  postgresUrl: string
  postgresSchema?: string
  poolSize?: number
  poolMaxUses?: number
  poolIdleTimeoutMs?: number
}

export interface RedisConfig {
  address: string
  password?: string
}

export interface IdentityConfig {
  plcUrl: string
  resolverTimeout: number
  cacheStaleTTL: number
  cacheMaxTTL: number
}

export interface AppviewConfig {
  url: string
  did: string
}

export interface ModServiceConfig {
  url: string
  did: string
}

export type RateLimitsConfig =
  | {
      enabled: true
      bypassKey?: string
      bypassIps?: string[]
    }
  | { enabled: false }

export interface ServerSecrets {
  signingKeyHex: string
}
