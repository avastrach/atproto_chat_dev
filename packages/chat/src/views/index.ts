import { Database } from '../db'
import { ProfileSyncService } from '../services/profile-sync'

// Row type for a profile row after selection (Generated<T> resolves to T)
export interface ProfileRow {
  did: string
  handle: string | null
  displayName: string | null
  avatar: string | null
  chatDisabled: boolean
  updatedAt: string
}

// Types matching lexicon definitions

export interface ProfileViewBasic {
  $type: 'chat.bsky.actor.defs#profileViewBasic'
  did: string
  handle?: string
  displayName?: string
  avatar?: string
  chatDisabled?: boolean
}

export interface MessageViewSender {
  did: string
}

export interface ReactionView {
  $type: 'chat.bsky.convo.defs#reactionView'
  value: string
  sender: { did: string }
  createdAt: string
}

export interface MessageView {
  $type: 'chat.bsky.convo.defs#messageView'
  id: string
  rev: string
  text: string
  facets?: unknown[]
  embed?: unknown
  reactions?: ReactionView[]
  sender: MessageViewSender
  sentAt: string
}

export interface DeletedMessageView {
  $type: 'chat.bsky.convo.defs#deletedMessageView'
  id: string
  rev: string
  sender: MessageViewSender
  sentAt: string
}

export interface ConvoView {
  id: string
  rev: string
  members: ProfileViewBasic[]
  lastMessage?: MessageView | DeletedMessageView
  muted: boolean
  status?: 'request' | 'accepted'
  unreadCount: number
}

/**
 * Row shape returned from the message table query.
 */
export interface MessageRow {
  id: string
  convoId: string
  senderDid: string
  text: string | null
  facets: string | null
  embed: string | null
  rev: string
  sentAt: string
  deletedAt: string | null
}

/**
 * Row shape returned from the reaction table query.
 */
export interface ReactionRow {
  id: string
  convoId: string
  messageId: string
  senderDid: string
  value: string
  createdAt: string
}

export class ViewBuilder {
  private profileSync?: ProfileSyncService

  /**
   * Set the ProfileSyncService used for on-demand profile refresh in
   * buildConvoView(). Called once during AppContext initialisation.
   */
  setProfileSyncService(svc: ProfileSyncService): void {
    this.profileSync = svc
  }

  /**
   * Build a chat.bsky.actor.defs#profileViewBasic from a profile database row.
   *
   * Per errata E6: $type MUST be 'chat.bsky.actor.defs#profileViewBasic'
   * (not 'app.bsky.actor.defs#profileViewBasic').
   */
  buildProfileViewBasic(profile: ProfileRow): ProfileViewBasic {
    const view: ProfileViewBasic = {
      $type: 'chat.bsky.actor.defs#profileViewBasic',
      did: profile.did,
    }
    if (profile.handle) {
      view.handle = profile.handle
    }
    if (profile.displayName) {
      view.displayName = profile.displayName
    }
    if (profile.avatar) {
      view.avatar = profile.avatar
    }
    if (profile.chatDisabled) {
      view.chatDisabled = profile.chatDisabled
    }
    return view
  }

