// Private chat with the bot: everything here is read-only or about the user's own settings. Callout never
// trades from Telegram (orders are placed only from the glasses) and never posts checks into a group.
//
//   forward or paste a call  → a private check: what was read, live-price distance, scam flags, the caller's record
//   /summary                 → your session today: calls seen, what was blocked and why, orders, demo P&L
//   /rules, /setrule         → see or tighten your own trading rules (owner: all of them; a paired judge: their own
//                              orders-per-day limit, never above the judge cap)
//   /audit                   → your last decisions (owner, or a paired judge's own session)
import type { Context } from 'grammy'
import { checkOnly, ingest } from './pipeline.js'
import { randomBytes } from 'node:crypto'
import { takeQuota } from './sandbox.js'
import type { IncomingMessage } from './types.js'
import { config } from './config.js'
import { JUDGE, linkedTo, owner, ownerTelegramId, OWNER_SETTING_LIMITS, redeemPairCode, setOwnerSetting, type Sandbox } from './sandbox.js'
import { judgesPaused } from './pause.js'
import { notePairFailure, pairTriesLeft } from './pair-guard.js'
import { takeBudget } from './budget.js'
import { recordFor } from './track.js'
import { currentStats, startOfUtcDay } from './rules.js'
import { bybit } from './bybit/demo.js'
import { audit } from './store.js'
import type { Card } from './types.js'
import { hiddenLinks } from './tg-util.js'

const NOT_ADVICE = 'Read-only. Callout never trades from Telegram: orders are placed only from your glasses. Not financial advice.'

const HELP = [
  'Callout · checks the call before you take it',
  '',
  'Forward me a trade call (or paste one) and I reply here, privately, with what I read, how far the live Bybit price is from the entry, any scam signs, and the caller\'s record.',
  '',
  '/summary · your session today: calls, what was blocked and why, orders',
  '/rules · your trading rules, checked in code before every order',
  '/setrule maxTradesPerDay 1 · change one (judges can tighten their own)',
  '/audit · your last decisions',
  '',
  'Judges: pair first with /pair <code> here (code on the Try page or the glasses), or tap "Pair in one tap" on the Try page.',
  '',
  'Try it live: https://callout-production-049324a2.up.railway.app/try/',
].join('\n')

const fmtN = (v: number | null | undefined) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 }))
const coin = (s?: string | null) => (s ?? '').replace(/USDT$/, '')
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

// Checks cost an AI call: a few per hour per person (the owner is not limited).
const checkUse = new Map<string, number[]>()
const CHECKS_PER_HOUR = 15
function takeCheck(userId: string): boolean {
  if (userId === ownerTelegramId) return true
  const hourAgo = Date.now() - 3_600_000
  const used = (checkUse.get(userId) ?? []).filter(t => t > hourAgo)
  if (used.length >= CHECKS_PER_HOUR || !takeBudget('parse')) return false
  checkUse.set(userId, [...used, Date.now()])
  return true
}

/** Who originally sent a forwarded message, and when (a forward keeps the original date). */
function forwardOrigin(ctx: Context): { id?: string; name?: string; at?: number } {
  const o = ctx.msg?.forward_origin
  if (!o) return {}
  const at = o.date * 1000
  if (o.type === 'user') return { id: String(o.sender_user.id), name: o.sender_user.username ? `@${o.sender_user.username}` : o.sender_user.first_name, at }
  if (o.type === 'chat') return { id: String(o.sender_chat.id), name: 'title' in o.sender_chat ? o.sender_chat.title : undefined, at }
  if (o.type === 'channel') return { id: String(o.chat.id), name: 'title' in o.chat ? o.chat.title : undefined, at }
  return { name: o.sender_user_name, at } // hidden user: no id, so no record
}

