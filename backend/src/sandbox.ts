// Sandboxes: every visitor works in their own space (cards, counters, limits). The owner's sandbox is
// configured from .env exactly as before; judges get one each from the hosted site.
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import type { RuleSettings } from './rules.js'
import type { Card } from './types.js'

export interface Sandbox {
  id: string
  kind: 'owner' | 'judge'
  token: string
  cards: Map<string, Card>
  /** `${chatId}:${messageId}` → latest version (assigned synchronously, before any await). */
  latestVersion: Map<string, number>
  session: { startedAt: number; muted: number; expired: number; lastResult: string }
  /** Telegram chats this sandbox reads, and the senders whose calls become cards here. */
  allow: { chats: ReadonlySet<string>; senders: Set<string> }
  sizeUsd: number
  rules: RuleSettings
  /** The Telegram user linked with /pair (judges). */
  telegram?: { id: string; name: string }
  pair?: { code: string; expiresAt: number }
  createdAt: number
  lastSeen: number
  usage: { samples: number[]; voice: number[] }
  /** Judges: the coin their sample calls use, so judges trading at the same time never share a position. */
  coin?: string
  coinAt?: number
}

export const JUDGE = {
  sizeUsd: 100,
  rules: { maxTradesPerDay: 3, maxDailyLossUsd: 0, pauseAfterLosses: 0 } satisfies RuleSettings,
  samplesPerHour: 30,
  voicePerHour: 40,
  idleExpiryMs: 24 * 3_600_000,
  maxSandboxes: 500,
  pairCodeMs: 10 * 60_000,
}

const byId = new Map<string, Sandbox>()
const byToken = new Map<string, Sandbox>()

const newToken = () => randomBytes(24).toString('base64url')

function register(sb: Sandbox): Sandbox {
  byId.set(sb.id, sb)
  byToken.set(sb.token, sb)
  return sb
}

const blank = (now = Date.now()) => ({
  cards: new Map<string, Card>(),
  latestVersion: new Map<string, number>(),
  session: { startedAt: now, muted: 0, expired: 0, lastResult: '' },
  createdAt: now,
  lastSeen: now,
  usage: { samples: [] as number[], voice: [] as number[] },
})

