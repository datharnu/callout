// message → allowlist → AI parse → code checks → card
import { config } from './config.js'
import { parseMessage } from './ai/parse.js'
import { runChecks } from './checks.js'
import { livePrice } from './market.js'
import { audit, cards, latestVersion, messageKey, session, setState } from './store.js'
import type { Card, IncomingMessage } from './types.js'

/** Card states an edit may replace. Anything at/after countdown is never touched by an edit. */
const REPLACEABLE: Card['state'][] = ['ready', 'blocked', 'unsure']

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

export async function ingest(msg: IncomingMessage): Promise<IngestResult> {
  // 1. Allowlist.
  const g = gate(msg, { chats: config.allowedChatIds, senders: config.allowedSenderIds })
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
  if (prev !== undefined) supersedeOlder(key, version, 'edited')

  // 3. Parse (LLM extracts values only).
  const { parsed, error } = await parseMessage(text)

  if (parsed.kind === 'noise' && !error) {
    session.muted++
    return { outcome: 'muted', reason: 'noise' }
  }

  // 4. Code checks against mainnet live price.
  const price = parsed.symbol ? await livePrice(parsed.symbol) : undefined
  const now = Date.now()
  const verdict = runChecks(
    { parsed, rawText: text, livePrice: price, sentAt: msg.sentAt, now },
    { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs },
  )

  let state: Card['state'] = verdict.state
  let flags = verdict.flags
  if (error) flags = ["Couldn't read this clearly"]
  if (parsed.kind === 'holding_update' && !error) {
    // Holding cards (reduce-only Close) land on Nov 28. Until then: shown, never tradable.
    state = 'unsure'
    flags = ['holding update']
  }

  const card: Card = {
    id: `${key}:${version}`,
    version,
    msg: { ...msg, text },
    parsed,
    state,
    flags,
    facts: verdict.facts,
    createdAt: now,
    expiresAt: msg.sentAt + config.callExpiryMs,
    sizeUsd: config.sizeUsd,
    edited: version > 0,
    ...(error ? { error } : {}),
  }

  // A newer edit arrived while we were parsing: this card is born superseded.
  if (latestVersion.get(key) !== version) card.state = 'superseded'
  if (card.state === 'expired' && parsed.kind === 'trade_call') session.expired++

  cards.set(card.id, card)
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

function supersedeOlder(key: string, newVersion: number, why: string) {
  for (const c of cards.values()) {
    if (`${c.msg.chatId}:${c.msg.messageId}` === key && c.version < newVersion && REPLACEABLE.includes(c.state)) {
      setState(c, 'superseded', { error: why })
    }
  }
}

/** Periodic sweep: untouched cards past expiry become "expired" (counted as "while away"). */
export function sweepExpired(now = Date.now()): void {
  for (const c of cards.values()) {
    if (REPLACEABLE.includes(c.state) && now > c.expiresAt) {
      const wasTradable = c.state === 'ready'
      setState(c, 'expired')
      if (wasTradable) session.expired++ // "calls while away" = tradable calls nobody acted on
    }
  }
}