export async function handlePrivate(ctx: Context): Promise<void> {
  const text = (ctx.msg?.text ?? ctx.msg?.caption ?? '').trim()
  const userId = String(ctx.from?.id ?? '')
  if (!text || !userId) return
  const [cmd, ...args] = text.split(/\s+/)
  const command = cmd!.startsWith('/') ? cmd!.slice(1).split('@')[0]!.toLowerCase() : ''

  // One-tap pairing: the Try page links to t.me/<bot>?start=pair-123456, which arrives here as "/start pair-123456".
  const startCode = command === 'start' ? args[0]?.match(/^pair-(\d{6})$/)?.[1] : undefined
  if (startCode) return void (await ctx.reply(pairHere(ctx, userId, startCode)))
  if (command === 'pair') {
    const code = args[0]?.match(/^(\d{6})$/)?.[1]
    return void (await ctx.reply(code ? pairHere(ctx, userId, code) : 'Send /pair with the 6-digit code from the Try page or the glasses, for example /pair 123456.'))
  }
  if (command === 'start' || command === 'help') return void (await ctx.reply(HELP, { link_preview_options: { is_disabled: true } }))
  if (command === 'summary') return void (await ctx.reply(await summary(userId)))
  if (command === 'rules' || command === 'setrule' || command === 'audit') {
    const sb = sessionOf(userId)
    if (!sb) return void (await ctx.reply(NOT_PAIRED))
    const text = command === 'rules' ? rulesText(sb) : command === 'setrule' ? setRule(sb, args) : auditText(sb)
    return void (await ctx.reply(text))
  }
  if (command) return void (await ctx.reply(`Unknown command. ${HELP.split('\n').slice(2, 3).join('')}\n\n/help for the list.`))

  // Anything else: a call to check.
  if (!takeCheck(userId)) return void (await ctx.reply('You have reached the check limit for now. Try again in an hour.'))
  const from = forwardOrigin(ctx)
  audit('private_check', { userId, forwardedFrom: from.id ?? null })
  await ctx.replyWithChatAction('typing').catch(() => {})
  const links = ctx.msg ? hiddenLinks(ctx.msg) : []
  const check = await checkText(text, from, links)
  const sb = sessionOf(userId)
  let body = check.text
  let markup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined
  if (check.sendable && sb) {
    // The next step, one tap away: put this call on the wearer's own glasses (where every check runs again
    // and only a tap on the glasses places anything). Pasting alone never sends anything.
    const id = randomBytes(6).toString('base64url')
    pending.set(id, { userId, text, sentAt: from.at ?? (ctx.msg!.date * 1000), from, links, chatId: String(ctx.chat!.id), messageId: ctx.msg!.message_id, at: Date.now() })
    markup = { inline_keyboard: [[{ text: '📲 Send to my glasses', callback_data: `g:${id}` }]] }
  } else if (check.sendable) {
    body += '\n\nTo put calls like this on your glasses: pair on the Try page (Connect your Telegram → Pair in one tap).'
  }
  await ctx.reply(body, { reply_parameters: { message_id: ctx.msg!.message_id, allow_sending_without_reply: true }, ...(markup ? { reply_markup: markup } : {}) })
}

// ── "Send to my glasses" ──────────────────────────────────────────────────────────────────────────
interface Pending { userId: string; text: string; sentAt: number; from: { id?: string; name?: string }; links: string[]; chatId: string; messageId: number; at: number }
const pending = new Map<string, Pending>()
const sentIds = new Set<string>() // already sent: a second tap says so instead of "expired"
const PENDING_MS = 15 * 60_000 // as long as a call stays fresh

