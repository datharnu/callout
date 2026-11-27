import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PreviewBridge, type PreviewMessage } from '../src/preview-bridge'
import type { GlassesEvent } from '../src/bridge'
import { isPreview } from '../src/bridge'
import { apiBase, readToken } from '../src/auth'

const ORIGIN = 'https://callout.example'
const PARENT = { name: 'parent-window' }

function setup() {
  const sent: PreviewMessage[] = []
  let handler: ((ev: { origin: string; source: unknown; data: unknown }) => void) | null = null
  let unsubscribed = false
  const b = new PreviewBridge({
    origin: ORIGIN,
    parent: PARENT,
    post: m => sent.push(m),
    subscribe: h => {
      handler = h
      return () => { unsubscribed = true }
    },
  })
  const got: GlassesEvent[] = []
  b.onEvent(e => got.push(e))
  const send = (data: unknown, origin = ORIGIN, source: unknown = PARENT) => handler!({ origin, source, data })
  return { b, sent, got, send, isUnsubscribed: () => unsubscribed }
}

test('display text and mic state go to the parent', async () => {
  const { b, sent } = setup()
  await b.createPage('CALLOUT · connecting...')
  await b.update('card')
  assert.equal(await b.audioControl(true), true)
  await b.audioControl(false)
  assert.deepEqual(sent, [
    { type: 'callout:display', content: 'CALLOUT · connecting...' },
    { type: 'callout:display', content: 'card' },
    { type: 'callout:mic', on: true },
    { type: 'callout:mic', on: false },
  ])
})

test('the card on screen is reported to the parent (so its buttons match the glasses)', () => {
  const { b, sent } = setup()
  b.focus({ id: 'c1', state: 'ready' })
  b.focus(null)
  assert.deepEqual(sent, [
    { type: 'callout:focus', id: 'c1', state: 'ready' },
    { type: 'callout:focus', id: null, state: null },
  ])
})

test('input actions map to the same events the SDK produces', () => {
  const { got, send } = setup()
  for (const action of ['click', 'double_click', 'up', 'down']) send({ type: 'callout:input', action })
  assert.deepEqual(got.map(e => e.kind), ['click', 'double_click', 'up', 'down'])
})

test('audio frames arrive as bytes with an unknown speaker', () => {
  const { got, send } = setup()
  const pcm = new Int16Array([1, -1, 300, -300])
  send({ type: 'callout:audio', pcm: pcm.buffer })
  send({ type: 'callout:audio', pcm: new Uint8Array(pcm.buffer) })
  assert.equal(got.length, 2)
  for (const e of got) {
    assert.equal(e.kind, 'audio')
    if (e.kind === 'audio') {
      assert.equal(e.pcm.byteLength, 8)
      assert.equal(e.role, 'unknown')
    }
  }
})

test('other origins, other windows and malformed messages are ignored', () => {
  const { got, send } = setup()
  send({ type: 'callout:input', action: 'click' }, 'https://evil.example')
  send({ type: 'callout:input', action: 'click' }, ORIGIN, { name: 'someone-else' })
  send({ type: 'callout:input', action: 'rm -rf' })
  send({ type: 'callout:audio', pcm: 'not bytes' })
  send({ type: 'callout:audio', pcm: new ArrayBuffer(1) })
  send(null)
  send('click')
  assert.equal(got.length, 0)
})

test('shutdown shows a closing screen and stops listening', async () => {
  const { b, sent, isUnsubscribed } = setup()
  await b.shutdown()
  assert.match(sent.at(-1)!.type === 'callout:display' ? (sent.at(-1) as { content: string }).content : '', /closed/)
  assert.equal(isUnsubscribed(), true)
})

test('preview only without an Even app host and with ?preview=1', () => {
  assert.equal(isPreview({ search: '?preview=1&s=abc' }, {}), true)
  assert.equal(isPreview({ search: '?s=abc' }, {}), false)
  assert.equal(isPreview({ search: '?preview=1' }, { flutter_inappwebview: {} }), false)
})

test('token: from ?s= (remembered), else from storage', () => {
  const mem = new Map<string, string>()
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  assert.equal(readToken('?s=tok123&preview=1', store), 'tok123')
  assert.equal(readToken('', store), 'tok123')
  assert.equal(readToken('', { getItem: () => null, setItem: () => {} }), null)
})

test('API base: override, same origin under /glasses, else local dev', () => {
  const hosted = { protocol: 'https:', origin: 'https://callout.example', pathname: '/glasses/' }
  assert.equal(apiBase('https://api.example/', hosted), 'https://api.example')
  assert.equal(apiBase('', hosted), 'https://callout.example')
  assert.equal(apiBase('', { protocol: 'http:', origin: 'http://localhost:5173', pathname: '/' }), 'http://127.0.0.1:8787')
})
