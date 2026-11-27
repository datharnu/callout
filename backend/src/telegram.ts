// Telegram in (group messages + edits) and out (receipts).
import { Bot, webhookCallback, type Context } from 'grammy'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { requireEnv } from './env.js'
import { ingest } from './pipeline.js'
import { linkedTo, owner, redeemPairCode } from './sandbox.js'
import { judgesPaused } from './pause.js'
import { audit } from './store.js'
import { config } from './config.js'
import type { Card, IncomingMessage } from './types.js'
import { handlePrivate } from './tg-private.js'
import { hiddenLinks } from './tg-util.js'
import { notePairFailure, pairTriesLeft } from './pair-guard.js'

export const bot = new Bot(requireEnv('TELEGRAM_BOT_TOKEN'))

function toIncoming(ctx: Context, edited: boolean): IncomingMessage | undefined {
  const m = ctx.msg
  if (!m) return undefined
  const links = hiddenLinks(m)
  const sender = m.sender_chat
    ? { id: String(m.sender_chat.id), name: 'title' in m.sender_chat ? (m.sender_chat.title ?? '') : '' }
    : m.from
      ? { id: String(m.from.id), name: m.from.username ? `@${m.from.username}` : m.from.first_name }
      : undefined
  if (!sender) return undefined
  return {
    chatId: String(m.chat.id),
    chatTitle: 'title' in m.chat ? (m.chat.title ?? '') : '',
    messageId: m.message_id,
    senderId: sender.id,
    senderName: sender.name,
    text: m.text ?? m.caption ?? '',
    sentAt: m.date * 1000,
    ...(edited && m.edit_date ? { editedAt: m.edit_date * 1000 } : {}),
    ...(links.length ? { links } : {}),
    source: 'telegram',
  }
}

/** The group judges join (title read from Telegram at startup; invite link from .env). */
export const group: { title: string; inviteUrl?: string } = { title: '', inviteUrl: process.env.TELEGRAM_GROUP_INVITE_URL?.trim() || undefined }

/** `/pair 123456` (also `/pair@CalloutBot 123456`) in an allowlisted group links the sender to a judge session. */
async function handlePair(ctx: Context, msg: IncomingMessage): Promise<boolean> {
  const m = msg.text.trim().match(/^\/pair(?:@\w+)?\s+(\d{6})\b/i)
  if (!m || !config.allowedChatIds.has(msg.chatId)) return false
  const who = `${msg.chatId}:${msg.senderId}`
  if (pairTriesLeft(who) <= 0) {
    audit('pair_locked', { chatId: msg.chatId, senderId: msg.senderId })
    await ctx.reply('Too many wrong codes. Please wait 10 minutes, then get a fresh code.', {
      reply_parameters: { message_id: msg.messageId, allow_sending_without_reply: true },
    }).catch(() => {})
    return true
  }
  if (judgesPaused()) {
    await ctx.reply('Callout judge sessions are paused right now. Please check back later.', {
      reply_parameters: { message_id: msg.messageId, allow_sending_without_reply: true },
    }).catch(() => {})
    return true
  }
  const sb = redeemPairCode(m[1]!, msg.senderId, msg.senderName)
  if (!sb) notePairFailure(who)
  audit('pair', { chatId: msg.chatId, senderId: msg.senderId, ok: !!sb, sandbox: sb?.id })
  await ctx.reply(
    sb
      ? `Linked ${msg.senderName || 'you'} to a Callout judge session. Post a call here (for example "LONG BTC entry 60.5k SL 59.3k TP 62.9k") and it appears on your glasses. Demo money only.`
      : 'That code did not match or has expired. Get a new one on the Callout "Try it" page.',
    { reply_parameters: { message_id: msg.messageId, allow_sending_without_reply: true } },
  ).catch(() => {})
  return true
}

function handle(edited: boolean) {
  return async (ctx: Context) => {
    // Private chat with the bot: read-only checks, your summary and your own settings (tg-private.ts).
    if (ctx.chat?.type === 'private') {
      if (!edited) await handlePrivate(ctx)
      return
    }
    const msg = toIncoming(ctx, edited)
    if (!msg) return
    if (!edited && (await handlePair(ctx, msg))) return
    // The owner's sandbox sees every message (its allowlist decides), plus any judge session linked to the sender.
    for (const sb of [owner, ...(judgesPaused() ? [] : linkedTo(msg.senderId))]) {
      const r = await ingest(msg, sb)
      if (r.outcome === 'card') {
        console.log(`[card] ${sb.id} ${r.card.id} ${r.card.state}${r.card.flags.length ? ` (${r.card.flags.join(', ')})` : ''}`)
      }
    }
  }
}

