import express from 'express'
import { AppContext } from '../context'
import getConvoForMembers from './chat/bsky/convo/getConvoForMembers'
import getConvo from './chat/bsky/convo/getConvo'
import listConvos from './chat/bsky/convo/listConvos'
import acceptConvo from './chat/bsky/convo/acceptConvo'
import leaveConvo from './chat/bsky/convo/leaveConvo'
import getConvoAvailability from './chat/bsky/convo/getConvoAvailability'
import sendMessage from './chat/bsky/convo/sendMessage'
import sendMessageBatch from './chat/bsky/convo/sendMessageBatch'
import getMessages from './chat/bsky/convo/getMessages'
import getLog from './chat/bsky/convo/getLog'
import deleteMessageForSelf from './chat/bsky/convo/deleteMessageForSelf'
import updateRead from './chat/bsky/convo/updateRead'
import updateAllRead from './chat/bsky/convo/updateAllRead'
import addReaction from './chat/bsky/convo/addReaction'
import removeReaction from './chat/bsky/convo/removeReaction'
import muteConvo from './chat/bsky/convo/muteConvo'
import unmuteConvo from './chat/bsky/convo/unmuteConvo'
import getActorMetadata from './chat/bsky/moderation/getActorMetadata'
import getMessageContext from './chat/bsky/moderation/getMessageContext'
import updateActorAccess from './chat/bsky/moderation/updateActorAccess'
import deleteAccount from './chat/bsky/actor/deleteAccount'
import exportAccountData from './chat/bsky/actor/exportAccountData'
import {
  getDeclaration,
  updateDeclaration,
} from './chat/bsky/actor/declaration'

export function createRouter(ctx: AppContext): express.Router {
  const router = express.Router()

  // JSON body parsing for POST (procedure) endpoints
  router.use(express.json())

  // Query (GET) endpoints
  router.get(
    '/xrpc/chat.bsky.convo.getConvoForMembers',
    getConvoForMembers(ctx),
  )
  router.get('/xrpc/chat.bsky.convo.getConvo', getConvo(ctx))
  router.get('/xrpc/chat.bsky.convo.listConvos', listConvos(ctx))
  router.get(
    '/xrpc/chat.bsky.convo.getConvoAvailability',
    getConvoAvailability(ctx),
  )
  router.get('/xrpc/chat.bsky.convo.getMessages', getMessages(ctx))
  router.get('/xrpc/chat.bsky.convo.getLog', getLog(ctx))

  // Procedure (POST) endpoints
  router.post('/xrpc/chat.bsky.convo.acceptConvo', acceptConvo(ctx))
  router.post('/xrpc/chat.bsky.convo.leaveConvo', leaveConvo(ctx))
  router.post('/xrpc/chat.bsky.convo.sendMessage', sendMessage(ctx))
  router.post(
    '/xrpc/chat.bsky.convo.sendMessageBatch',
    sendMessageBatch(ctx),
  )
  router.post(
    '/xrpc/chat.bsky.convo.deleteMessageForSelf',
    deleteMessageForSelf(ctx),
  )
  router.post('/xrpc/chat.bsky.convo.updateRead', updateRead(ctx))
  router.post('/xrpc/chat.bsky.convo.updateAllRead', updateAllRead(ctx))
  router.post('/xrpc/chat.bsky.convo.addReaction', addReaction(ctx))
  router.post('/xrpc/chat.bsky.convo.removeReaction', removeReaction(ctx))
  router.post('/xrpc/chat.bsky.convo.muteConvo', muteConvo(ctx))
  router.post('/xrpc/chat.bsky.convo.unmuteConvo', unmuteConvo(ctx))

  // Moderation endpoints (mod service auth)
  router.get(
    '/xrpc/chat.bsky.moderation.getActorMetadata',
    getActorMetadata(ctx),
  )
  router.get(
    '/xrpc/chat.bsky.moderation.getMessageContext',
    getMessageContext(ctx),
  )
  router.post(
    '/xrpc/chat.bsky.moderation.updateActorAccess',
    updateActorAccess(ctx),
  )

  // Actor endpoints (standard auth)
  router.post('/xrpc/chat.bsky.actor.deleteAccount', deleteAccount(ctx))
  router.get('/xrpc/chat.bsky.actor.exportAccountData', exportAccountData(ctx))
  router.get('/xrpc/chat.bsky.actor.declaration', getDeclaration(ctx))
  router.post(
    '/xrpc/chat.bsky.actor.updateDeclaration',
    updateDeclaration(ctx),
  )

  return router
}

export default function (ctx: AppContext) {
  return ctx
}