/** The button under a check: send that call to the wearer's own glasses session, once. */
export async function handleGlassesCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? ''
  if (!data.startsWith('g:')) return
  const id = data.slice(2)
  const p = pending.get(id)
  const userId = String(ctx.from?.id ?? '')
  const answer = (text: string) => ctx.answerCallbackQuery({ text, show_alert: text.length > 60 }).catch(() => {})
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k)
  if (sentIds.has(id)) return void (await answer('Already sent to your glasses.'))
  if (!p || Date.now() - p.at > PENDING_MS) return void (await answer('This check has expired. Paste the call again.'))
  if (p.userId !== userId) return void (await answer('Only the person who asked can send this.'))
  const sb = sessionOf(userId)
  if (!sb) return void (await answer('Pair first: Try page → Connect your Telegram → Pair in one tap.'))
  if (sb.kind === 'judge' && judgesPaused()) return void (await answer('Callout judge sessions are paused right now.'))
  if (!takeQuota(sb, 'samples')) return void (await answer('You have sent the most calls allowed this hour. Try again later.'))
  pending.delete(id) // single use: one tap, one card
  sentIds.add(id)
  if (sentIds.size > 5000) sentIds.delete(sentIds.values().next().value!)
  const msg: IncomingMessage = {
    chatId: p.chatId,
    chatTitle: 'Private chat',
    messageId: p.messageId, // the receipt replies to the user's own message here
    senderId: p.from.id ?? userId,
    senderName: p.from.name ?? 'you',
    text: p.text,
    sentAt: p.sentAt,
    ...(p.links.length ? { links: p.links } : {}),
    source: 'telegram',
    via: 'private',
  }
  const r = await ingest(msg, sb)
  audit('sent_to_glasses', { userId, sandbox: sb.id, outcome: r.outcome, ...(r.outcome === 'card' ? { card: r.card.id, state: r.card.state } : {}) })
  const result = r.outcome === 'card'
    ? r.card.state === 'ready'
      ? 'On your glasses now: review it, then tap the glasses to place it (5 s to cancel).'
      : r.card.state === 'holding'
        ? 'On your glasses now: tap the glasses to close your position (reduce-only).'
        : `On your glasses now, ${r.card.state}${r.card.flags.length ? `: ${r.card.flags.slice(0, 2).join(' · ')}` : ''}.`
    : `Not sent: ${r.reason}.`
  await answer(r.outcome === 'card' ? 'Sent to your glasses' : 'Not sent')
  const original = ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text ?? '' : ''
  await ctx.editMessageText(`${original}\n\n📲 ${result}`).catch(() => {})
}

function pairHere(ctx: Context, userId: string, code: string): string {
  const who = `dm:${userId}`
  if (pairTriesLeft(who) <= 0) return 'Too many wrong codes. Please wait 10 minutes, then get a fresh code.'
  if (judgesPaused()) return 'Callout judge sessions are paused right now. Please check back later.'
  const name = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? 'you')
  const sb = redeemPairCode(code, userId, name)
  audit('pair', { chatId: 'private', senderId: userId, ok: !!sb, sandbox: sb?.id })
  if (!sb) {
    notePairFailure(who)
    return 'That code did not match or has expired. Get a new one on the Try page (or the glasses) and try again.'
  }
  return [
    `Linked ${name} to your Callout demo session.`,
    '',
    'Here, privately: /rules, /setrule maxTradesPerDay 1, /audit, /summary, or forward me any call to check it.',
    'To send a call to your glasses, post it in the Callout group (the link is on the Try page and the glasses). Demo money only.',
  ].join('\n')
}

const NOT_PAIRED = 'Your rules and decisions belong to a Callout session. Open the Try page (or Callout on G2), get a code, and send /pair <code> here (or tap "Pair in one tap" on the Try page). Then try /rules, /setrule maxTradesPerDay 1 and /audit here.\n\nhttps://callout-production-049324a2.up.railway.app/try/'

/** The owner's session, or the judge session this Telegram user paired most recently. */
function sessionOf(userId: string): Sandbox | undefined {
  if (userId && userId === ownerTelegramId) return owner
  return linkedTo(userId).sort((a, b) => b.lastSeen - a.lastSeen)[0]
}

