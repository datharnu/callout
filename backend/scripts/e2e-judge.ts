// End-to-end test of the hosted judge mode against a running backend.
// Start the backend with CALLOUT_JUDGE_AUTOCLOSE_SEC=20 to test the auto-close quickly.
// Places real Bybit DEMO orders (one open + close, one open + auto-close). Demo money only.
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
const sample = (t: string, kind: string) => call(t, 'POST', '/api/judge/sample', { kind }).then(r => r.body)
const state = (t: string) => call(t, 'GET', '/api/state').then(r => r.body)
const act = (t: string, id: string, a: string) => call(t, 'POST', `/api/cards/${encodeURIComponent(id)}/${a}`)
async function waitCard(t: string, id: string, states: string[], ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const c = (await state(t)).cards.find((x: any) => x.id === id)
    if (c && states.includes(c.state)) return c
    await sleep(400)
  }
  return null
}
const settings = (t: string) => call(t, 'GET', '/api/settings').then(r => r.body)

const ownerBefore = await settings('') // no token, direct local call = owner
const A = (await call(null, 'POST', '/api/sandbox')).body
const B = (await call(null, 'POST', '/api/sandbox')).body
expect('two judge sessions with different tokens', !!A.token && !!B.token && A.token !== B.token, { A: A.sandboxId, B: B.sandboxId })

const bad = await call('definitely-not-a-token', 'GET', '/api/state')
expect('a wrong token is refused (401), never treated as the owner', bad.status === 401, bad.status)

const a1 = await sample(A.token, 'clean')
expect('judge A: clean sample call → ready, sized for judges ($100)', a1.card?.state === 'ready' && a1.card?.sizeUsd === 100, `${a1.text} → ${a1.card?.state} $${a1.card?.sizeUsd}`)
expect("judge B can't see judge A's card", !(await state(B.token)).cards.some((c: any) => c.id === a1.card?.id), 'isolated')

const imp = await sample(A.token, 'impostor')
expect('impostor (look-alike name, not allowlisted) → muted', imp.outcome === 'muted', `${imp.sender}: ${imp.outcome} (${imp.reason})`)
const scam = await sample(A.token, 'scam')
expect('scam sample → blocked with factual flags', scam.card?.state === 'blocked', scam.card?.flags)

const c = await act(A.token, a1.card.id, 'confirm')
expect('judge A taps → countdown', c.body.state === 'countdown', c.body.state ?? c.body.error)
const filled = await waitCard(A.token, a1.card.id, ['filled', 'failed', 'blocked'])
expect('judge A: real Bybit Demo fill', filled?.state === 'filled', `${filled?.state} order …${filled?.order?.orderId?.slice(-8)} ${filled?.error ?? ''}`)
await act(A.token, a1.card.id, 'dismiss')

const b1 = await sample(B.token, 'clean')
const bTap = await act(B.token, b1.card.id, 'confirm')
expect("judge B's tap is refused while A's demo position is open", bTap.status === 409 && /Another judge/.test(bTap.body.error), `${bTap.status} ${bTap.body.error}`)
const bView = (await state(B.token)).cards.find((x: any) => x.id === b1.card.id)
expect('…and the reason is on B\'s card for the glasses', /Another judge/.test(bView?.notice ?? ''), bView?.notice)

const bHold = await sample(B.token, 'holding')
expect("judge B's 'taking profit' is muted: B holds nothing", bHold.outcome === 'muted', `${bHold.outcome} (${bHold.reason})`)
const aHold = await sample(A.token, 'holding')
expect("judge A gets a holding card for A's own position", aHold.card?.state === 'holding', `${aHold.card?.state} ${aHold.card?.position?.side} ${aHold.card?.position?.size}`)

const close = await act(A.token, aHold.card.id, 'confirm')
const closed = await waitCard(A.token, aHold.card.id, ['filled', 'failed', 'blocked'])
expect('judge A closes reduce-only', close.body.state === 'countdown' && closed?.state === 'filled' && closed?.order?.kind === 'close', `${closed?.state} ${closed?.order?.kind}`)
await act(A.token, aHold.card.id, 'dismiss')
expect('the lock is released after the close', (await settings(B.token)).judgePosition === null, (await settings(B.token)).judgePosition)

// Auto-close: B opens and walks away.
const bTap2 = await act(B.token, b1.card.id, 'confirm')
const bFilled = await waitCard(B.token, b1.card.id, ['filled', 'failed', 'blocked'])
expect('judge B can now place', bTap2.body.state === 'countdown' && bFilled?.state === 'filled', `${bFilled?.state} ${bFilled?.error ?? ''}`)
const closesIn = (await settings(B.token)).judgePosition?.closesInSec
console.log(`      waiting for auto-close (${closesIn}s)…`)
await sleep(((closesIn ?? 20) + 6) * 1000)
const after = await settings(B.token)
expect('judge position is auto-closed and the lock released', after.judgePosition === null && /auto-closed after/.test((await state(B.token)).session.last), (await state(B.token)).session.last)

const ownerAfter = await settings('')
expect("judges' trades don't count toward the owner's daily rule", ownerAfter.tradesToday === ownerBefore.tradesToday, `${ownerBefore.tradesToday} → ${ownerAfter.tradesToday}`)
const aSet = await settings(A.token)
expect("judge A's own count: 1 trade today, of 3", aSet.tradesToday === 1 && aSet.rules.maxTradesPerDay === 3, `${aSet.tradesToday}/${aSet.rules.maxTradesPerDay}`)

const failed = results.filter(x => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed ? 1 : 0
