// message → allowlist → AI parse → code checks → card
import { config } from './config.js'
import { parseMessage } from './ai/parse.js'
import { runChecks } from './checks.js'
import { livePrice } from './market.js'
import { audit, messageKey, setState } from './store.js'
import { allSandboxes, judgePositions, type Sandbox } from './sandbox.js'
import { takeBudget } from './budget.js'
import { filledOpensSince } from './db.js'
import type { Card, IncomingMessage, PositionInfo } from './types.js'
import { bybit } from './bybit/demo.js'
import { insertCall } from './db.js'
import { listPositions } from './positions.js'
import { currentStats, ruleFlags, startOfUtcDay } from './rules.js'
import { recordFor } from './track.js'
import { warmUp } from './voice/stt.js'

/** Card states an edit may replace. Anything at/after countdown is never touched by an edit. */
const REPLACEABLE: Card['state'][] = ['ready', 'holding', 'blocked', 'unsure']

export type IngestResult =
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'muted'; reason: string }
  | { outcome: 'card'; card: Card }

/** Allowlist + trivial filters. Pure, so the accuracy eval uses the exact production gate. */
export function gate(
  msg: Pick<IncomingMessage, 'chatId' | 'senderId' | 'text'>,
  allow: { chats: ReadonlySet<string>; senders: ReadonlySet<string> },
): { pass: true } | { pass: false; outcome: 'ignored' | 'muted'; reason: string } {
  // Unknown chats are ignored entirely; unknown senders are noise, always.
  if (!allow.chats.has(msg.chatId)) return { pass: false, outcome: 'ignored', reason: 'chat not allowlisted' }
  if (!allow.senders.has(msg.senderId)) return { pass: false, outcome: 'muted', reason: 'sender not allowlisted' }
  const text = msg.text.trim()
  if (!text || text.startsWith('/')) return { pass: false, outcome: 'muted', reason: 'empty or command' }
  return { pass: true }
}

export async function ingest(msg: IncomingMessage, sb: Sandbox): Promise<IngestResult> {
  const { session, latestVersion, cards } = sb
  // 1. Allowlist (this sandbox's chats and senders).
  const g = gate(msg, sb.allow)
  if (!g.pass) {
    if (g.outcome === 'muted') session.muted++
    return { outcome: g.outcome, reason: g.reason }
  }
  const text = msg.text.trim()

  // 2. Versioning (sync, before any await) so a slow parse of v0 can't overwrite a newer edit.
  const key = messageKey(msg.chatId, msg.messageId)
  const prev = latestVersion.get(key)
  const version = prev === undefined ? 0 : prev + 1
  latestVersion.set(key, version)
  if (prev !== undefined) supersedeOlder(sb, key, version, 'edited')

  // 3. Parse (LLM extracts values only). Judge traffic has a global daily ceiling on paid calls.
  const { parsed, error } = sb.kind === 'judge' && !takeBudget('parse')
    ? { parsed: { kind: 'unsure' as const, symbol: null, side: null, entry: null, stop: null, targets: [], leverage: null, confidence: 0, quote: '' }, error: 'demo parsing limit reached for today' }
    : await parseMessage(text)

  if (parsed.kind === 'noise' && !error) {
    session.muted++
    return { outcome: 'muted', reason: 'noise' }
  }

  const now = Date.now()
  const base = {
    id: `${key}:${version}`,
    sandboxId: sb.id,
    version,
    msg: { ...msg, text },
    parsed,
    createdAt: now,
    expiresAt: msg.sentAt + config.callExpiryMs,
    sizeUsd: sb.sizeUsd,
    edited: version > 0,
    ...(error ? { error } : {}),
  }

  let card: Card
  if (parsed.kind === 'holding_update' && !error) {
    // 4a. Holding update: only relevant if the user holds that coin on Demo.
    let pos: PositionInfo | undefined
    let posError = false
    try {
      pos = parsed.symbol ? await positionInfo(sb, parsed.symbol) : undefined
    } catch {
      posError = true
    }
    if (posError) {
      card = { ...base, action: 'close', state: 'unsure', flags: ["couldn't read your position"], facts: {} }
    } else if (!pos) {
      session.muted++
      return { outcome: 'muted', reason: 'holding update, no matching position' }
    } else {
      card = { ...base, action: 'close', state: 'holding', flags: [], facts: {}, position: pos }
    }
  } else {
    // 4b. Code checks against mainnet live price, then the user's own rules.
    const price = parsed.symbol ? await livePrice(parsed.symbol) : undefined
    const verdict = runChecks(
      { parsed, rawText: text, livePrice: price, sentAt: msg.sentAt, now },
      { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs },
    )
    let state: Card['state'] = verdict.state
    let flags = error ? ["Couldn't read this clearly"] : verdict.flags
    if (state === 'ready') {
      const rf = await userRuleFlags(sb)
      if (rf.length) {
        state = 'blocked'
        flags = rf
      }
    }
    card = { ...base, action: 'open', state, flags, facts: verdict.facts }
    if (parsed.kind === 'trade_call') card.record = recordFor(msg.senderId, card.id)
    recordCall(card)
  }

  // A newer edit arrived while we were parsing: this card is born superseded.
  if (latestVersion.get(key) !== version) card.state = 'superseded'
  if (card.state === 'expired' && parsed.kind === 'trade_call') session.expired++

  cards.set(card.id, card)
  warmUp() // the user may speak to this card: have the speech-to-text connection ready
  audit('card_created', {
    id: card.id,
    state: card.state,
    flags: card.flags,
    facts: card.facts,
    parsed,
    chatId: msg.chatId,
    senderId: msg.senderId,
    text, // allowlisted call-like messages only; noise is never stored
    source: msg.source,
    ...(error ? { error } : {}),
  })
  return { outcome: 'card', card }
}

