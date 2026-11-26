// Scripted demo for recording the video. Press Enter to advance each scene while you screen-record.
// Real where it matters: YOU post the call in Telegram and YOU speak the voice commands; orders go
// to Bybit Demo for real. Supporting scenes (noise, scam, impostor...) are replayed into the pipeline.
// Saves a glasses screenshot per scene to screenshots/demo/.
//
// Needs: backend with CALLOUT_DEMO_MODE=1 (the script tells you the exact command), the glasses dev
// server, and the simulator started from YOUR terminal (for mic permission).
// Usage: npm run demo
//        DEMO_REHEARSAL=1 npm run demo   (unattended dry run: replays the call, speaks with macOS `say`)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { mainnetPublic } from '../src/bybit/client.js'

const API = process.env.CALLOUT_API ?? 'http://127.0.0.1:8787'
const SIM = process.env.CALLOUT_SIM ?? 'http://127.0.0.1:9898'
const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../screenshots/demo')
mkdirSync(SHOTS, { recursive: true })

const REHEARSAL = process.env.DEMO_REHEARSAL === '1'
const rl = createInterface({ input: process.stdin, output: process.stdout })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const say = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)
const note = (s: string) => console.log(`   ${s}`)
const enter = async (what = 'continue') => {
  if (REHEARSAL) return void (console.log(`   (rehearsal) ${what}`), await sleep(1500))
  await rl.question(`   ⏎  Enter to ${what}… `)
}
/** Rehearsal only: speak a phrase (macOS `say`, 16 kHz PCM) to a card through the real voice endpoint. */
async function speak(cardId: string, phrase: string) {
  const wav = path.join(tmpdir(), 'callout-demo.wav')
  execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', '--file-format=WAVE', phrase])
  const buf = readFileSync(wav)
  const r = await fetch(`${API}/api/cards/${encodeURIComponent(cardId)}/voice`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(buf.subarray(buf.indexOf('data') + 8)),
  }).then(x => x.json() as Promise<any>)
  note(`(rehearsal) said "${phrase}" → heard "${r.heard}" → ${r.note?.message}`)
}

async function get(p: string) {
  const r = await fetch(`${API}${p}`)
  if (!r.ok) throw new Error(`${p} → ${r.status}`)
  return r.json() as Promise<any>
}
async function post(p: string, body?: unknown) {
  const r = await fetch(`${API}${p}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json() as Promise<any>
}
const replay = (text: string, extra: Record<string, unknown> = {}) => post('/api/demo/message', { text, ...extra })
const act = (id: string, a: string) => post(`/api/cards/${encodeURIComponent(id)}/${a}`)
const input = (action: string) =>
  fetch(`${SIM}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
async function shot(name: string) {
  const r = await fetch(`${SIM}/api/screenshot/glasses`)
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(await r.arrayBuffer()))
  note(`📸 screenshots/demo/${name}.png`)
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 120_000): Promise<T | undefined> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn().catch(() => undefined)
    if (v) return v as T
    await sleep(500)
  }
  note(`(timed out waiting for ${what})`)
  return undefined
}
const cards = async () => (await get('/api/state')).cards as any[]
async function clearCards() {
  for (const c of await cards()) await act(c.id, ['ready', 'blocked', 'unsure', 'holding'].includes(c.state) ? 'skip' : 'dismiss')
}
const r100 = (v: number) => Math.round(v / 100) * 100
const k = (v: number) => `${Number((v / 1000).toFixed(1))}k`

