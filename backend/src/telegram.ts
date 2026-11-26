// Telegram in (group messages + edits) and out (receipts).
import { Bot, type Context } from 'grammy'
import { requireEnv } from './env.js'
import { ingest } from './pipeline.js'
import { linkedTo, owner, redeemPairCode } from './sandbox.js'
import { audit } from './store.js'
import { config } from './config.js'
import type { Card, IncomingMessage } from './types.js'

export const bot = new Bot(requireEnv('TELEGRAM_BOT_TOKEN'))

function toIncoming(ctx: Context, edited: boolean): IncomingMessage | undefined {
  const m = ctx.msg
  if (!m) return undefined
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
    source: 'telegram',
  }
}

/** The group judges join (title read from Telegram at startup; invite link from .env). */
export const group: { title: string; inviteUrl?: string } = { title: '', inviteUrl: process.env.TELEGRAM_GROUP_INVITE_URL?.trim() || undefined }

/** `/pair 123456` (also `/pair@CalloutBot 123456`) in an allowlisted group links the sender to a judge session. */
async function handlePair(ctx: Context, msg: IncomingMessage): Promise<boolean> {
  const m = msg.text.trim().match(/^\/pair(?:@\w+)?\s+(\d{6})\b/i)
  if (!m || !config.allowedChatIds.has(msg.chatId)) return false
  const sb = redeemPairCode(m[1]!, msg.senderId, msg.senderName)
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
    const msg = toIncoming(ctx, edited)
    if (!msg) return
    if (!edited && (await handlePair(ctx, msg))) return
    // The owner's sandbox sees every message (its allowlist decides), plus any judge session linked to the sender.
    for (const sb of [owner, ...linkedTo(msg.senderId)]) {
      const r = await ingest(msg, sb)
      if (r.outcome === 'card') {
        console.log(`[card] ${sb.id} ${r.card.id} ${r.card.state}${r.card.flags.length ? ` (${r.card.flags.join(', ')})` : ''}`)
      }
    }
  }
}

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

export async function startTelegram(): Promise<void> {
  const me = await bot.api.getMe()
  const chatId = [...config.allowedChatIds][0]
  if (chatId) group.title = await bot.api.getChat(Number(chatId)).then(c => ('title' in c ? c.title ?? '' : '')).catch(() => '')
  console.log(`[telegram] @${me.username} · privacy ${me.can_read_all_group_messages ? 'off' : 'ON (bot only sees commands!)'}`)
  void bot.start({
    drop_pending_updates: true,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
  })
}
