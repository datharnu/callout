import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'callout-safety-'))
process.env.CALLOUT_DB = path.join(dir, 'callout.sqlite')
const { staleTap } = await import('../src/store.js')
const { notePairFailure, pairTriesLeft, PAIR_TRIES, PAIR_WINDOW_MS } = await import('../src/pair-guard.js')
const { owner, setOwnerSetting } = await import('../src/sandbox.js')

test('a tap places only what was on screen: a different revision is refused', () => {
  assert.equal(staleTap({}, undefined), false) // callers that send no revision (scripts) are unaffected
  assert.equal(staleTap({}, 0), false)
  assert.equal(staleTap({ rev: 1 }, 0), true) // "half size" landed after the screen was drawn
  assert.equal(staleTap({ rev: 2 }, 2), false)
})

test('/pair: 5 wrong codes per person, then a 10-minute pause', () => {
  const who = 'chat:1:user:9'
  const t0 = 1_000_000
  assert.equal(pairTriesLeft(who, t0), PAIR_TRIES)
  for (let i = 0; i < PAIR_TRIES; i++) notePairFailure(who, t0 + i)
  assert.equal(pairTriesLeft(who, t0 + 10), 0)
  assert.equal(pairTriesLeft('chat:1:user:10', t0 + 10), PAIR_TRIES) // other people are not affected
  assert.equal(pairTriesLeft(who, t0 + PAIR_WINDOW_MS + 10), PAIR_TRIES) // the pause ends
})

test('owner rules from Telegram: validated, applied and saved next to the database', () => {
  assert.match(setOwnerSetting('maxLeverage', 5)!, /Unknown setting/)
  assert.match(setOwnerSetting('maxTradesPerDay', -1)!, /between/)
  assert.match(setOwnerSetting('sizeUsd', 1)!, /between/)
  assert.equal(setOwnerSetting('maxTradesPerDay', 3), null)
  assert.equal(owner.rules.maxTradesPerDay, 3)
  const saved = JSON.parse(readFileSync(path.join(dir, 'owner-settings.json'), 'utf8'))
  assert.equal(saved.maxTradesPerDay, 3)
})