// ── Preflight ───────────────────────────────────────────────────────────────────────────────
say('Callout demo · preflight')
const settings = await get('/api/settings').catch(() => null)
if (!settings) throw new Error(`Backend not reachable at ${API}`)
if (!(await fetch(`${SIM}/api/ping`).then(r => r.ok).catch(() => false))) throw new Error(`Simulator not reachable at ${SIM}. Start it from your terminal: cd glasses && npm run simulate`)
const wantLimit = settings.tradesToday + 1
const ok = settings.demoMode && settings.rules.maxTradesPerDay === wantLimit && settings.rules.pauseAfterLosses === 0
note(`trades today: ${settings.tradesToday} · rules: ${JSON.stringify(settings.rules)} · demo mode: ${settings.demoMode}`)
if (!ok) {
  say('Restart the backend for the demo with:')
  note(`cd backend && CALLOUT_DEMO_MODE=1 CALLOUT_PAUSE_AFTER_LOSSES=0 CALLOUT_MAX_TRADES_PER_DAY=${wantLimit} npm run dev`)
  note('(your live trade in scene 2 reaches the daily limit, so scene 4 shows a real rule block)')
  rl.close()
  process.exit(1)
}
const pos = await import('../src/bybit/demo.js').then(m => import('../src/positions.js').then(p => p.listPositions(m.bybit)))
if (pos.length) note(`⚠ open demo positions: ${pos.map(p => `${p.symbol} ${p.side} ${p.size}`).join(', ')}. Close them first: npm run positions -- --close`)
await clearCards()
note('ready. Start your screen recording (glasses simulator + Telegram + this terminal).')
await enter('start')

// ── Scene 1: session mode ───────────────────────────────────────────────────────────────────
say('Scene 1 · Session mode. "One of these matters."')
for (const t of ['gm everyone', 'BTC chart update coming tonight', 'anyone trading SOL today?', 'lol this market', 'thanks admin 🙏', 'ETH ETF inflows hit $420M today'])
  await replay(t)
await replay('LONG BTC entry 60k SL 59k TP 63k', { senderId: '123456', senderName: '@impostor' }) // non-allowlisted → muted
const px0 = Number((await mainnetPublic('/v5/market/tickers', { category: 'linear', symbol: 'BTCUSDT' })).list[0].lastPrice)
await replay(`LONG BTC entry ${r100(px0)} SL ${r100(px0 * 0.98)} TP ${r100(px0 * 1.04)}`, { sentAt: Date.now() - 20 * 60_000 }) // expired while away
await sleep(1500)
await shot('01-home-session')
note('Glasses: "N muted · 0 for you · 1 call while away (expired)". The impostor\'s call and the chatter never became cards.')
await enter('go to the live call')

// ── Scene 2: live Telegram call ─────────────────────────────────────────────────────────────
const px = Number((await mainnetPublic('/v5/market/tickers', { category: 'linear', symbol: 'BTCUSDT' })).list[0].lastPrice)
const [E, S, T] = [r100(px), r100(px * 0.98), r100(px * 1.04)]
const S2 = r100(px * 0.985)
say('Scene 2 · Post this in your Telegram group NOW:')
console.log(`\n      LONG BTC entry ${k(E)} SL ${k(S)} TP ${k(T)}\n`)
const rehearsalId = REHEARSAL ? (await replay(`LONG BTC entry ${k(E)} SL ${k(S)} TP ${k(T)}`, { senderName: '@Cotz6' })).card?.id : undefined
const live = await waitFor('the Telegram call', async () =>
  (await cards()).find(c => c.state === 'ready' && (REHEARSAL ? c.id === rehearsalId : c.chat !== 'Demo replay')),
)
if (!live) throw new Error('No live card arrived. Is the bot in the group and the backend running?')
await sleep(1500)
await shot('02-live-card')
note(`Card: ${live.side} ${live.symbol} · ${live.distancePct?.toFixed(2)}% from call · R:R ${live.rr} · caller record (synthetic)`)

