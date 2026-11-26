// Telegram in (group messages + edits) and out (receipts).
import { Bot, type Context } from 'grammy'
import { requireEnv } from './env.js'
import { ingest } from './pipeline.js'
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

function handle(edited: boolean) {
  return async (ctx: Context) => {
    const msg = toIncoming(ctx, edited)
    if (!msg) return
    const r = await ingest(msg)
    if (r.outcome === 'card') {
      console.log(`[card] ${r.card.id} ${r.card.state}${r.card.flags.length ? ` (${r.card.flags.join(', ')})` : ''}`)
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
  console.log(`[telegram] @${me.username} · privacy ${me.can_read_all_group_messages ? 'off' : 'ON (bot only sees commands!)'}`)
  void bot.start({
    drop_pending_updates: true,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
  })
}
