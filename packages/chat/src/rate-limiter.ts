import express from 'express'
import { Redis } from 'ioredis'
import { subsystemLogger } from '@atproto/common'
import { XRPCError } from '@atproto/xrpc-server'
import { AppContext } from './context'
import { RateLimitsConfig } from './config'

const logger = subsystemLogger('chat:rate-limiter')

// ---------------------------------------------------------------------------
// Default per-endpoint rate limits
// ---------------------------------------------------------------------------

export interface EndpointLimit {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number
  /** Window duration in seconds. */
  windowSec: number
}

/**
 * Per-endpoint limits keyed by the last segment of the NSID
 * (e.g. "sendMessage", "getMessages").  Endpoints not listed here fall
 * through to the `default` bucket.
 */
const ENDPOINT_LIMITS: Record<string, EndpointLimit> = {
  sendMessage: { maxRequests: 60, windowSec: 60 },
  sendMessageBatch: { maxRequests: 30, windowSec: 60 },
  getMessages: { maxRequests: 120, windowSec: 60 },
  default: { maxRequests: 300, windowSec: 60 },
}

// ---------------------------------------------------------------------------
// Sliding-window counter via Redis
// ---------------------------------------------------------------------------

/**
 * Lua script implementing a sliding-window counter.
 *
 * KEYS[1] = the rate-limit key
 * ARGV[1] = current timestamp in milliseconds
 * ARGV[2] = window size in milliseconds
 * ARGV[3] = maximum allowed requests in the window
 *
 * Returns: [allowed (0|1), currentCount, ttlMs]
 *
 * The script uses a sorted set where each member is a unique request id
 * (timestamp + random suffix) and the score is the timestamp.  On every
 * call it:
 *   1. Removes entries older than (now - window).
 *   2. Counts the remaining entries.
 *   3. If under the limit, adds the new entry and sets a TTL on the key.
 *   4. Returns whether the request is allowed, the current count, and
 *      how many milliseconds until the window resets.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- Remove entries outside the current window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count remaining entries
local count = redis.call('ZCARD', key)

if count < limit then
  -- Add this request (member must be unique - append a random suffix)
  redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
  redis.call('PEXPIRE', key, window)
  return {1, count + 1, window}
else
  -- Determine how long until the oldest entry in the window expires
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local ttl = 0
  if #oldest >= 2 then
    ttl = tonumber(oldest[2]) + window - now
    if ttl < 0 then ttl = 0 end
  end
  return {0, count, ttl}
end
`

interface SlidingWindowResult {
  allowed: boolean
  currentCount: number
  retryAfterMs: number
}

async function checkSlidingWindow(
  redis: Redis,
  key: string,
  limit: EndpointLimit,
): Promise<SlidingWindowResult> {
  const now = Date.now()
  const windowMs = limit.windowSec * 1000

  const result = (await redis.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    key,
    String(now),
    String(windowMs),
    String(limit.maxRequests),
  )) as [number, number, number]

  return {
    allowed: result[0] === 1,
    currentCount: result[1],
    retryAfterMs: result[2],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the short method name from an XRPC path.
 * e.g. "/xrpc/chat.bsky.convo.sendMessage" -> "sendMessage"
 */
function endpointName(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1] ?? 'default'
}

/**
 * Returns the rate-limit tier for a given endpoint short name.
 */
function limitsForEndpoint(name: string): EndpointLimit {
  return ENDPOINT_LIMITS[name] ?? ENDPOINT_LIMITS['default']
}

/**
 * Attempts to extract the requester DID from the Authorization header
 * without performing full JWT verification (that happens later in the
 * route handler).  We decode the JWT payload to read `sub` or `iss`.
 *
 * If the token is missing or unparseable we fall back to the client IP
 * so that rate limiting still applies to unauthenticated or malformed
 * requests.
 */
function extractRequesterKey(req: express.Request): string {
  const authHeader = req.headers.authorization ?? ''
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const payloadB64 = token.split('.')[1]
      if (payloadB64) {
        const payload = JSON.parse(
          Buffer.from(payloadB64, 'base64url').toString('utf-8'),
        )
        const did: unknown = payload.sub ?? payload.iss
        if (typeof did === 'string' && did.startsWith('did:')) {
          return did
        }
      }
    } catch {
      // fall through to IP-based key
    }
  }
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`
}

// ---------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express middleware that enforces per-user, per-endpoint rate
 * limits using a sliding-window counter stored in Redis.
 *
 * Behaviour when rate limiting cannot be applied (Redis unavailable or
 * config disabled):
 *   - If `rateLimits.enabled` is `false`, the middleware is a no-op.
 *   - If Redis is `undefined` (not configured), requests pass through
 *     with a warning logged once.
 *   - If a Redis command fails at runtime, the request is allowed through
 *     (fail-open) and the error is logged.
 */
export function createRateLimiterMiddleware(
  ctx: AppContext,
): express.RequestHandler {
  const cfg: RateLimitsConfig = ctx.cfg.rateLimits

  // Rate limiting disabled - return a no-op middleware.
  if (!cfg.enabled) {
    return (_req, _res, next) => next()
  }

  const redis = ctx.redis
  let warnedNoRedis = false

  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    // Only apply to XRPC routes
    if (!req.path.startsWith('/xrpc/')) {
      return next()
    }

    // Check bypass key (sent as x-ratelimit-bypass header)
    if (cfg.enabled && cfg.bypassKey) {
      const headerVal = req.headers['x-ratelimit-bypass']
      if (headerVal === cfg.bypassKey) {
        return next()
      }
    }

    // Check bypass IPs
    if (cfg.enabled && cfg.bypassIps?.length) {
      const clientIp = req.ip ?? req.socket.remoteAddress
      if (clientIp && cfg.bypassIps.includes(clientIp)) {
        return next()
      }
    }

    // No Redis available - fail open with a warning
    if (!redis) {
      if (!warnedNoRedis) {
        logger.warn(
          'rate limiting is enabled but Redis is not configured - skipping rate limit checks',
        )
        warnedNoRedis = true
      }
      return next()
    }

    const method = endpointName(req.path)
    const limit = limitsForEndpoint(method)
    const requesterKey = extractRequesterKey(req)
    const redisKey = `ratelimit:${requesterKey}:${method}:${limit.windowSec}`

    try {
      const result = await checkSlidingWindow(redis, redisKey, limit)

      // Always set informational headers
      const resetAtSec = Math.ceil((Date.now() + result.retryAfterMs) / 1000)
      res.setHeader('RateLimit-Limit', limit.maxRequests)
      res.setHeader(
        'RateLimit-Remaining',
        Math.max(0, limit.maxRequests - result.currentCount),
      )
      res.setHeader('RateLimit-Reset', resetAtSec)
      res.setHeader(
        'RateLimit-Policy',
        `${limit.maxRequests};w=${limit.windowSec}`,
      )

      if (!result.allowed) {
        const retryAfterSec = Math.ceil(result.retryAfterMs / 1000)
        res.setHeader('Retry-After', retryAfterSec)

        const error = new XRPCError(
          429,
          'Rate Limit Exceeded',
          'RateLimitExceeded',
        )
        return res.status(429).json(error.payload)
      }

      return next()
    } catch (err) {
      // Fail open - if Redis is down we do not block requests
      logger.error({ err, redisKey }, 'rate limiter error - allowing request')
      return next()
    }
  }
}
