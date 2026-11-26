import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byTokenOrNull, createJudge, JUDGE, linkedTo, newPairCode, owner, redeemPairCode, takeQuota } from '../src/sandbox.js'

test('judge sandboxes are isolated from each other and from the owner', () => {
  const a = createJudge(), b = createJudge()
  assert.notEqual(a.token, b.token)
  assert.notEqual(a.cards, b.cards)
  assert.notEqual(a.cards, owner.cards)
  assert.equal(byTokenOrNull(a.token), a)
  assert.equal(byTokenOrNull('not-a-token'), null)
  assert.equal(byTokenOrNull(undefined), null)
  assert.equal(a.sizeUsd, JUDGE.sizeUsd)
  assert.equal(a.rules.maxTradesPerDay, 3)
})

test('pairing: a code links exactly one Telegram user to the sandbox that issued it, once', () => {
  const a = createJudge()
  const { code } = newPairCode(a)
  assert.match(code, /^\d{6}$/)
  assert.equal(redeemPairCode('000000', 't-1', '@x'), null) // wrong code
  const sb = redeemPairCode(code, 't-1', '@judge')
  assert.equal(sb, a)
  assert.equal(a.telegram?.id, 't-1')
  assert.ok(a.allow.senders.has('t-1'))
  assert.deepEqual(linkedTo('t-1'), [a])
  assert.equal(redeemPairCode(code, 't-2', '@other'), null) // single use
})

test('pairing codes expire', () => {
  const a = createJudge()
  const { code } = newPairCode(a)
  a.pair!.expiresAt = Date.now() - 1
  assert.equal(redeemPairCode(code, 't-3', '@late'), null)
})

test('quotas: judges are limited per hour, the owner never', () => {
  const a = createJudge()
  for (let i = 0; i < JUDGE.samplesPerHour; i++) assert.equal(takeQuota(a, 'samples'), true)
  assert.equal(takeQuota(a, 'samples'), false)
  assert.equal(takeQuota(a, 'voice'), true) // separate quota
  for (let i = 0; i < 100; i++) assert.equal(takeQuota(owner, 'samples'), true)
})