// ── forward-to-check ────────────────────────────────────────────────────────────────────────────
async function checkText(text: string, from: { id?: string; name?: string; at?: number }, links: string[]): Promise<{ text: string; sendable: boolean }> {
  const now = Date.now()
  const r = await checkOnly(text, from.at ?? now, now, links)
  const out: string[] = ['Callout check · read-only, nothing was traded']
  if (r.kind === 'noise') {
    out.push('', 'This does not read as a trade call: no coin, side and prices to check. On the glasses, Callout would stay quiet.')
  } else if (r.kind === 'holding_update') {
    out.push('', `This reads as a "taking profit / closing" message${r.parsed?.symbol ? ` about ${coin(r.parsed.symbol)}` : ''}. On the glasses it would offer to close your open demo position (reduce-only), only if you hold that coin.`)
  } else if (r.kind === 'unsure' && !r.parsed?.symbol) {
    out.push('', `Not a clear call: ${r.flags.join(' · ') || 'the message could not be read as one trade'}. Callout would not offer a trade.`)
  } else {
    const p = r.parsed!
    out.push('', `Read: ${(p.side ?? '?').toUpperCase()} ${coin(p.symbol)} · entry ${fmtN(p.entry)} · stop ${fmtN(p.stop)} · target ${fmtN(p.targets[0])}`)
    if (r.livePrice) out.push(`Live Bybit price ${fmtN(r.livePrice)}${r.facts.distancePct !== undefined ? ` · ${Math.abs(r.facts.distancePct).toFixed(1)}% from the entry` : ''}`)
    if (r.state === 'ready') out.push('Checks: nothing blocked it. The decision would be yours.')
    else if (r.state === 'expired') out.push(`Expired: posted ${Math.round((now - (from.at ?? now)) / 60_000)} min ago (calls expire after ${config.callExpiryMs / 60_000} min)`)
    else out.push(`${r.state === 'blocked' ? 'Blocked' : 'Not tradable'}: ${r.flags.join(' · ')}`)
  }
  if (from.id || from.name) {
    const listed = from.id ? owner.allow.senders.has(from.id) : false
    const rec = from.id ? recordFor(from.id) : undefined
    const recText = rec && rec.seen ? ` · seen ${rec.seen} · ${rec.tp} TP · ${rec.sl} SL · ${rec.open} open${rec.synthetic ? ' (synthetic)' : ''}` : from.id ? ' · no earlier calls seen' : ''
    out.push(`Caller: ${from.name ?? 'hidden'}${from.id ? (listed ? ' · on the caller list' : ' · not on the caller list (its calls are ignored)') : ''}${recText}`)
  }
  out.push('', NOT_ADVICE)
  // Anything that reads as a call (or a "taking profit" message) can go on to the glasses; chatter can't.
  const sendable = r.kind === 'trade_call' || r.kind === 'holding_update' || (r.kind === 'unsure' && !!r.parsed?.symbol)
  return { text: out.join('\n'), sendable }
}

// ── /summary ────────────────────────────────────────────────────────────────────────────────────
function sessionsFor(userId: string): Sandbox[] {
  const own = userId && userId === ownerTelegramId ? [owner] : []
  return [...own, ...linkedTo(userId)]
}

async function summary(userId: string): Promise<string> {
  const sbs = sessionsFor(userId)
  if (!sbs.length) return 'Nothing to summarise yet. Pair your Telegram on the Try page (or on the glasses) with /pair in the Callout group, then post a call.'
  const since = startOfUtcDay()
  const out: string[] = []
  for (const sb of sbs) {
    const cards = [...sb.cards.values()].filter(c => c.createdAt >= since && c.state !== 'superseded').sort((a, b) => a.createdAt - b.createdAt)
    const calls = cards.filter(c => c.action === 'open')
    const blocked = calls.filter(c => c.state === 'blocked' || (c.flags.length && c.state !== 'filled' && c.state !== 'ready'))
    const orders = cards.filter(c => c.order && c.state === 'filled')
    const passed = calls.filter(c => ['skipped', 'expired', 'cancelled'].includes(c.state)).length
    out.push(`Callout · ${sb.kind === 'owner' ? 'your session' : 'your demo session'} today (UTC)`)
    out.push(`Calls: ${calls.length} · blocked ${blocked.length} · placed ${orders.filter(c => c.order!.kind === 'open').length} · skipped, cancelled or expired ${passed} · muted messages ${sb.session.muted}`)
    if (blocked.length) {
      out.push('', 'Blocked, and why:')
      for (const c of blocked.slice(-6)) out.push(`· ${hhmm(c.createdAt)} ${(c.parsed?.side ?? '').toUpperCase()} ${coin(c.parsed?.symbol)}: ${c.flags.slice(0, 3).join(' · ')}`)
    }
    if (orders.length) {
      out.push('', 'Orders (Bybit Demo):')
      for (const c of orders.slice(-6)) {
        const o = c.order!
        out.push(`· ${hhmm(c.createdAt)} ${o.kind === 'close' ? 'Closed (reduce-only) ' : ''}${coin(c.parsed?.symbol)} ${o.side} ${o.qty} @ ${fmtN(Number(o.avgPrice))} · ...${o.orderId.slice(-8)}`)
      }
    }
    if (sb.kind === 'owner') {
      const pnl = await currentStats(bybit).then(s => s.pnlToday, () => undefined)
      if (pnl !== undefined) out.push('', `Realised P&L today: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (Bybit Demo)`)
    } else out.push('', 'Open demo positions close automatically after 2 minutes.')
    out.push('')
  }
  out.push('Not financial advice. Demo money only.')
  return out.join('\n')
}

