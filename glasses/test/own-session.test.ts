import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutoSession, isLocalApi, readToken, saveAutoToken } from '../src/auth'
import { ownHomeScreen } from '../src/screens'
import type { StateView } from '../src/api'

function memStore() {
  const mem = new Map<string, string>()
  return { mem, getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
}

test('own session: a session this app created is remembered as its own; a /try link never is', () => {
  const store = memStore()
  assert.equal(isAutoSession('', store), false)
  saveAutoToken('auto-1', store)
  assert.equal(readToken('', store), 'auto-1')
  assert.equal(isAutoSession('', store), true)
  // Opening a /try link hands over that session and clears the "own" flag.
  assert.equal(readToken('?s=from-try', store), 'from-try')
  assert.equal(isAutoSession('', store), false)
  assert.equal(isAutoSession('?s=from-try', store), false)
})

test('only a hosted backend needs a session; a local one treats the app as the owner', () => {
  assert.equal(isLocalApi('http://127.0.0.1:8787'), true)
  assert.equal(isLocalApi('http://localhost:8787'), true)
  assert.equal(isLocalApi('https://callout-production-049324a2.up.railway.app'), false)
})

const state: StateView = { now: 0, session: { groups: 1, muted: 2, forYou: 0, expired: 0, last: '' }, cards: [] }

test('own home screen: tap for a sample, the /pair code, then the linked state; fits the 576px display', () => {
  const pairing = ownHomeScreen(state, { pair: { code: '482913', group: { title: "A'ska & Callout", inviteUrl: 'https://t.me/+abc' } }, linkedAs: null, note: null }, false)
  assert.match(pairing, /Tap: send a sample call/)
  assert.match(pairing, /\/pair 482913/)
  assert.match(pairing, /t\.me\/\+abc/)
  const linked = ownHomeScreen(state, { pair: null, linkedAs: '@judge', note: null }, false)
  assert.match(linked, /Telegram linked: @judge/)
  assert.doesNotMatch(linked, /\/pair/)
  for (const screen of [pairing, linked]) {
    const lines = screen.split('\n')
    assert.ok(lines.length <= 10, `${lines.length} lines`)
    for (const l of lines) assert.ok(l.length <= 48, `too long: ${l}`)
  }
})
