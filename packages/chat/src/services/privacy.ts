import { AtpAgent } from '@atproto/api'
import { Database } from '../db'

export interface CanChatResult {
  canChat: boolean
  reason?: string
}

export interface BlockCheckResult {
  blocked: boolean
  /** Which direction the block is in, if any */
  direction?: 'caller-blocks-recipient' | 'recipient-blocks-caller' | 'both'
}

export interface FollowState {
  /** Whether the caller follows the recipient */
  callerFollowsRecipient: boolean
  /** Whether the recipient follows the caller */
  recipientFollowsCaller: boolean
}

/**
 * PrivacyService handles block and privacy checks for chat initiation.
 *
 * Integrates with the AppView graph API to:
 * - Check bilateral blocks (app.bsky.graph.getRelationships)
 * - Check follow graph (for allowIncoming = 'following')
 * - Check chatDisabled flags on local profile data
 * - Check allowIncoming settings on local actor_setting data
 */
export class PrivacyService {
  constructor(private appviewAgent?: AtpAgent) {}

  /**
   * Check whether the caller can initiate a conversation with the recipient.
   *
   * Returns { canChat: true } if chat is allowed, or { canChat: false, reason }
   * explaining why chat is not allowed.
   *
   * Check order (per PRD Section 17.7.1):
   * 1. Check if caller has chatDisabled
   * 2. Check if recipient has chatDisabled
   * 3. Check bilateral blocks via AppView graph API
   * 4. Check recipient's allowIncoming preference
   *    - 'all': allow
   *    - 'none': deny
   *    - 'following': check if recipient follows caller via AppView
   */
  async checkCanInitiateConvo(
    db: Database,
    callerDid: string,
    recipientDid: string,
  ): Promise<CanChatResult> {
    // 1. Check if the caller has chat disabled
    const callerProfile = await db.db
      .selectFrom('profile')
      .where('did', '=', callerDid)
      .select('chatDisabled')
      .executeTakeFirst()

    if (callerProfile?.chatDisabled) {
      return { canChat: false, reason: 'Account is disabled' }
    }

    // 2. Check if the recipient has chat disabled at the profile level
    const recipientProfile = await db.db
      .selectFrom('profile')
      .where('did', '=', recipientDid)
      .select('chatDisabled')
      .executeTakeFirst()

    if (recipientProfile?.chatDisabled) {
      return { canChat: false, reason: 'recipient has disabled incoming messages' }
    }

    // 3. Check bilateral blocks via AppView
    const blockResult = await this.isBlocked(callerDid, recipientDid)
    if (blockResult.blocked) {
      return {
        canChat: false,
        reason: 'block between recipient and sender',
      }
    }

    // 4. Check the recipient's allowIncoming setting
    const recipientSettings = await db.db
      .selectFrom('actor_setting')
      .where('did', '=', recipientDid)
      .select('allowIncoming')
      .executeTakeFirst()

    // Default to 'following' if no setting exists (privacy-safe default per PRD)
    const allowIncoming = recipientSettings?.allowIncoming ?? 'following'

    switch (allowIncoming) {
      case 'all':
        return { canChat: true }

      case 'none':
        return {
          canChat: false,
          reason: 'recipient has disabled incoming messages',
        }

      case 'following': {
        // Check if recipient follows caller via AppView
        const followState = await this.getFollowState(
          recipientDid,
          callerDid,
        )
        if (!followState.callerFollowsRecipient) {
          // In this context, "caller" is the recipient and "recipient" is the
          // original caller -- we're checking if the recipient follows the caller.
          return {
            canChat: false,
            reason:
              'recipient requires incoming messages to come from someone they follow',
          }
        }
        return { canChat: true }
      }

      default: {
        // Unknown allowIncoming value: default to 'following' behavior (per PRD)
        const followState = await this.getFollowState(
          recipientDid,
          callerDid,
        )
        if (!followState.callerFollowsRecipient) {
          return {
            canChat: false,
            reason:
              'recipient requires incoming messages to come from someone they follow',
          }
        }
        return { canChat: true }
      }
    }
  }

  /**
   * Check whether the caller can send a message to an existing conversation
   * member. This only checks the caller's chatDisabled flag and blocks --
   * NOT allowIncoming (which only applies to new conversation creation),
   * and NOT the recipient's chatDisabled (which only prevents the disabled
   * user from sending, not from receiving messages).
   *
   * Existing accepted conversations are unaffected by allowIncoming changes.
   */
  async checkCanSendToMember(
    db: Database,
    callerDid: string,
    recipientDid: string,
  ): Promise<CanChatResult> {
    // 1. Check if the caller has chat disabled (moderation action)
    const callerProfile = await db.db
      .selectFrom('profile')
      .where('did', '=', callerDid)
      .select('chatDisabled')
      .executeTakeFirst()

    if (callerProfile?.chatDisabled) {
      return { canChat: false, reason: 'Account is disabled' }
    }

    // 2. Check bilateral blocks via AppView
    const blockResult = await this.isBlocked(callerDid, recipientDid)
    if (blockResult.blocked) {
      return {
        canChat: false,
        reason: 'block between recipient and sender',
      }
    }

    return { canChat: true }
  }

