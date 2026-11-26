import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpret, interpretAll, normalize, resolvePrice, type VoiceContext } from '../src/voice/commands.js'

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
  assert.equal(cmd('stop', ready), 'x:no_price') // unfinished "set stop": waits for the price
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

const all = (t: string, ctx: VoiceContext) => interpretAll(t, ctx)

test('compound: "half size set stop 59k" applies both, in order', () => {
  const p = all('Half size set stop 59K', ready)
  assert.deepEqual(p.commands, [{ type: 'size', factor: 0.5 }, { type: 'set_stop', price: 59000 }])
  assert.deepEqual(all('set stop 59.5k and half size', ready).commands, [{ type: 'set_stop', price: 59500 }, { type: 'size', factor: 0.5 }])
})

test('compound: modifiers then one final action', () => {
  assert.deepEqual(all('half size, stop at 59k, place it', ready).commands, [
    { type: 'size', factor: 0.5 }, { type: 'set_stop', price: 59000 }, { type: 'place' },
  ])
  assert.deepEqual(all('half size then skip', ready).commands, [{ type: 'size', factor: 0.5 }, { type: 'skip' }])
})

test('compound: last value wins ("half size... actually full size")', () => {
  assert.deepEqual(all('half size actually full size', ready).commands, [{ type: 'size', factor: 1 }])
})

test('filler words only count alone', () => {
  assert.deepEqual(all('ok half size', ready).commands, [{ type: 'size', factor: 0.5 }]) // not dismiss
  assert.deepEqual(all('yes set stop 59k', ready).commands, [{ type: 'set_stop', price: 59000 }]) // not place
  assert.deepEqual(all('no', ready).commands, [{ type: 'skip' }])
})

test('negation drops the command', () => {
  assert.deepEqual(all("don't place it", ready).commands, [])
  assert.deepEqual(all('not half size, set stop 59k', ready).commands, [{ type: 'set_stop', price: 59000 }])
})

test('partial: "set stop" with no price waits for the rest', () => {
  const p = all('Set stop', ready)
  assert.equal(p.partial, 'stop')
  assert.deepEqual(p.commands, [])
  const q = all('half size set stop', ready) // the size applies now, the stop waits
  assert.deepEqual(q.commands, [{ type: 'size', factor: 0.5 }])
  assert.equal(q.partial, 'stop')
  // The continuation is the pending prefix + the next utterance:
  assert.deepEqual(all('set stop 59K', ready).commands, [{ type: 'set_stop', price: 59000 }])
})

test('unusable parts are reported, usable parts still apply', () => {
  const p = all('half size close it', ready)
  assert.deepEqual(p.commands, [{ type: 'size', factor: 0.5 }])
  assert.deepEqual(p.issues, [{ kind: 'not_available', text: 'close it' }])
  const q = all('set stop 5 and skip', ready)
  assert.deepEqual(q.commands, [{ type: 'skip' }])
  assert.equal(q.issues[0]!.kind, 'no_price')
})

test('navigation only when said alone', () => {
  assert.deepEqual(all('next', ready).commands, [{ type: 'next' }])
  assert.deepEqual(all('half size next', ready).commands, [{ type: 'size', factor: 0.5 }])
})

test('conversation is ignored (live test: a TV in the background)', () => {
  const tv1 = "Welcome back. The fit's fine. Perfect. We in the market for them. I feel like the light-skinned guys"
  const tv2 = "I have something to say about that given the fact that she said she wasn't into light-skinned guys No, I don't. Me, we are fine What's your preference on-"
  for (const t of [tv1, tv2]) {
    const p = all(t, ready)
    assert.equal(p.ignored, true, t)
    assert.deepEqual(p.commands, [])
  }
})

test('real commands are not mistaken for conversation', () => {
  assert.deepEqual(all('half size, set stop fifty nine point five k and then place it please', ready).commands, [
    { type: 'size', factor: 0.5 }, { type: 'set_stop', price: 59500 }, { type: 'place' },
  ])
  assert.deepEqual(all('okay so move my stop to fifty nine thousand', ready).commands, [{ type: 'set_stop', price: 59000 }])
})

test('filler commands need a very short utterance', () => {
  assert.deepEqual(all('no', ready).commands, [{ type: 'skip' }])
  assert.deepEqual(all('no thanks', ready).commands, [{ type: 'skip' }])
  assert.deepEqual(all('no I really do not know', ready).commands, []) // 6 words: "no" alone doesn't count
})

test('live transcript: "set stops …" (plural) still sets the stop', () => {
  // Heard in a live test: "half" misheard as "Outsize" (correctly ignored), "stop" as "stops".
  assert.deepEqual(all('Outsize set stops fifty-nine point five K', ready).commands, [{ type: 'set_stop', price: 59500 }])
})
