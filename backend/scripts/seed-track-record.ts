// Seed a SYNTHETIC caller track record for the demo (see README, "Caller track record").
// Calls are invented, but each uses a real past mainnet price as entry at a real timestamp from the
// last 30 days, so the outcomes (TP / SL / open, from 1-minute candles) are what really happened.
// Rows are flagged synthetic=1 and the UI labels them "synthetic".
//
// Usage: npm run seed:track             (seeds every allowlisted sender)
//        npm run seed:track -- --clear  (remove synthetic rows only)
import { config } from '../src/config.js'
import { mainnetPublic } from '../src/bybit/client.js'
import { db, insertCall } from '../src/db.js'
import { recordFor, refreshOutcomes } from '../src/track.js'

const senders = [...config.allowedSenderIds]
if (!senders.length) throw new Error('No allowlisted senders in .env')

db.prepare('DELETE FROM calls WHERE synthetic = 1').run()
if (process.argv.includes('--clear')) {
  console.log('Synthetic calls removed.')
  process.exit(0)
}

let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const HOUR = 3_600_000
const now = Date.now()
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

// Hourly closes for the last 30 days, used as realistic entries.
const hourly: Record<string, { t: number; close: number }[]> = {}
for (const s of symbols) {
  const r = await mainnetPublic('/v5/market/kline', { category: 'linear', symbol: s, interval: '60', start: now - 30 * 24 * HOUR, limit: 1000 })
  hourly[s] = (r.list as string[][]).map(k => ({ t: Number(k[0]), close: Number(k[4]) })).sort((a, b) => a.t - b.t)
}

const round = (v: number) => {
  const [step, dp] = v > 10_000 ? [50, 0] : v > 1000 ? [5, 0] : [0.1, 1]
  return Number((Math.round(v / step) * step).toFixed(dp))
}

for (const sender of senders) {
  const N = 11
  for (let i = 0; i < N; i++) {
    const symbol = symbols[Math.floor(rand() * symbols.length)]!
    const bars = hourly[symbol]!
    // Spread over the month; keep the last two recent so some are still open.
    const idx = i < N - 2 ? Math.floor(rand() * (bars.length - 72)) : bars.length - 1 - Math.floor(rand() * 20)
    const bar = bars[idx]!
    const side = rand() < 0.6 ? 'long' : 'short'
    const risk = 0.015 + rand() * 0.015
    const reward = risk * (1.2 + rand() * 1.3)
    const entry = round(bar.close)
    const stop = round(side === 'long' ? entry * (1 - risk) : entry * (1 + risk))
    const target = round(side === 'long' ? entry * (1 + reward) : entry * (1 - reward))
    insertCall({
      id: `synthetic:${sender}:${i}`,
      chat_id: 'synthetic',
      sender_id: sender,
      sender_name: 'synthetic',
      symbol, side, entry, stop, target,
      sent_at: bar.t + HOUR - 60_000, // last minute of that hour, so the entry is near the live price
      synthetic: 1,
    })
  }
}

console.log('Resolving outcomes from 1-minute mainnet candles...')
await refreshOutcomes()
for (const s of senders) {
  const r = recordFor(s)
  console.log(`${s}: Seen ${r.seen} · ${r.tp} TP · ${r.sl} SL · ${r.open} open · ${r.noEntry} no entry/expired · ${r.ambiguous} ambiguous (synthetic)`)
}
const rows = db.prepare(`SELECT symbol, side, entry, stop, target, datetime(sent_at/1000,'unixepoch') at, outcome FROM calls WHERE synthetic=1 ORDER BY sent_at`).all()
console.table(rows)
