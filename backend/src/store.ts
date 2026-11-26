// In-memory card store + append-only audit log (JSONL).
// Privacy: only cards (allowlisted senders' call-like messages) are recorded; noise is only counted.
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Card } from './types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.resolve(here, '../logs')
const AUDIT_FILE = path.join(LOG_DIR, 'audit.jsonl')
mkdirSync(LOG_DIR, { recursive: true })

export function audit(event: string, data: Record<string, unknown>): void {
  appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n')
}

/**
 * Per-process nonce mixed into every orderLinkId. Card ids (chat:message:version) restart
 * when the process restarts, so without this a new card could collide with an old order key.
 */
export const BOOT = Date.now().toString(36)

export const cards = new Map<string, Card>()
/** `${chatId}:${messageId}` → latest version number assigned (assigned synchronously, before any await). */
export const latestVersion = new Map<string, number>()

export const session = {
  startedAt: Date.now(),
  muted: 0, // allowlisted-chat messages that didn't become a card (noise, non-allowlisted senders, commands)
  expired: 0, // cards that expired before the user acted ("while away")
  lastResult: '' as string,
}

export const messageKey = (chatId: string, messageId: number) => `${chatId}:${messageId}`

export function setState(card: Card, state: Card['state'], extra: Partial<Card> = {}): void {
  const from = card.state
  Object.assign(card, extra, { state })
  audit('card_state', {
    id: card.id,
    from,
    to: state,
    flags: card.flags,
    ...(card.order ? { order: card.order } : {}),
    ...(card.error ? { error: card.error } : {}),
  })
}

const ACTIVE: Card['state'][] = ['ready', 'holding', 'blocked', 'unsure', 'countdown', 'placing']
export const isActive = (c: Card) => ACTIVE.includes(c.state)