// Telegram may re-deliver an update (e.g. while a sleeping server wakes up): handle each update once.
const seenUpdates = new Set<number>()
bot.use(async (ctx, next) => {
  const id = ctx.update.update_id
  if (seenUpdates.has(id)) return
  seenUpdates.add(id)
  if (seenUpdates.size > 5000) seenUpdates.delete(seenUpdates.values().next().value!)
  await next()
})

bot.on(['message', 'channel_post'], handle(false))
bot.on(['edited_message', 'edited_channel_post'], handle(true))
bot.catch(err => console.error('[telegram] handler error:', err.error))

/** Returns true only if a message was actually delivered to Telegram. */
export async function sendReceipt(card: Card): Promise<boolean> {
  if (card.msg.source !== 'telegram') return false // replayed demo messages have no real thread to reply to
  const o = card.order!
  // Last 8 characters: the form Bybit's Order History shows, so the receipt matches the exchange.
  const short = o.orderId.length > 8 ? `...${o.orderId.slice(-8)}` : o.orderId
  const text = [
    'Callout receipt · Bybit Demo (not real money)',
    `${o.kind === 'close' ? 'Closed (reduce-only) ' : ''}${card.parsed!.symbol} ${o.side} ${o.qty} @ ${Number(o.avgPrice).toLocaleString('en-US')}`,
    `Order ${short}`,
    'Placed after the user confirmed on their glasses. Not financial advice.',
  ].join('\n')
  await bot.api.sendMessage(Number(card.msg.chatId), text, {
    reply_parameters: { message_id: card.msg.messageId, allow_sending_without_reply: true },
  })
  return true
}

const ALLOWED = ['message', 'edited_message', 'channel_post', 'edited_channel_post'] as const
/** Webhook mode (free hosting that sleeps): Telegram calls us, which also wakes the server. */
export const webhookMode = process.env.CALLOUT_TELEGRAM_MODE === 'webhook'
const WEBHOOK_PATH = '/api/telegram/hook'
// Derived from the bot token (no extra secret to manage); Telegram sends it back on every call.
const webhookSecret = createHash('sha256').update(`callout-webhook:${requireEnv('TELEGRAM_BOT_TOKEN')}`).digest('hex').slice(0, 48)

export function registerTelegramWebhook(app: FastifyInstance) {
  // Respond within Telegram's window even if parsing is slow; processing continues in the background.
  app.post(WEBHOOK_PATH, webhookCallback(bot, 'fastify', { secretToken: webhookSecret, onTimeout: 'return', timeoutMilliseconds: 8000 }))
}

export async function startTelegram(): Promise<void> {
  const me = await bot.api.getMe()
  const chatId = [...config.allowedChatIds][0]
  if (chatId) group.title = await bot.api.getChat(Number(chatId)).then(c => ('title' in c ? c.title ?? '' : '')).catch(() => '')
  console.log(`[telegram] @${me.username} · privacy ${me.can_read_all_group_messages ? 'off' : 'ON (bot only sees commands!)'}`)
  // The command menu in a private chat with the bot (groups only use /pair).
  await bot.api.setMyCommands([
    { command: 'summary', description: 'Your session today: calls, blocks and why, orders' },
    { command: 'rules', description: 'Your trading rules, checked in code before every order' },
    { command: 'setrule', description: 'Change a rule, e.g. /setrule maxTradesPerDay 1' },
    { command: 'audit', description: 'Your last decisions' },
    { command: 'help', description: 'Forward me a call to check it privately' },
  ], { scope: { type: 'all_private_chats' } }).catch(e => console.warn('[telegram] setMyCommands failed:', (e as Error).message))
  if (webhookMode) {
    const base = (process.env.CALLOUT_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/$/, '')
    if (!base) throw new Error('webhook mode needs CALLOUT_PUBLIC_URL (or RENDER_EXTERNAL_URL)')
    await bot.init()
    await bot.api.setWebhook(`${base}${WEBHOOK_PATH}`, { secret_token: webhookSecret, allowed_updates: [...ALLOWED], drop_pending_updates: false })
    console.log(`[telegram] webhook → ${base}${WEBHOOK_PATH}`)
    return
  }
  // Polling (local). Fails with 409 while a webhook is set: delete it first (npm run tg:unhook).
  void bot.start({ drop_pending_updates: true, allowed_updates: [...ALLOWED] })
}
