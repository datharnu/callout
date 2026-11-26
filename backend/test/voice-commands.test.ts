import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpret, normalize, resolvePrice, type VoiceContext } from '../src/voice/commands.js'

const ready: VoiceContext = { state: 'ready', action: 'open', entry: 60400 }
const blocked: VoiceContext = { state: 'blocked', action: 'open', entry: 60400 }
const holding: VoiceContext = { state: 'holding', action: 'close', entry: null }
const countdown: VoiceContext = { state: 'countdown', action: 'open', entry: 60400 }
const filled: VoiceContext = { state: 'filled', action: 'open', entry: 60400 }
const sol: VoiceContext = { state: 'ready', action: 'open', entry: 140 }

const cmd = (t: string, ctx: VoiceContext) => {
  const r = interpret(t, ctx)
  return r.ok ? r.command : `x:${r.reason}`
}

test('normalize keeps decimals and k, drops sentence punctuation', () => {
  assert.equal(normalize('Set stop 59.2k.'), 'set stop 59.2k')
  assert.equal(normalize('Set stop 59,200'), 'set stop 59,200')
  assert.equal(normalize("Don't! Cancel."), 'dont cancel')
})

test('real ElevenLabs transcripts', () => {
  assert.deepEqual(cmd('half size', ready), { type: 'size', factor: 0.5 })
  assert.deepEqual(cmd('Set stop 59,200', ready), { type: 'set_stop', price: 59200 })
  assert.deepEqual(cmd('Set stop 59.2k', ready), { type: 'set_stop', price: 59200 })
  assert.deepEqual(cmd('Move stop to 134.5', sol), { type: 'set_stop', price: 134.5 })
  assert.deepEqual(cmd('Skip this one', ready), { type: 'skip' })
  assert.deepEqual(cmd('Cancel', countdown), { type: 'cancel' })
  assert.deepEqual(cmd('Close it', holding), { type: 'close' })
})

test('shorthand stop resolves to the entry scale', () => {
  assert.deepEqual(cmd('set stop 59.2', ready), { type: 'set_stop', price: 59200 })
  assert.deepEqual(cmd('stop loss 59', ready), { type: 'set_stop', price: 59000 })
  assert.equal(resolvePrice(5, 60400), null) // 5 or 5000: neither is near 60k
  assert.equal(cmd('set stop 5', ready), 'x:no_price')
})

test('"stop" alone: cancel during countdown, not understood on a card', () => {
  assert.deepEqual(cmd('stop', countdown), { type: 'cancel' })
  assert.deepEqual(cmd('wait', countdown), { type: 'cancel' })
  assert.deepEqual(cmd('no', countdown), { type: 'cancel' })
  assert.equal(cmd('stop', ready), 'x:not_understood')
})

test('place is selection only, and only where it makes sense', () => {
  assert.deepEqual(cmd('place it', ready), { type: 'place' })
  assert.deepEqual(cmd('yes take it', ready), { type: 'place' })
  assert.equal(cmd('place it', blocked), 'x:not_available')
  assert.equal(cmd('buy', holding), 'x:not_available')
})

test('holding: close / keep; skip means keep', () => {
  assert.deepEqual(cmd('take profit', holding), { type: 'close' })
  assert.deepEqual(cmd('keep it', holding), { type: 'keep' })
  assert.deepEqual(cmd('skip', holding), { type: 'keep' })
  assert.equal(cmd('half size', holding), 'x:not_available')
})

test('countdown: any other command cancels (fail-safe), never modifies the order', () => {
  assert.deepEqual(cmd('half size', countdown), { type: 'cancel' })
  assert.deepEqual(cmd('set stop 59k', countdown), { type: 'cancel' })
  assert.deepEqual(cmd('skip', countdown), { type: 'cancel' })
})

test('blocked card: stop can be fixed, nothing tradable', () => {
  assert.deepEqual(cmd('set stop 59k', blocked), { type: 'set_stop', price: 59000 })
  assert.equal(cmd('half size', blocked), 'x:not_available')
})

test('result screens: ok / next / continue dismiss', () => {
  for (const t of ['ok', 'okay', 'continue', 'next', 'got it']) assert.deepEqual(cmd(t, filled), { type: 'dismiss' })
})

test('navigation: "go back" is prev, not place', () => {
  assert.deepEqual(cmd('go back', ready), { type: 'prev' })
  assert.deepEqual(cmd('next one', ready), { type: 'next' })
})

test('noise and empty', () => {
  assert.equal(cmd('', ready), 'x:empty')
  assert.equal(cmd('what a market today', ready), 'x:not_understood')
  const r = interpret('banana', ready)
  assert.ok(!r.ok && r.hint.includes('half size'))
})

test('spelled-out numbers become digits', () => {
  assert.equal(normalize('Set stop fifty-nine thousand two hundred.'), 'set stop 59200')
  assert.equal(normalize('stop loss fifty nine point two k'), 'stop loss 59.2k')
  assert.equal(normalize('move stop to one thirty four point five'), 'move stop to 134.5')
  assert.equal(normalize('sixty thousand'), '60000')
  assert.deepEqual(cmd('Set stop fifty-nine thousand two hundred', ready), { type: 'set_stop', price: 59200 })
  assert.deepEqual(cmd('stop loss fifty nine thousand five hundred', ready), { type: 'set_stop', price: 59500 })
})

test('countdown is fail-safe: anything but a clear go-ahead cancels', () => {
  assert.deepEqual(cmd('Way', countdown), { type: 'cancel' }) // misheard "wait"
  assert.deepEqual(cmd('I bought', countdown), { type: 'cancel' }) // misheard "abort"
  assert.deepEqual(cmd('hmm', countdown), { type: 'cancel' })
  for (const t of ['yes', 'go ahead', 'okay', 'do it']) assert.equal(cmd(t, countdown), 'x:not_available')
})

test('more place synonyms', () => {
  assert.deepEqual(cmd('Take this', ready), { type: 'place' })
})

test('countdown: negation always cancels, even with "go" / "do it" in the sentence', () => {
  for (const t of ["no don't go", "don't do it", 'not yet go', 'wait go back', 'hold on'])
    assert.deepEqual(cmd(t, countdown), { type: 'cancel' }, t)
})