/** The owner: allowlist and rules from .env. Token from CALLOUT_OWNER_TOKEN (random if unset → local-only access). */
// The owner's rules and size start from .env and can be changed from Telegram (/setrule); changes are
// saved next to the database so they survive a restart.
const OWNER_SETTINGS = path.join(path.dirname(process.env.CALLOUT_DB ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/callout.sqlite')), 'owner-settings.json')
function savedOwnerSettings(): Partial<{ sizeUsd: number } & Sandbox['rules']> {
  try {
    return existsSync(OWNER_SETTINGS) ? JSON.parse(readFileSync(OWNER_SETTINGS, 'utf8')) : {}
  } catch {
    return {}
  }
}
const saved = savedOwnerSettings()

export const owner: Sandbox = register({
  id: 'owner',
  kind: 'owner',
  token: process.env.CALLOUT_OWNER_TOKEN?.trim() || newToken(),
  ...blank(),
  allow: { chats: config.allowedChatIds, senders: new Set(config.allowedSenderIds) },
  sizeUsd: saved.sizeUsd ?? config.sizeUsd,
  rules: {
    maxTradesPerDay: saved.maxTradesPerDay ?? config.maxTradesPerDay,
    maxDailyLossUsd: saved.maxDailyLossUsd ?? config.maxDailyLossUsd,
    pauseAfterLosses: saved.pauseAfterLosses ?? config.pauseAfterLosses,
  },
})

/** Settings the owner may change from Telegram, with their limits. */
export const OWNER_SETTING_LIMITS = {
  maxTradesPerDay: { min: 0, max: 50, help: 'orders per UTC day (0 = no limit)' },
  maxDailyLossUsd: { min: 0, max: 10_000, help: 'stop for the day after losing this many USDT (0 = no limit)' },
  pauseAfterLosses: { min: 0, max: 20, help: 'pause after this many losing trades in a row (0 = never)' },
  sizeUsd: { min: 5, max: 0, help: 'order size in USDT (up to the configured cap)' },
} as const
export type OwnerSetting = keyof typeof OWNER_SETTING_LIMITS

/** Change one owner setting; returns an error message, or null when saved. */
export function setOwnerSetting(name: string, value: number): string | null {
  if (!(name in OWNER_SETTING_LIMITS)) return `Unknown setting. Use one of: ${Object.keys(OWNER_SETTING_LIMITS).join(', ')}`
  const lim = OWNER_SETTING_LIMITS[name as OwnerSetting]
  const max = name === 'sizeUsd' ? config.maxSizeUsd : lim.max
  if (!Number.isFinite(value) || value < lim.min || value > max) return `${name} must be between ${lim.min} and ${max}`
  if (name === 'sizeUsd') owner.sizeUsd = value
  else owner.rules[name as keyof Sandbox['rules']] = Math.round(value)
  const out = { sizeUsd: owner.sizeUsd, ...owner.rules }
  try {
    mkdirSync(path.dirname(OWNER_SETTINGS), { recursive: true })
    writeFileSync(OWNER_SETTINGS, JSON.stringify(out, null, 2))
  } catch (e) {
    return `Changed for now, but could not save it: ${(e as Error).message}`
  }
  return null
}

/** The Telegram user allowed to change the owner's settings and read the owner's audit (default: the first allowlisted caller). */
export const ownerTelegramId = process.env.TELEGRAM_OWNER_ID?.trim() || [...config.allowedSenderIds][0] || ''
export const ownerTokenConfigured = !!process.env.CALLOUT_OWNER_TOKEN?.trim()

/** The admin whose calls the judge panel's sample messages come from (the group's allowlisted caller). */
export const demoAdminId = [...config.allowedSenderIds][0] ?? 'demo-admin'

export function createJudge(): Sandbox {
  sweepSandboxes()
  if ([...byId.values()].filter(s => s.kind === 'judge').length >= JUDGE.maxSandboxes) {
    throw Object.assign(new Error('too many active judge sessions, try again later'), { status: 503 })
  }
  return register({
    id: `j-${randomBytes(5).toString('hex')}`,
    kind: 'judge',
    token: newToken(),
    ...blank(),
    // Judges read the same group; the sample admin is allowed so sample calls behave like real ones.
    allow: { chats: config.allowedChatIds, senders: new Set([demoAdminId]) },
    sizeUsd: JUDGE.sizeUsd,
    rules: { ...JUDGE.rules },
  })
}

export function byTokenOrNull(token: string | undefined): Sandbox | null {
  if (!token) return null
  const sb = byToken.get(token) ?? null
  if (sb) sb.lastSeen = Date.now()
  return sb
}

export const sandboxById = (id: string) => byId.get(id)
export const allSandboxes = () => [...byId.values()]

/** Judge sandboxes linked to this Telegram user (a judge may have several browser sessions). */
export const linkedTo = (telegramId: string) => allSandboxes().filter(s => s.kind === 'judge' && s.telegram?.id === telegramId)

/** A fresh 6-digit pairing code for /pair in the Telegram group. */
export function newPairCode(sb: Sandbox): { code: string; expiresAt: number } {
  let code: string
  do code = String(randomInt(100000, 1000000))
  while (allSandboxes().some(s => s.pair?.code === code && s.pair.expiresAt > Date.now()))
  sb.pair = { code, expiresAt: Date.now() + JUDGE.pairCodeMs }
  return sb.pair
}

/** /pair <code> from Telegram: link the sender to the sandbox that issued the code. */
export function redeemPairCode(code: string, telegramId: string, name: string): Sandbox | null {
  const sb = allSandboxes().find(s => s.kind === 'judge' && s.pair?.code === code && s.pair.expiresAt > Date.now())
  if (!sb) return null
  sb.pair = undefined
  sb.telegram = { id: telegramId, name }
  sb.allow.senders.add(telegramId)
  return sb
}

/** Sliding-window quota: true (and counted) if under `max` in the last hour. */
export function takeQuota(sb: Sandbox, kind: 'samples' | 'voice'): boolean {
  if (sb.kind === 'owner') return true
  const max = kind === 'samples' ? JUDGE.samplesPerHour : JUDGE.voicePerHour
  const hourAgo = Date.now() - 3_600_000
  sb.usage[kind] = sb.usage[kind].filter(t => t > hourAgo)
  if (sb.usage[kind].length >= max) return false
  sb.usage[kind].push(Date.now())
  return true
}

export function quotaLeft(sb: Sandbox) {
  const hourAgo = Date.now() - 3_600_000
  return {
    samplesThisHour: Math.max(0, JUDGE.samplesPerHour - sb.usage.samples.filter(t => t > hourAgo).length),
    voiceThisHour: Math.max(0, JUDGE.voicePerHour - sb.usage.voice.filter(t => t > hourAgo).length),
  }
}

/** Drop judge sandboxes idle for a day. */
export function sweepSandboxes(now = Date.now()) {
  for (const sb of byId.values()) {
    if (sb.kind === 'judge' && now - sb.lastSeen > JUDGE.idleExpiryMs) {
      byId.delete(sb.id)
      byToken.delete(sb.token)
    }
  }
}

/**
 * Open judge demo positions, ONE PER COIN. All judges share the owner's Bybit Demo account, where one-way
 * mode keeps one position per coin: two judges on the same coin would merge (a close or a stop would hit
 * both). Each judge gets their own coin instead, so up to ~9 judges can trade at the same time.
 * Each position is closed automatically after JUDGE_AUTO_CLOSE_MS.
 */
export interface JudgePosition { sandboxId: string; cardId: string; symbol: string; side: 'Buy' | 'Sell'; qty: string; openedAt: number }
export const judgePositions = new Map<string, JudgePosition>()
export const judgePositionOf = (sb: Sandbox) => [...judgePositions.values()].find(p => p.sandboxId === sb.id)

/** Coins handed to judges, BTC last (it's the owner's usual coin). Filtered by the symbol whitelist. */
export const JUDGE_COINS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'ADAUSDT', 'BNBUSDT', 'TONUSDT', 'BTCUSDT']
  .filter(c => config.symbolWhitelist.has(c))
const COIN_HOLD_MS = 10 * 60_000 // a judge keeps their coin while active

/** The coin this judge's sample calls use: keep theirs if nobody else is on it, else the first free one. */
export function coinFor(sb: Sandbox, now = Date.now()): string {
  const takenByOther = (c: string) =>
    (judgePositions.get(c) && judgePositions.get(c)!.sandboxId !== sb.id) ||
    allSandboxes().some(o => o !== sb && o.kind === 'judge' && o.coin === c && now - (o.coinAt ?? 0) < COIN_HOLD_MS)
  const own = judgePositionOf(sb)?.symbol
  const pick = own ?? (sb.coin && !takenByOther(sb.coin) ? sb.coin : JUDGE_COINS.find(c => !takenByOther(c)) ?? JUDGE_COINS[0]!)
  sb.coin = pick
  sb.coinAt = now
  return pick
}
export const JUDGE_AUTO_CLOSE_MS = Number(process.env.CALLOUT_JUDGE_AUTOCLOSE_SEC ?? 120) * 1000