say(`Scene 3 · Say: "half size, set stop ${k(S2).replace('k', ' K')}"`)
if (REHEARSAL) await speak(live.id, `half size, set stop ${k(S2).replace('k', ' K')}`)
const voiced = await waitFor('your voice command', async () => {
  const c = (await cards()).find(x => x.id === live.id)
  return c && c.sizeUsd < live.sizeUsd && c.userStop ? c : undefined
}, 60_000)
await sleep(1000)
await shot('03-voice-applied')
if (voiced) note(`Applied: $${voiced.sizeUsd}, SL ${voiced.userStop} (yours), R:R ${voiced.rr}`)
await enter('TAP (place the demo order)')
await input('click')
await sleep(1200)
await shot('04-countdown')
const filled = await waitFor('the fill', async () => {
  const c = (await cards()).find(x => x.id === live.id)
  return c && ['filled', 'failed', 'blocked'].includes(c.state) ? c : undefined
}, 30_000)
await sleep(800)
await shot('05-filled')
if (filled?.order) {
  const id = filled.order.orderId
  const shortId = `${id.slice(0, 8)}...${id.slice(-4)}`
  const bar = '═'.repeat(id.length + 4)
  console.log(`\n   ╔${bar}╗\n   ║  ${id}  ║   ← FULL ORDER ID\n   ╚${bar}╝`)
  note(`FILLED ${filled.order.qty} @ ${filled.order.avgPrice} · glasses show ${shortId}`)
  say('Show the proof now (hold each shot ~3 s):')
  note(`1. Glasses: "Order ${shortId} · Bybit Demo"`)
  note(`2. bybit.com → Demo Trading → Orders → Order History: the row whose Order ID starts ${id.slice(0, 8)}`)
  note('3. Telegram: the receipt reply under your call, with the same short ID')
} else note(`Not filled: ${filled?.state} ${filled?.error ?? filled?.flags?.join(', ')}`)
await enter('continue to safety')
await input('click') // dismiss result
await sleep(1200)

// ── Scene 4: safety ─────────────────────────────────────────────────────────────────────────
say('Scene 4 · Safety')
const scam = (await replay(`🔥 GUARANTEED 100% WIN 🔥 LONG BTC ${E} SL ${S} TP ${T} join t.me/vip_pumps`, { senderName: '@Cotz6' })).card
await sleep(1800)
await shot('06-scam-blocked')
note(`Scam call → blocked: ${scam?.flags?.join(' · ')}`)
await enter('next')
await act(scam.id, 'skip')
const vague = await replay('btc looking spicy here 👀 might long soon, levels later', { senderName: '@Cotz6' })
note(vague.card ? `Vague message → ${vague.card.state}` : `Vague message → ${vague.outcome} (${vague.reason}): never a card`)
const rule = (await replay(`LONG BTC entry ${E} SL ${S} TP ${T}`, { senderName: '@Cotz6' })).card
await sleep(1800)
await shot('07-rule-blocked')
note(`Your own rule → ${rule?.state}: ${rule?.flags?.join(' · ')}`)
await enter('next')
if (rule) await act(rule.id, 'skip')

// ── Scene 5: holding update + reduce-only close ─────────────────────────────────────────────
say('Scene 5 · Holding update')
const hold = await replay('Taking profit on BTC here, closing the long', { senderName: '@Cotz6' })
if (!hold.card) {
  note(`No holding card (${hold.reason}). Is the BTC position from scene 2 still open?`)
} else {
  await sleep(1800)
  await shot('08-holding')
  say('Say: "close it"')
  if (REHEARSAL) await speak(hold.card.id, 'close it')
  await waitFor('"close it"', async () => {
    const c = (await cards()).find(x => x.id === hold.card.id)
    return c?.voice?.command?.includes('close') ? c : undefined
  }, 60_000)
  await sleep(800)
  await shot('09-holding-close-selected')
  await enter('TAP (confirm the reduce-only close)')
  await input('click')
  await waitFor('the close', async () => {
    const c = (await cards()).find(x => x.id === hold.card.id)
    return c && ['filled', 'failed'].includes(c.state) ? c : undefined
  }, 30_000)
  await sleep(800)
  await shot('10-closed')
}
await enter('finish')
await input('click')

// ── Scene 6: proof ──────────────────────────────────────────────────────────────────────────
say('Scene 6 · Proof (show these on screen)')
note('Parser + checks: 0 unsafe one-tap cards · 23/23 tradable calls shown · 6/6 impostors muted (backend/eval/RESULTS.md)')
note('Voice: 0 risky misfires · 95% correct across 6 accents · ~0.5 s speech-to-text (backend/eval/VOICE_RESULTS.md)')
const after = await import('../src/bybit/demo.js').then(m => import('../src/positions.js').then(p => p.listPositions(m.bybit)))
note(`Demo positions now: ${after.length ? after.map(p => `${p.symbol} ${p.side} ${p.size}`).join(', ') : 'flat'}`)
say('Done. Screenshots are in screenshots/demo/.')
rl.close()
