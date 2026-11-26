import { z } from 'zod'

/** What the LLM is allowed to return. Extraction only: no advice, no size. */
export const ParsedCallSchema = z.object({
  kind: z.enum(['trade_call', 'holding_update', 'noise', 'unsure']),
  symbol: z.string().nullable().describe('Bybit linear symbol like BTCUSDT, or null'),
  side: z.enum(['long', 'short']).nullable(),
  entry: z.number().nullable().describe('Single entry price. If a range is given, its midpoint. null if absent.'),
  stop: z.number().nullable().describe('Stop-loss price, null if absent'),
  targets: z.array(z.number()).describe('Take-profit prices in the order written; empty if none'),
  leverage: z.number().nullable().describe('Leverage the caller mentioned, informational only'),
  confidence: z.number().describe('0..1, how clearly the message states these values'),
  quote: z.string().describe('Exact substring of the message the numbers came from; empty if none'),
})
export type ParsedCall = z.infer<typeof ParsedCallSchema>

/** A Telegram (or replayed) message after the allowlist step. */
export interface IncomingMessage {
  chatId: string
  chatTitle: string
  messageId: number
  senderId: string // from.id, or sender_chat.id for anonymous admins / channel posts
  senderName: string
  text: string
  sentAt: number // ms epoch (Telegram message date)
  editedAt?: number // ms epoch if this is an edit
  source: 'telegram' | 'replay'
}

export type CardState =
  | 'ready' // tradable, waiting for the user
  | 'holding' // holding update on a position the user has: Close (reduce-only) or Keep
  | 'blocked' // a code check failed, Skip only
  | 'unsure' // couldn't read it clearly, no trade button
  | 'countdown' // user tapped; cancel window running
  | 'placing' // order sent to Bybit Demo
  | 'filled'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'expired'
  | 'superseded' // an edit replaced this card before any order

export interface CheckFacts {
  livePrice?: number
  distancePct?: number // (live - entry) / entry * 100
  rr?: number // reward:risk to first target
}

export interface OrderResult {
  kind: 'open' | 'close'
  orderId: string
  orderLinkId: string
  side: 'Buy' | 'Sell'
  qty: string
  avgPrice?: string
  status: string
  receiptSent?: boolean
}

export interface PositionInfo {
  side: 'Buy' | 'Sell'
  size: string
  avgPrice: number
  markPrice: number
  pnlPct: number // unrealised, % of entry, signed from the user's side
}

export interface TrackRecord {
  seen: number
  tp: number
  sl: number
  open: number
  noEntry: number
  ambiguous: number
  synthetic: boolean // true if any counted call is synthetic demo data
}

export interface Card {
  id: string // `${chatId}:${messageId}:${version}`, also the idempotency key
  action: 'open' | 'close'
  version: number // 0 for original, increments on each edit
  msg: IncomingMessage
  parsed?: ParsedCall
  state: CardState
  flags: string[] // factual, neutral check results that blocked the card
  facts: CheckFacts
  createdAt: number
  expiresAt: number
  sizeUsd: number
  countdownEndsAt?: number
  order?: OrderResult
  error?: string
  position?: PositionInfo // holding cards: the user's current demo position
  record?: TrackRecord // caller track record at card time
  edited?: boolean // created from an edited Telegram message
  dismissed?: boolean // result screen acknowledged on the glasses
}
