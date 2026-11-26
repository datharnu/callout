import { test } from 'node:test'
import assert from 'node:assert/strict'
import { numbersInText, runChecks, scamFlags, traceable } from '../src/checks.js'
import type { ParsedCall } from '../src/types.js'

const S = { symbolWhitelist: new Set(['BTCUSDT', 'SOLUSDT']), maxEntryDistancePct: 3, callExpiryMs: 15 * 60_000 }
const NOW = 1_800_000_000_000
const call = (over: Partial<ParsedCall> = {}): ParsedCall => ({
  kind: 'trade_call', symbol: 'BTCUSDT', side: 'long', entry: 60400, stop: 59000, targets: [63000],
  leverage: null, confidence: 0.95, quote: '', ...over,
})
const run = (parsed: ParsedCall, rawText: string, livePrice: number | undefined = 60500, sentAt = NOW - 60_000) =>
  runChecks({ parsed, rawText, livePrice, sentAt, now: NOW }, S)

test('numbersInText expands k and commas', () => {
  assert.deepEqual(numbersInText('LONG BTC 60.4k SL 59,000 TP 63k x10'), [60400, 59000, 63000, 10])
})

test('traceable: as written, shorthand, range midpoint', () => {
  const w = numbersInText('entry 60000-61000 SL 59 TP 63k')
  assert.ok(traceable(60500, w)) // midpoint
  assert.ok(traceable(59000, w)) // "SL 59" shorthand
  assert.ok(traceable(63000, w))
  assert.ok(!traceable(70000, w))
})

test('clean long call is ready with facts', () => {
  const v = run(call(), 'LONG BTC entry 60.4k SL 59k TP 63k')
  assert.equal(v.state, 'ready')
  assert.equal(v.facts.rr, 1.9)
  assert.ok(Math.abs(v.facts.distancePct! - 0.1656) < 0.01)
})

test('short with reversed levels is ready', () => {
  const v = run(call({ side: 'short', stop: 61500, targets: [58000] }), 'SHORT BTC 60.4k SL 61.5k TP 58k')
  assert.equal(v.state, 'ready')
})

test('stop on wrong side is blocked', () => {
  const v = run(call({ stop: 61000 }), 'LONG BTC 60.4k SL 61k TP 63k')
  assert.equal(v.state, 'blocked')
  assert.ok(v.flags.includes('stop above entry'))
})

test('hallucinated numbers are blocked', () => {
  const v = run(call({ targets: [70000] }), 'LONG BTC 60.4k SL 59k TP 63k')
  assert.ok(v.flags.includes('values not found in message'))
})

test('entry too far from live price is blocked with distance', () => {
  const v = run(call(), 'LONG BTC 60.4k SL 59k TP 63k', 62600)
  assert.equal(v.state, 'blocked')
  assert.ok(v.flags.some(f => /price 3\.6% from call/.test(f)), v.flags.join())
})

test('coin not on whitelist', () => {
  const v = run(call({ symbol: 'PEPEUSDT', entry: 0.00001, stop: 0.000009, targets: [0.000012] }), 'long pepe 0.00001 sl 0.000009 tp 0.000012')
  assert.ok(v.flags.includes('coin not on list'))
})

test('scam wording and links are flagged', () => {
  assert.deepEqual(scamFlags('GUARANTEED 10x, join t.me/pumpzone'), ['contains link', 'says "guaranteed"'])
  const v = run(call(), 'LONG BTC 60.4k SL 59k TP 63k guaranteed profit https://x.io')
  assert.equal(v.state, 'blocked')
})

test('low confidence / non-call is unsure, never ready', () => {
  assert.equal(run(call({ confidence: 0.4 }), 'btc maybe up?').state, 'unsure')
  assert.equal(run(call({ kind: 'holding_update' }), 'taking profit on BTC').state, 'unsure')
})

test('expired call', () => {
  assert.equal(run(call(), 'LONG BTC 60.4k SL 59k TP 63k', 60500, NOW - 16 * 60_000).state, 'expired')
})

test('missing live price blocks', () => {
  const v = runChecks({ parsed: call(), rawText: 'LONG BTC 60.4k SL 59k TP 63k', livePrice: undefined, sentAt: NOW - 60_000, now: NOW }, S)
  assert.equal(v.state, 'blocked')
  assert.ok(v.flags.includes('live price unavailable'))
})

test('price already past stop', () => {
  const v = run(call(), 'LONG BTC 60.4k SL 59k TP 63k', 58900)
  assert.ok(v.flags.includes('price already past stop'))
})

test('user stop override: replaces caller stop, exempt from traceability, still side-checked', () => {
  const base = { parsed: call(), rawText: 'LONG BTC entry 60.4k SL 59k TP 63k', livePrice: 60500, sentAt: NOW - 60_000, now: NOW }
  const ok = runChecks({ ...base, stopOverride: 59200 }, S)
  assert.equal(ok.state, 'ready')
  assert.equal(ok.facts.rr, Math.round((2600 / 1200) * 10) / 10) // R:R uses the user's stop
  const wrong = runChecks({ ...base, stopOverride: 61000 }, S)
  assert.ok(wrong.flags.includes('stop above entry'))
  const tight = runChecks({ ...base, stopOverride: 60350 }, S) // just under entry, live above it
  assert.equal(tight.state, 'ready')
  const behind = runChecks({ ...base, livePrice: 60300, stopOverride: 60350 }, S)
  assert.ok(behind.flags.includes('price already past stop'))
})

test('user stop fixes a call that had no stop', () => {
  const parsed = call({ stop: null })
  const raw = 'BTC long 60.4k, no stop, tp 63k'
  assert.ok(runChecks({ parsed, rawText: raw, livePrice: 60500, sentAt: NOW - 60_000, now: NOW }, S).flags.includes('no stop-loss'))
  assert.equal(runChecks({ parsed, rawText: raw, livePrice: 60500, sentAt: NOW - 60_000, now: NOW, stopOverride: 59000 }, S).state, 'ready')
})