  /**
   * Build a complete ConvoView for a given conversation and caller.
   *
   * Includes:
   * - All members' profile views
   * - The last message (if any, with deleted message handling)
   * - The caller's read state (muted, unreadCount, status)
   * - The conversation rev
   */
  async buildConvoView(
    db: Database,
    convoId: string,
    callerDid: string,
  ): Promise<ConvoView> {
    // Get the conversation record
    const convo = await db.db
      .selectFrom('conversation')
      .where('id', '=', convoId)
      .selectAll()
      .executeTakeFirstOrThrow()

    // Get all members (including left members, as they still appear in the member list)
    const memberRows = await db.db
      .selectFrom('conversation_member')
      .where('convoId', '=', convoId)
      .selectAll()
      .execute()

    // Get the caller's membership row
    const callerMember = memberRows.find((m) => m.memberDid === callerDid)
    if (!callerMember) {
      throw new Error('Caller is not a member of this conversation')
    }

    // Get all member DIDs
    const memberDids = memberRows.map((m) => m.memberDid)

    // Refresh member profiles from AppView if stale or missing
    if (this.profileSync) {
      await Promise.all(
        memberDids.map((did) => this.profileSync!.ensureProfile(db, did)),
      )
    }

    // Fetch profiles for all members (now guaranteed fresh)
    const profiles = await db.db
      .selectFrom('profile')
      .where('did', 'in', memberDids)
      .selectAll()
      .execute()

    // Build a map of DID -> Profile for quick lookup
    const profileMap = new Map(profiles.map((p) => [p.did, p]))

    // Build member profile views
    const members: ProfileViewBasic[] = memberDids.map((did) => {
      const profile = profileMap.get(did)
      if (profile) {
        return this.buildProfileViewBasic(profile)
      }
      // Fallback for members without a cached profile
      return {
        $type: 'chat.bsky.actor.defs#profileViewBasic' as const,
        did,
      }
    })

    // Build lastMessage view (if conversation has messages)
    let lastMessage: MessageView | DeletedMessageView | undefined
    if (convo.lastMessageId) {
      const msg = await db.db
        .selectFrom('message')
        .where('convoId', '=', convoId)
        .where('id', '=', convo.lastMessageId)
        .selectAll()
        .executeTakeFirst()

      if (msg) {
        if (msg.deletedAt) {
          lastMessage = {
            $type: 'chat.bsky.convo.defs#deletedMessageView',
            id: msg.id,
            rev: msg.rev,
            sender: { did: msg.senderDid },
            sentAt: msg.sentAt,
          }
        } else {
          lastMessage = {
            $type: 'chat.bsky.convo.defs#messageView',
            id: msg.id,
            rev: msg.rev,
            text: msg.text ?? '',
            sender: { did: msg.senderDid },
            sentAt: msg.sentAt,
          }
          if (msg.facets) {
            lastMessage.facets =
              typeof msg.facets === 'string'
                ? JSON.parse(msg.facets)
                : msg.facets
          }
          if (msg.embed) {
            lastMessage.embed =
              typeof msg.embed === 'string'
                ? JSON.parse(msg.embed)
                : msg.embed
          }
        }
      }
    }

    return {
      id: convo.id,
      rev: convo.rev,
      members,
      lastMessage,
      muted: callerMember.muted,
      status: callerMember.status === 'left' ? undefined : callerMember.status,
      unreadCount: callerMember.unreadCount,
    }
  }

  /**
   * Build a chat.bsky.convo.defs#messageView from a message row and optional reactions.
   */
  buildMessageView(message: MessageRow, reactions?: ReactionRow[]): MessageView {
    const view: MessageView = {
      $type: 'chat.bsky.convo.defs#messageView',
      id: message.id,
      rev: message.rev,
      text: message.text ?? '',
      sender: { did: message.senderDid },
      sentAt: message.sentAt,
    }
    if (message.facets) {
      view.facets =
        typeof message.facets === 'string'
          ? JSON.parse(message.facets)
          : message.facets
    }
    if (message.embed) {
      view.embed =
        typeof message.embed === 'string'
          ? JSON.parse(message.embed)
          : message.embed
    }
    if (reactions && reactions.length > 0) {
      view.reactions = reactions.map((r) => ({
        $type: 'chat.bsky.convo.defs#reactionView' as const,
        value: r.value,
        sender: { did: r.senderDid },
        createdAt: r.createdAt,
      }))
    }
    return view
  }

  /**
   * Build a chat.bsky.convo.defs#deletedMessageView from a message row.
   */
  buildDeletedMessageView(message: MessageRow): DeletedMessageView {
    return {
      $type: 'chat.bsky.convo.defs#deletedMessageView',
      id: message.id,
      rev: message.rev,
      sender: { did: message.senderDid },
      sentAt: message.sentAt,
    }
  }
}