/**
 * Rule flags, failing closed: if stats can't be read, the card is blocked.
 * Owner: trades from our DB + realised P&L and loss streak from Bybit Demo. Judges: only their own trades.
 */
export async function userRuleFlags(sb: Sandbox): Promise<string[]> {
  try {
    if (sb.kind === 'judge') return ruleFlags({ tradesToday: filledOpensSince(startOfUtcDay(), sb.id), pnlToday: 0, lossStreak: 0 }, sb.rules)
    return ruleFlags(await currentStats(bybit), sb.rules)
  } catch (e) {
    return [`rules: couldn't check (${(e as Error).message.slice(0, 40)})`]
  }
}

/** The position a holding card refers to. Judges only ever see their own open demo position. */
export async function positionInfo(sb: Sandbox, symbol: string): Promise<PositionInfo | undefined> {
  if (sb.kind === 'judge') {
    const j = judgePositions.get(symbol)
    if (!j || j.sandboxId !== sb.id) return undefined
  }
  const [p] = await listPositions(bybit, symbol)
  if (!p) return undefined
  const avg = Number(p.avgPrice)
  const mark = Number(p.markPrice)
  const pnlPct = ((mark - avg) / avg) * 100 * (p.side === 'Buy' ? 1 : -1)
  return { side: p.side, size: p.size, avgPrice: avg, markPrice: mark, pnlPct }
}

/**
 * Every complete trade call from an allowlisted sender seen on Telegram feeds the track record.
 * Replayed/test messages don't (the demo's history comes only from the labeled synthetic seed).
 */
function recordCall(card: Card) {
  const p = card.parsed
  if (card.msg.source !== 'telegram') return
  if (!p || p.kind !== 'trade_call' || !p.symbol || !p.side || !p.entry || !p.stop || p.targets[0] === undefined) return
  insertCall({
    id: card.id,
    chat_id: card.msg.chatId,
    sender_id: card.msg.senderId,
    sender_name: card.msg.senderName,
    symbol: p.symbol,
    side: p.side,
    entry: p.entry,
    stop: p.stop,
    target: p.targets[0],
    sent_at: card.msg.sentAt,
    synthetic: 0,
  })
}

function supersedeOlder(sb: Sandbox, key: string, newVersion: number, why: string) {
  for (const c of sb.cards.values()) {
    if (`${c.msg.chatId}:${c.msg.messageId}` === key && c.version < newVersion && REPLACEABLE.includes(c.state)) {
      setState(c, 'superseded', { error: why })
    }
  }
}

/** Periodic sweep: untouched cards past expiry become "expired" (counted as "while away"). */
export function sweepExpired(now = Date.now()): void {
  for (const sb of allSandboxes()) {
    for (const c of sb.cards.values()) {
      if (REPLACEABLE.includes(c.state) && now > c.expiresAt) {
        const wasTradable = c.state === 'ready'
        setState(c, 'expired')
        if (wasTradable) sb.session.expired++ // "calls while away" = tradable calls nobody acted on
      }
    }
  }
}
