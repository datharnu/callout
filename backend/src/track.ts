// Caller track record from Bybit MAINNET 1-minute candles. Shows counts, never a score.
// Only counts calls Callout saw (callers can delete bad calls). Demo data is labeled synthetic.
import { mainnetPublic } from './bybit/client.js'
import { db, type CallRow } from './db.js'
import type { TrackRecord } from './types.js'

const MINUTE = 60_000
const HORIZON = 7 * 24 * 60 * MINUTE

export type Outcome = 'tp' | 'sl' | 'no_entry' | 'open' | 'ambiguous' | 'expired'

export interface Candle {
  start: number
  high: number
  low: number
}

/**
 * Pure: walk candles in time order. Entry must be touched first; after that, the first candle
 * that touches TP or SL decides. A candle touching both is "ambiguous" (order inside it is unknown).
 */
export function resolveOutcome(
  call: Pick<CallRow, 'side' | 'entry' | 'stop' | 'target' | 'sent_at'>,
  candles: Candle[],
  now: number,
): { outcome: Outcome; at?: number } {
  const long = call.side === 'long'
  let entered = false
  for (const c of candles) {
    if (c.start + MINUTE <= call.sent_at) continue
    if (!entered) {
      if (c.low <= call.entry && call.entry <= c.high) entered = true
      else continue
    }
    const hitTp = long ? c.high >= call.target : c.low <= call.target
    const hitSl = long ? c.low <= call.stop : c.high >= call.stop
    if (hitTp && hitSl) return { outcome: 'ambiguous', at: c.start }
    if (hitTp) return { outcome: 'tp', at: c.start }
    if (hitSl) return { outcome: 'sl', at: c.start }
  }
  if (now - call.sent_at < HORIZON) return { outcome: 'open' }
  return { outcome: entered ? 'expired' : 'no_entry' }
}

/** 1-minute mainnet candles in [start, end), oldest first (Bybit returns newest first, max 1000). */
async function candlesBetween(symbol: string, start: number, end: number): Promise<Candle[]> {
  const r = await mainnetPublic('/v5/market/kline', { category: 'linear', symbol, interval: '1', start, end: end - 1, limit: 1000 })
  return (r.list as string[][])
    .map(k => ({ start: Number(k[0]), high: Number(k[2]), low: Number(k[3]) }))
    .sort((a, b) => a.start - b.start)
}

type PageFetcher = (symbol: string, start: number, end: number) => Promise<Candle[]>

/**
 * Resolve one call, fetching candles in ~16h pages and stopping as soon as it resolves.
 * Each page is judged "as of" the end of the data fetched so far, so a call can only be
 * declared no_entry/expired once the full 7-day window has actually been scanned.
 */
export async function evaluateCall(
  call: Pick<CallRow, 'symbol' | 'side' | 'entry' | 'stop' | 'target' | 'sent_at'>,
  now = Date.now(),
  fetchPage: PageFetcher = candlesBetween,
): Promise<{ outcome: Outcome; at?: number }> {
  const end = Math.min(now, call.sent_at + HORIZON)
  const all: Candle[] = []
  let r: { outcome: Outcome; at?: number } = { outcome: 'open' }
  for (let from = Math.floor(call.sent_at / MINUTE) * MINUTE; from < end; from += 1000 * MINUTE) {
    const to = Math.min(from + 1000 * MINUTE, end)
    all.push(...(await fetchPage(call.symbol, from, to)))
    r = resolveOutcome(call, all, to)
    if (r.outcome !== 'open') return r
  }
  return r
}

const pendingStmt = db.prepare(`SELECT * FROM calls WHERE outcome IS NULL OR outcome = 'open' ORDER BY sent_at`)
const setOutcomeStmt = db.prepare(`UPDATE calls SET outcome = ?, outcome_at = ?, checked_at = ? WHERE id = ?`)

/** Update every unresolved call. Safe to run repeatedly. */
export async function refreshOutcomes(now = Date.now()): Promise<number> {
  const pending = pendingStmt.all() as CallRow[]
  for (const c of pending) {
    try {
      const r = await evaluateCall(c, now)
      setOutcomeStmt.run(r.outcome, r.at ?? null, now, c.id)
    } catch (e) {
      console.warn(`[track] ${c.id}: ${(e as Error).message}`)
    }
  }
  return pending.length
}

export function recordFor(senderId: string, excludeId?: string): TrackRecord {
  const rows = db
    .prepare(`SELECT outcome, synthetic FROM calls WHERE sender_id = ? AND id != ?`)
    .all(senderId, excludeId ?? '') as { outcome: string | null; synthetic: number }[]
  const count = (o: string) => rows.filter(r => r.outcome === o).length
  return {
    seen: rows.length,
    tp: count('tp'),
    sl: count('sl'),
    open: rows.filter(r => r.outcome === null || r.outcome === 'open').length,
    noEntry: count('no_entry') + count('expired'),
    ambiguous: count('ambiguous'),
    synthetic: rows.some(r => r.synthetic === 1),
  }
}
