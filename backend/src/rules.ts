// The user's own trading rules, enforced in code before any order.
// Flags are factual ("rule: 5/5 trades today"), never advice.
import { config } from './config.js'
import { filledOpensSince } from './db.js'
import type { BybitDemoClient } from './bybit/client.js'

export interface RuleSettings {
  maxTradesPerDay: number
  maxDailyLossUsd: number
  pauseAfterLosses: number
}

export interface RuleStats {
  tradesToday: number
  pnlToday: number // realised, USDT; negative = loss
  lossStreak: number // consecutive losing closes, most recent first
}

/** Pure: stats + settings → blocking flags. */
export function ruleFlags(s: RuleStats, r: RuleSettings): string[] {
  const flags: string[] = []
  if (r.maxTradesPerDay > 0 && s.tradesToday >= r.maxTradesPerDay) flags.push(`rule: ${s.tradesToday}/${r.maxTradesPerDay} trades today`)
  if (r.maxDailyLossUsd > 0 && -s.pnlToday >= r.maxDailyLossUsd) {
    flags.push(`rule: down $${(-s.pnlToday).toFixed(2)} today, limit $${r.maxDailyLossUsd}`)
  }
  if (r.pauseAfterLosses > 0 && s.lossStreak >= r.pauseAfterLosses) flags.push(`rule: paused after ${s.lossStreak} losses in a row`)
  return flags
}

export const startOfUtcDay = (now = Date.now()) => Math.floor(now / 86_400_000) * 86_400_000

let cache: { at: number; stats: RuleStats } | undefined

/** Live stats: trades from our DB, realised P&L and loss streak from Bybit DEMO closed-pnl. */
export async function currentStats(bybit: BybitDemoClient, maxAgeMs = 10_000): Promise<RuleStats> {
  if (cache && Date.now() - cache.at <= maxAgeMs) return cache.stats
  const since = startOfUtcDay()
  const r = await bybit.call('GET', '/v5/position/closed-pnl', { category: 'linear', limit: 50 })
  const closes = (r.list as any[])
    .map(x => ({ pnl: Number(x.closedPnl), at: Number(x.updatedTime ?? x.createdTime) }))
    .sort((a, b) => b.at - a.at)
  let lossStreak = 0
  for (const c of closes) {
    if (c.pnl < 0) lossStreak++
    else break
  }
  const stats: RuleStats = {
    tradesToday: filledOpensSince(since),
    pnlToday: closes.filter(c => c.at >= since).reduce((s, c) => s + c.pnl, 0),
    lossStreak,
  }
  cache = { at: Date.now(), stats }
  return stats
}

export function invalidateStats(): void {
  cache = undefined
}

export const ruleSettings: RuleSettings = {
  maxTradesPerDay: config.maxTradesPerDay,
  maxDailyLossUsd: config.maxDailyLossUsd,
  pauseAfterLosses: config.pauseAfterLosses,
}