// ── /rules, /setrule, /audit ────────────────────────────────────────────────────────────────────
function rulesText(sb: Sandbox): string {
  const r = sb.rules
  if (sb.kind === 'judge') {
    return [
      'Your rules · demo session (checked in code before every order)',
      `maxTradesPerDay ${r.maxTradesPerDay} · orders per UTC day (you can lower it, 1 to ${JUDGE.rules.maxTradesPerDay})`,
      `order size $${sb.sizeUsd} on Bybit Demo · fixed for judges`,
      'Open positions close automatically after 2 minutes.',
      '',
      'Try it: /setrule maxTradesPerDay 1, place one order on the Try page, then send another call: the card is blocked by your rule.',
    ].join('\n')
  }
  return [
    'Your rules (checked in code before every order)',
    `maxTradesPerDay ${r.maxTradesPerDay || 'off'} · ${OWNER_SETTING_LIMITS.maxTradesPerDay.help}`,
    `maxDailyLossUsd ${r.maxDailyLossUsd || 'off'} · ${OWNER_SETTING_LIMITS.maxDailyLossUsd.help}`,
    `pauseAfterLosses ${r.pauseAfterLosses || 'off'} · ${OWNER_SETTING_LIMITS.pauseAfterLosses.help}`,
    `sizeUsd ${sb.sizeUsd} · ${OWNER_SETTING_LIMITS.sizeUsd.help} (cap ${config.maxSizeUsd})`,
    '',
    'Change one: /setrule maxTradesPerDay 3',
  ].join('\n')
}

function setRule(sb: Sandbox, args: string[]): string {
  const [name, raw] = args
  if (!name || raw === undefined) return 'Usage: /setrule <name> <number>, for example /setrule maxTradesPerDay 1\n\n' + rulesText(sb)
  const value = Number(raw)
  let err: string | null
  if (sb.kind === 'judge') {
    // Judges may only tighten their own daily limit; the judge caps never loosen.
    const max = JUDGE.rules.maxTradesPerDay
    if (name !== 'maxTradesPerDay') err = `In a demo session you can change maxTradesPerDay (1 to ${max}). Order size is fixed at $${sb.sizeUsd}.`
    else if (!Number.isInteger(value) || value < 1 || value > max) err = `maxTradesPerDay must be a whole number from 1 to ${max} in a demo session.`
    else {
      sb.rules.maxTradesPerDay = value
      err = null
    }
  } else err = setOwnerSetting(name, value)
  audit('rule_changed', { sandbox: sb.id, name, value: raw, ok: !err, by: 'telegram' })
  return err ?? `Saved. ${name} is now ${raw}${value === 0 && name !== 'sizeUsd' ? ' (off)' : ''}. It applies to the next card and to every tap.`
}

function auditText(sb: Sandbox): string {
  const cards = [...sb.cards.values()].filter(c => c.state !== 'superseded').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
  if (!cards.length) return 'No decisions yet in this session. Send a call (Try page or the Callout group), then ask again.'
  const line = (c: Card) => {
    const what = c.action === 'close' ? `Close ${coin(c.parsed?.symbol)}` : `${(c.parsed?.side ?? '?').toUpperCase()} ${coin(c.parsed?.symbol)}`
    const why = c.flags.length && c.state !== 'filled' ? ` (${c.flags.slice(0, 2).join(' · ')})` : ''
    const ord = c.order ? ` · ...${c.order.orderId.slice(-8)}` : ''
    return `${hhmm(c.createdAt)} ${what} from ${c.msg.senderName || 'caller'} → ${c.state}${why}${ord}`
  }
  return ['Your last decisions (newest first, UTC)', ...cards.map(line), '', 'Every decision is also in the server\'s audit log.'].join('\n')
}
