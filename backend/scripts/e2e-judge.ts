// End-to-end test of the hosted judge mode against a running backend.
// Start the backend with CALLOUT_JUDGE_AUTOCLOSE_SEC=20 to test the auto-close quickly.
// Places real Bybit DEMO orders on two coins in parallel. Demo money only.
//
// Usage: npm run e2e:judge
const API = process.env.CALLOUT_API ?? 'http://127.0.0.1:8787'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const results: boolean[] = []
function expect(name: string, ok: boolean, got: unknown) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${typeof got === 'string' ? got : JSON.stringify(got)}`)
}
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body) headers['content-type'] = 'application/json'
  const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any }
}
const sample = (t: string, kind: string, coin?: string) => call(t, 'POST', '/api/judge/sample', { kind, ...(coin ? { coin } : {}) }).then(r => r.body)
const state = (t: string) => call(t, 'GET', '/api/state').then(r => r.body)
const act = (t: string, id: string, a: string) => call(t, 'POST', `/api/cards/${encodeURIComponent(id)}/${a}`)
const settings = (t: string) => call(t, 'GET', '/api/settings').then(r => r.body)
async function waitCard(t: string, id: string, states: string[], ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const c = (await state(t)).cards.find((x: any) => x.id === id)
    if (c && states.includes(c.state)) return c
    await sleep(400)
  }
  return null
}
async function place(t: string, id: string) {
  const c = await act(t, id, 'confirm')
  const done = c.status === 200 ? await waitCard(t, id, ['filled', 'failed', 'blocked']) : null
  return { tap: c, done }
}

const ownerBefore = await settings('') // no token, direct local call = owner
const A = (await call(null, 'POST', '/api/sandbox')).body
const B = (await call(null, 'POST', '/api/sandbox')).body
const C = (await call(null, 'POST', '/api/sandbox')).body
expect('three judge sessions with different tokens', new Set([A.token, B.token, C.token]).size === 3, [A.sandboxId, B.sandboxId, C.sandboxId])
expect('a wrong token is refused (401), never treated as the owner', (await call('nope', 'GET', '/api/state')).status === 401, 401)

// Each judge gets their own coin.
const a1 = await sample(A.token, 'clean')
const b1 = await sample(B.token, 'clean')
const coinA = a1.card?.symbol, coinB = b1.card?.symbol
expect('judges get different coins', !!coinA && !!coinB && coinA !== coinB, `A ${a1.text} · B ${b1.text}`)
expect('both cards ready, sized for judges ($100)', a1.card?.state === 'ready' && b1.card?.state === 'ready' && a1.card?.sizeUsd === 100, `${a1.card?.state}/${b1.card?.state}`)
expect("B can't see A's card", !(await state(B.token)).cards.some((c: any) => c.id === a1.card?.id), 'isolated')
expect('the voice hint uses the card\'s own coin price', !/59k/.test((await state(A.token)).cards[0]?.voiceHint ?? '') || coinA === 'BTCUSDT', (await state(A.token)).cards[0]?.voiceHint)

// They trade AT THE SAME TIME.
const [pa, pb] = await Promise.all([place(A.token, a1.card.id), place(B.token, b1.card.id)])
expect('A and B both fill in parallel (different coins)', pa.done?.state === 'filled' && pb.done?.state === 'filled',
  `A ${coinA} ${pa.done?.state} …${pa.done?.order?.orderId?.slice(-8)} · B ${coinB} ${pb.done?.state} …${pb.done?.order?.orderId?.slice(-8)} ${pa.done?.error ?? ''}${pb.done?.error ?? ''}`)

// Same coin as A → refused with a clear reason; a judge holds one position at a time.
const c1 = await sample(C.token, 'clean', coinA.replace('USDT', ''))
const cTap = await act(C.token, c1.card.id, 'confirm')
expect(`C on A's coin (${coinA}) is refused while A trades it`, cTap.status === 409 && /Another judge is trading/.test(cTap.body.error), `${cTap.status} ${cTap.body.error}`)
const a2 = await sample(A.token, 'clean')
const a2Tap = await act(A.token, a2.card.id, 'confirm')
expect('A can hold one position at a time', a2Tap.status === 409 && /still open/.test(a2Tap.body.error), `${a2Tap.status} ${a2Tap.body.error}`)

// Holding cards are per judge and per coin.
const cHold = await sample(C.token, 'holding')
expect("C's 'taking profit' is muted: C holds nothing", cHold.outcome === 'muted', `${cHold.outcome} (${cHold.reason})`)
const aHold = await sample(A.token, 'holding')
expect("A gets a holding card for A's own coin", aHold.card?.state === 'holding' && aHold.card?.symbol === coinA, `${aHold.text} → ${aHold.card?.state}`)
const ca = await place(A.token, aHold.card.id)
expect('A closes reduce-only', ca.done?.state === 'filled' && ca.done?.order?.kind === 'close', `${ca.done?.state} ${ca.done?.order?.kind}`)
const cRetry = await act(C.token, c1.card.id, 'confirm')
const cDone = cRetry.status === 200 ? await waitCard(C.token, c1.card.id, ['filled', 'failed', 'blocked']) : null
expect(`C can trade ${coinA} once A has closed`, cDone?.state === 'filled', `${cRetry.status} ${cDone?.state ?? cRetry.body.error}`)

// Auto-close: B and C walk away.
const waitSec = Math.max((await settings(B.token)).judgePosition?.closesInSec ?? 0, (await settings(C.token)).judgePosition?.closesInSec ?? 0)
console.log(`      waiting for auto-close (${waitSec}s)…`)
await sleep((waitSec + 6) * 1000)
const [sB, sC] = [await settings(B.token), await settings(C.token)]
expect('open judge positions are auto-closed', sB.judgePosition === null && sC.judgePosition === null && sB.judgesTradingNow === 0, { B: sB.judgePosition, C: sC.judgePosition, trading: sB.judgesTradingNow })

const ownerAfter = await settings('')
expect("judges' trades don't count toward the owner's daily rule", ownerAfter.tradesToday === ownerBefore.tradesToday, `${ownerBefore.tradesToday} → ${ownerAfter.tradesToday}`)
expect('each judge counts only their own trades', (await settings(A.token)).tradesToday === 1 && (await settings(C.token)).tradesToday === 1, 'A 1, C 1')

const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed ? 1 : 0
