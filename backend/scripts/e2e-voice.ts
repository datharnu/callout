// End-to-end voice test against a running backend (CALLOUT_DEMO_MODE=1), macOS only.
// Each phrase is spoken by macOS `say` into 16 kHz s16le mono PCM, i.e. the exact format the
// G2 mic produces, and sent to POST /api/cards/:id/voice. Real speech-to-text, real checks.
// Places NO orders (the one countdown is cancelled by voice).
//
// Usage: npm run e2e:voice
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mainnetPublic } from '../src/bybit/client.js'

const API = process.env.CALLOUT_API ?? 'http://127.0.0.1:8787'
const dir = mkdtempSync(path.join(tmpdir(), 'callout-voice-'))

/** Speak a phrase to raw PCM (strip the 44-byte WAV header after checking the format). */
function speak(phrase: string): Buffer {
  const wav = path.join(dir, 'p.wav')
  execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', '--file-format=WAVE', phrase])
  const buf = readFileSync(wav)
  const dataIdx = buf.indexOf('data')
  if (dataIdx < 0 || buf.readUInt32LE(24) !== 16000 || buf.readUInt16LE(22) !== 1) throw new Error('unexpected WAV format')
  return buf.subarray(dataIdx + 8)
}

async function voice(cardId: string, pcm: Buffer) {
  const r = await fetch(`${API}/api/cards/${encodeURIComponent(cardId)}/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(pcm),
  })
  return (await r.json()) as any
}
const say = (cardId: string, phrase: string) => voice(cardId, speak(phrase))
const replay = async (text: string) =>
  ((await (await fetch(`${API}/api/demo/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json()) as any).card
const act = (id: string, a: string) => fetch(`${API}/api/cards/${encodeURIComponent(id)}/${a}`, { method: 'POST' }).then(r => r.json() as any)

const results: boolean[] = []
function expect(name: string, ok: boolean, got: unknown) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${typeof got === 'string' ? got : JSON.stringify(got)}`)
}
const show = (r: any) => `heard "${r.heard}" → ${r.note?.result}: ${r.note?.message} [card ${r.card?.state}, $${r.card?.sizeUsd}, stop ${r.card?.userStop ?? r.card?.stop}]`

try {
  const px = Number((await mainnetPublic('/v5/market/tickers', { category: 'linear', symbol: 'BTCUSDT' })).list[0].lastPrice)
  const r100 = (v: number) => Math.round(v / 100) * 100
  const [E, S, T] = [r100(px), r100(px * 0.98), r100(px * 1.04)]
  const k = (v: number) => `${(v / 1000).toFixed(1)}k`
  console.log(`BTC ${px} · test call ${E} / SL ${S} / TP ${T}\n`)

  const card = await replay(`LONG BTC entry ${E} SL ${S} TP ${T}`)
  if (card?.state !== 'ready') throw new Error(`setup card not ready: ${JSON.stringify(card?.flags)}`)
  const id = card.id

  let r = await say(id, 'half size')
  expect('"half size" halves the order', r.card.sizeUsd === 100 && r.note.result === 'applied' && r.card.state === 'ready', show(r))

  r = await say(id, 'full size')
  expect('"full size" restores it', r.card.sizeUsd === 200, show(r))

  const tight = r100(px * 0.985)
  r = await say(id, `set stop ${k(tight)}`)
  expect('"set stop 59.x k" sets the user stop, checks re-run, still ready', r.card.userStop === tight && r.card.state === 'ready', show(r))

  const above = r100(px * 1.01)
  r = await say(id, `set stop ${k(above)}`)
  expect('stop above entry by voice → blocked by code checks', r.card.state === 'blocked' && r.card.flags.includes('stop above entry'), show(r))

  r = await say(id, `move stop to ${k(tight)}`)
  expect('fixing the stop by voice → ready again', r.card.state === 'ready' && r.card.userStop === tight, show(r))

  r = await say(id, `half size, set stop ${k(tight)}`)
  expect('one sentence, two commands: half size AND set stop', r.card.sizeUsd === 100 && r.card.userStop === tight && r.card.state === 'ready', show(r))
  await say(id, 'full size')

  r = await say(id, 'set stop')
  expect('"set stop" then a pause: asks for the price, changes nothing yet', r.note.result === 'partial' && r.card.userStop === tight, show(r))
  const tighter = r100(px * 0.99)
  r = await say(id, k(tighter))
  expect('…then just the price completes it', r.card.userStop === tighter && r.card.state === 'ready', show(r))

  r = await say(id, 'place it')
  expect('"place it" only selects: no order, card still ready', r.note.result === 'selected' && r.card.state === 'ready' && !r.card.order, show(r))

  r = await say(id, 'banana smoothie')
  expect('unrecognised speech → hint, nothing changes', r.note.result === 'not_understood' && r.card.state === 'ready', show(r))

  r = await say(id, 'close it')
  expect('"close" on a call card → not available', r.note.result === 'not_available', show(r))

  const c = await act(id, 'confirm') // the tap
  expect('tap starts the countdown', c.state === 'countdown', c.state)
  r = await say(id, 'cancel')
  expect('"cancel" during countdown cancels immediately, no order', r.card.state === 'cancelled' && !r.card.order, show(r))

  r = await say(id, 'okay')
  expect('"okay" dismisses the result', r.note.result === 'done', show(r))

  const second = await replay(`LONG BTC entry ${E} SL ${S} TP ${T}`)
  r = await say(second.id, 'skip this one')
  expect('"skip this one" skips', r.card.state === 'skipped', show(r))

  const scam = await replay(`GUARANTEED 100% WIN LONG BTC ${E} SL ${S} TP ${T} join t.me/vip`)
  r = await say(scam.id, 'place it')
  expect('"place it" on a blocked scam card → not available', r.note.result === 'not_available' && r.card.state === 'blocked', show(r))
  await act(scam.id, 'skip')

  const blip = await replay(`LONG BTC entry ${E} SL ${S} TP ${T}`)
  r = await voice(blip.id, Buffer.alloc(1600)) // 50 ms of silence
  expect('too-short audio → "Didn\'t catch that"', r.note.result === 'error', show(r))
  await act(blip.id, 'skip')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed ? 1 : 0
