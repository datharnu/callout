import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deobfuscate, runChecks, scamFlags } from '../src/checks.js'
import { hiddenLinks } from '../src/tg-util.js'

const CALL = 'LONG BTC entry 60.5k SL 59.3k TP 63k.'

test('disguised links are still links (red-team r24–r29)', () => {
  for (const tail of ['Join t . me/vip', 'Join t[.]me/vip', 'Join t(dot)me/vip', 'More at vipsignals dot com', 'More at hxxps://vip.xyz', 'Join t​.me/vip', 'Join ｔ.ｍｅ/vip']) {
    assert.ok(scamFlags(`${CALL} ${tail}`).includes('contains link'), tail)
  }
})

test('ordinary calls are not mistaken for links', () => {
  for (const text of [CALL, 'ETH short 2400 . SL 2450 . TP 2300', 'SOL long 140.5 SL 137 TP 146', 'BTC long, see you all at 9 . more later']) {
    assert.ok(!scamFlags(text).includes('contains link'), text)
  }
  assert.equal(deobfuscate('LONG BTC 60.5k'), 'LONG BTC 60.5k')
})

test('a link hidden behind text (Telegram text_link) blocks the card (red-team r30)', () => {
  const links = hiddenLinks({ entities: [{ type: 'bold' }, { type: 'text_link', url: 'https://t.me/vip' }] })
  assert.deepEqual(links, ['https://t.me/vip'])
  const parsed = { kind: 'trade_call' as const, symbol: 'BTCUSDT', side: 'long' as const, entry: 60500, stop: 59300, targets: [63000], leverage: null, confidence: 1, quote: '' }
  const base = { parsed, rawText: `${CALL} Join VIP`, livePrice: 60500, sentAt: 0, now: 0 }
  const s = { symbolWhitelist: new Set(['BTCUSDT']), maxEntryDistancePct: 3, callExpiryMs: 900_000 }
  assert.equal(runChecks(base, s).state, 'ready')
  const v = runChecks({ ...base, hiddenLinks: links }, s)
  assert.equal(v.state, 'blocked')
  assert.ok(v.flags.includes('contains hidden link'))
})
