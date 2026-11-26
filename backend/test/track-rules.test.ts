import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCall, resolveOutcome, type Candle } from '../src/track.js'
import { ruleFlags } from '../src/rules.js'

const T0 = 1_790_000_000_000 - (1_790_000_000_000 % 60_000)
const c = (i: number, low: number, high: number): Candle => ({ start: T0 + i * 60_000, low, high })
const long = { side: 'long' as const, entry: 100, stop: 95, target: 110, sent_at: T0 }
const short = { side: 'short' as const, entry: 100, stop: 105, target: 90, sent_at: T0 }
const LATER = T0 + 8 * 24 * 3_600_000

test('long: entry then TP', () => {
  assert.deepEqual(resolveOutcome(long, [c(0, 99, 101), c(1, 100, 106), c(2, 104, 111)], LATER), { outcome: 'tp', at: c(2, 0, 0).start })
})
test('long: entry then SL', () => {
  assert.equal(resolveOutcome(long, [c(0, 99, 101), c(1, 94, 100)], LATER).outcome, 'sl')
})
test('TP before entry does not count', () => {
  // Price runs to 112 without ever touching 100 first, then comes back and stops out.
  assert.equal(resolveOutcome(long, [c(0, 101, 112), c(1, 99, 102), c(2, 94, 100)], LATER).outcome, 'sl')
})
test('both in one candle is ambiguous', () => {
  assert.equal(resolveOutcome(long, [c(0, 99, 101), c(1, 94, 111)], LATER).outcome, 'ambiguous')
})
test('short mirrors long', () => {
  assert.equal(resolveOutcome(short, [c(0, 99, 101), c(1, 89, 100)], LATER).outcome, 'tp')
  assert.equal(resolveOutcome(short, [c(0, 99, 101), c(1, 100, 106)], LATER).outcome, 'sl')
})
test('never entered: open within 7 days, no_entry after', () => {
  const cs = [c(0, 101, 103), c(1, 102, 104)]
  assert.equal(resolveOutcome(long, cs, T0 + 3_600_000).outcome, 'open')
  assert.equal(resolveOutcome(long, cs, LATER).outcome, 'no_entry')
})
test('entered but unresolved after 7 days is expired', () => {
  assert.equal(resolveOutcome(long, [c(0, 99, 101), c(1, 98, 102)], LATER).outcome, 'expired')
})
test('candles before the call are ignored', () => {
  assert.equal(resolveOutcome(long, [c(-5, 90, 120), c(0, 99, 101), c(1, 100, 111)], LATER).outcome, 'tp')
})

const R = { maxTradesPerDay: 5, maxDailyLossUsd: 50, pauseAfterLosses: 2 }
test('rules: none triggered', () => {
  assert.deepEqual(ruleFlags({ tradesToday: 2, pnlToday: -10, lossStreak: 1 }, R), [])
})
test('rules: each limit produces a factual flag', () => {
  assert.deepEqual(ruleFlags({ tradesToday: 5, pnlToday: -50.5, lossStreak: 2 }, R), [
    'rule: 5/5 trades today',
    'rule: down $50.50 today, limit $50',
    'rule: paused after 2 losses in a row',
  ])
})
test('rules: 0 disables a rule', () => {
  assert.deepEqual(ruleFlags({ tradesToday: 99, pnlToday: -999, lossStreak: 9 }, { maxTradesPerDay: 0, maxDailyLossUsd: 0, pauseAfterLosses: 0 }), [])
})

test('paging: a TP on a later page is found (not declared expired after page 1)', async () => {
  const call = { ...long, symbol: 'X' }
  // Entered in minute 0, nothing for ~2 pages, TP hit ~1 day later.
  const all = [c(0, 99, 101), ...Array.from({ length: 1500 }, (_, i) => c(i + 1, 98, 102)), c(1600, 105, 112)]
  const fetch = async (_s: string, start: number, end: number) => all.filter(x => x.start >= start && x.start < end)
  assert.equal((await evaluateCall(call, LATER, fetch)).outcome, 'tp')
})