  /**
   * Check if there is a block between two users (bidirectional).
   *
   * Uses the AppView app.bsky.graph.getRelationships API to check for blocks
   * in both directions with a single API call. Falls back to "not blocked"
   * if the AppView is unavailable (fail-open: a false negative is preferable
   * to silently dropping messages).
   *
   * Per PRD Section 17.7.2: blocks are bidirectional for messaging.
   * If Alice blocks Bob OR Bob blocks Alice, neither can send messages.
   */
  async isBlocked(
    callerDid: string,
    recipientDid: string,
  ): Promise<BlockCheckResult> {
    if (!this.appviewAgent) {
      // No AppView configured: fail open (not blocked)
      return { blocked: false }
    }

    try {
      // getRelationships returns the relationship from actor's perspective
      // to each DID in "others". We call it with callerDid as actor and
      // recipientDid as others[0]. This gives us:
      //   - blocking: callerDid blocks recipientDid
      //   - blockedBy: callerDid is blocked by recipientDid
      const response =
        await this.appviewAgent.api.app.bsky.graph.getRelationships({
          actor: callerDid,
          others: [recipientDid],
        })

      const rel = response.data.relationships?.[0]
      if (!rel) {
        return { blocked: false }
      }

      // Check if the relationship is a NotFoundActor (recipient doesn't exist)
      if ('notFound' in rel && (rel as { notFound: boolean }).notFound) {
        return { blocked: false }
      }

      // Extract block information from the typed Relationship
      const typedRel = rel as {
        blocking?: string
        blockedBy?: string
        blockingByList?: string
        blockedByList?: string
      }

      const callerBlocksRecipient = !!(
        typedRel.blocking || typedRel.blockingByList
      )
      const recipientBlocksCaller = !!(
        typedRel.blockedBy || typedRel.blockedByList
      )

      if (callerBlocksRecipient && recipientBlocksCaller) {
        return { blocked: true, direction: 'both' }
      }
      if (callerBlocksRecipient) {
        return { blocked: true, direction: 'caller-blocks-recipient' }
      }
      if (recipientBlocksCaller) {
        return { blocked: true, direction: 'recipient-blocks-caller' }
      }

      return { blocked: false }
    } catch {
      // AppView unavailable: fail open (not blocked).
      // A false negative (allowing a message through) is preferable to
      // a false positive (silently dropping legitimate messages).
      // Per PRD Section 17.7.2 circuit breaker pattern.
      return { blocked: false }
    }
  }

  /**
   * Get the follow relationship state between two users.
   *
   * Uses the AppView app.bsky.graph.getRelationships API.
   * Returns whether callerDid follows recipientDid and vice versa.
   *
   * Falls back to { callerFollowsRecipient: false, recipientFollowsCaller: false }
   * if the AppView is unavailable (fail closed: deny the message when we can't
   * verify the follow relationship, per PRD Section 17.7.1).
   */
  async getFollowState(
    callerDid: string,
    recipientDid: string,
  ): Promise<FollowState> {
    if (!this.appviewAgent) {
      // No AppView configured: fail closed (not following).
      // This is the safe default per PRD: a false negative (blocking a
      // legitimate message) is preferable to a false positive (letting
      // spam through).
      return {
        callerFollowsRecipient: false,
        recipientFollowsCaller: false,
      }
    }

    try {
      // getRelationships returns the relationship from actor's perspective
      // to each DID in "others".
      //   - following: callerDid follows recipientDid (AT-URI of follow record)
      //   - followedBy: callerDid is followed by recipientDid (AT-URI of follow record)
      const response =
        await this.appviewAgent.api.app.bsky.graph.getRelationships({
          actor: callerDid,
          others: [recipientDid],
        })

      const rel = response.data.relationships?.[0]
      if (!rel) {
        return {
          callerFollowsRecipient: false,
          recipientFollowsCaller: false,
        }
      }

      // Check if the relationship is a NotFoundActor
      if ('notFound' in rel && (rel as { notFound: boolean }).notFound) {
        return {
          callerFollowsRecipient: false,
          recipientFollowsCaller: false,
        }
      }

      const typedRel = rel as {
        following?: string
        followedBy?: string
      }

      return {
        callerFollowsRecipient: !!typedRel.following,
        recipientFollowsCaller: !!typedRel.followedBy,
      }
    } catch {
      // AppView unavailable: fail closed (not following).
      // This is the safe default: a false negative (blocking a legitimate
      // message) is preferable to a false positive (letting spam through).
      return {
        callerFollowsRecipient: false,
        recipientFollowsCaller: false,
      }
    }
  }
}
