// All tunables in one place. Position size comes ONLY from here (user settings), never from the LLM.
import './env.js'

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got "${raw}"`)
  return v
}

function idList(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )
}

/** Hard ceiling on any single order's notional, regardless of settings. */
export const HARD_MAX_SIZE_USD = 1000

export const config = {
  port: num('PORT', 8787),

  // Telegram allowlist. A message must come from an allowed chat AND an allowed sender
  // (user id, or sender_chat id for anonymous admins / channel posts) to ever become a card.
  allowedChatIds: idList('TELEGRAM_ALLOWED_CHAT_IDS'),
  allowedSenderIds: idList('TELEGRAM_ALLOWED_SENDER_IDS'),

  // User settings.
  sizeUsd: num('CALLOUT_SIZE_USD', 200),
  maxSizeUsd: num('CALLOUT_MAX_SIZE_USD', 500),

  // The user's own rules (0 disables a rule).
  maxTradesPerDay: num('CALLOUT_MAX_TRADES_PER_DAY', 5),
  maxDailyLossUsd: num('CALLOUT_MAX_DAILY_LOSS_USD', 50),
  pauseAfterLosses: num('CALLOUT_PAUSE_AFTER_LOSSES', 2),

  // Checks.
  symbolWhitelist: new Set(
    (process.env.CALLOUT_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,TONUSDT')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean),
  ),
  maxEntryDistancePct: num('CALLOUT_MAX_ENTRY_DISTANCE_PCT', 3),
  callExpiryMs: num('CALLOUT_CALL_EXPIRY_MIN', 15) * 60_000,
  cancelWindowMs: num('CALLOUT_CANCEL_WINDOW_SEC', 5) * 1000,

  // LLM: extraction only.
  parseModel: 'claude-haiku-5-5',

  // Demo replay endpoint (POST /api/demo/message). Off unless explicitly enabled.
  demoMode: process.env.CALLOUT_DEMO_MODE === '1',
} as const

if (config.sizeUsd <= 0) throw new Error('CALLOUT_SIZE_USD must be > 0')
if (config.sizeUsd > config.maxSizeUsd || config.maxSizeUsd > HARD_MAX_SIZE_USD) {
  throw new Error(
    `Size cap violated: CALLOUT_SIZE_USD=${config.sizeUsd}, CALLOUT_MAX_SIZE_USD=${config.maxSizeUsd}, hard max ${HARD_MAX_SIZE_USD}`,
  )
}
