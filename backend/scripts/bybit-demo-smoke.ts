// Nov 26 riskiest-part check: Bybit DEMO Trading, USDT perpetual (linear), 1x.
//
// Verifies the two things the Demo docs don't mention:
//   1. orderLinkId is accepted AND a duplicate orderLinkId is rejected (idempotency).
//   2. reduceOnly close works, can't flip a position (oversized close), and can't open one (when flat).
//
// Usage:  npm run bybit:smoke              (default BTCUSDT, ~$100 notional)
//         npm run bybit:smoke -- --fund    (first top up demo USDT via demo-apply-money, 1 req/min)
//         npm run bybit:smoke -- --symbol ETHUSDT --usd 50
import { requireEnv } from '../src/env.js'
import { BybitDemoClient, floorToStep, mainnetPublic, orderLinkIdFor } from '../src/bybit/client.js'

const args = process.argv.slice(2)
const argVal = (flag: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const SYMBOL = (argVal('--symbol') ?? 'BTCUSDT').toUpperCase()
const USD = Number(argVal('--usd') ?? 100)
const FUND = args.includes('--fund')
const CATEGORY = 'linear'

const client = new BybitDemoClient(requireEnv('BYBIT_DEMO_API_KEY'), requireEnv('BYBIT_DEMO_API_SECRET'))

const results: { step: string; ok: boolean; detail: string }[] = []
const record = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function positionSize(): Promise<{ size: number; side: string }> {
  const r = await client.call('GET', '/v5/position/list', { category: CATEGORY, symbol: SYMBOL })
  const p = r.list?.[0]
  return { size: Number(p?.size ?? 0), side: p?.side ?? '' }
}

async function findOrder(orderLinkId: string): Promise<any | undefined> {
  for (let i = 0; i < 10; i++) {
    for (const path of ['/v5/order/realtime', '/v5/order/history']) {
      const r = await client.raw('GET', path, { category: CATEGORY, symbol: SYMBOL, orderLinkId })
      const o = r.result?.list?.[0]
      if (o && ['Filled', 'Cancelled', 'Rejected', 'Deactivated'].includes(o.orderStatus)) return o
    }
    await sleep(500)
  }
  return undefined
}

async function main() {
  console.log(`Callout · Bybit DEMO smoke test · ${SYMBOL} · ~$${USD} · 1x\n`)

  // 0. Mainnet public price (what Callout's checks will use).
  const tick = await mainnetPublic('/v5/market/tickers', { category: CATEGORY, symbol: SYMBOL })
  const mainnetPrice = Number(tick.list[0].lastPrice)
  record('mainnet public ticker', mainnetPrice > 0, `${SYMBOL} last ${mainnetPrice}`)

  // 1. Auth + balance.
  if (FUND) {
    const f = await client.raw('POST', '/v5/account/demo-apply-money', {
      adjustType: 0,
      utaDemoApplyMoney: [{ coin: 'USDT', amountStr: '10000' }],
    })
    record('demo-apply-money', f.retCode === 0, `retCode ${f.retCode} ${f.retMsg}`)
  }
  const wallet = await client.raw('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' })
  if (wallet.retCode !== 0) {
    record('demo auth', false, `retCode ${wallet.retCode} ${wallet.retMsg}`)
    console.error('\nKeys rejected. Make sure they were created INSIDE Demo Trading (avatar → API), not on the live account.')
    return
  }
  const usdt = wallet.result.list?.[0]?.coin?.find((c: any) => c.coin === 'USDT')
  const equity = Number(usdt?.equity ?? 0)
  record('demo auth + wallet', true, `USDT equity ${equity}`)
  if (equity < USD * 1.2) {
    console.error(`\nNot enough demo USDT (${equity}). Re-run with --fund.`)
    return
  }

  // 2. Instrument rules (qty step / min) from the DEMO venue itself.
  const inst = await client.call('GET', '/v5/market/instruments-info', { category: CATEGORY, symbol: SYMBOL })
  const lot = inst.list[0].lotSizeFilter
  const demoTick = await client.call('GET', '/v5/market/tickers', { category: CATEGORY, symbol: SYMBOL })
  const demoPrice = Number(demoTick.list[0].lastPrice)
  const gapPct = ((demoPrice - mainnetPrice) / mainnetPrice) * 100
  console.log(`      demo last ${demoPrice} (gap vs mainnet ${gapPct.toFixed(3)}%) · qtyStep ${lot.qtyStep} · min ${lot.minOrderQty}`)
  let qty = floorToStep(USD / demoPrice, lot.qtyStep)
  if (Number(qty) < Number(lot.minOrderQty)) qty = lot.minOrderQty
  console.log(`      order qty ${qty} (~$${(Number(qty) * demoPrice).toFixed(2)})`)

  // Safety: don't touch a symbol that already has a position.
  const start = await positionSize()
  if (start.size !== 0) {
    console.error(`\nExisting ${start.side} ${start.size} ${SYMBOL} position on demo. Close it or pick another --symbol.`)
    return
  }

  // 3. Leverage 1x (110043 = already 1x).
  const lev = await client.raw('POST', '/v5/position/set-leverage', {
    category: CATEGORY, symbol: SYMBOL, buyLeverage: '1', sellLeverage: '1',
  })
  record('set leverage 1x', lev.retCode === 0 || lev.retCode === 110043, `retCode ${lev.retCode} ${lev.retMsg}`)

  // 4. Open with deterministic orderLinkId.
  const runKey = `smoke:${SYMBOL}:${Date.now()}`
  const openLinkId = orderLinkIdFor('open', runKey)
  const openParams = {
    category: CATEGORY, symbol: SYMBOL, side: 'Buy', orderType: 'Market', qty,
    positionIdx: 0, orderLinkId: openLinkId,
  }
  const open = await client.raw('POST', '/v5/order/create', openParams)
  record('open market Buy with orderLinkId', open.retCode === 0,
    `retCode ${open.retCode} ${open.retMsg} · orderId ${open.result?.orderId} · orderLinkId ${open.result?.orderLinkId}`)
  if (open.retCode !== 0) return
  record('orderLinkId echoed back', open.result.orderLinkId === openLinkId, open.result.orderLinkId)

  // 5. Idempotency: same orderLinkId again must be rejected.
  const dup = await client.raw('POST', '/v5/order/create', openParams)
  record('duplicate orderLinkId rejected', dup.retCode !== 0, `retCode ${dup.retCode} ${dup.retMsg}`)

  // 6. Fill details (the "screenshots don't count" proof).
  const filled = await findOrder(openLinkId)
  record('open order filled', filled?.orderStatus === 'Filled',
    `status ${filled?.orderStatus} · cumExecQty ${filled?.cumExecQty} @ avg ${filled?.avgPrice}`)
  const afterOpen = await positionSize()
  record('position = one order (no double fill)', afterOpen.size === Number(qty) && afterOpen.side === 'Buy',
    `${afterOpen.side} ${afterOpen.size}`)

  // 7. reduceOnly close with qty 2x the position: must flatten, never flip short.
  const closeLinkId = orderLinkIdFor('close', runKey)
  const close = await client.raw('POST', '/v5/order/create', {
    category: CATEGORY, symbol: SYMBOL, side: 'Sell', orderType: 'Market',
    qty: floorToStep(afterOpen.size * 2, lot.qtyStep), reduceOnly: true, positionIdx: 0, orderLinkId: closeLinkId,
  })
  record('reduceOnly close (2x qty) accepted', close.retCode === 0,
    `retCode ${close.retCode} ${close.retMsg} · orderId ${close.result?.orderId}`)
  const closed = await findOrder(closeLinkId)
  console.log(`      close status ${closed?.orderStatus} · cumExecQty ${closed?.cumExecQty} @ avg ${closed?.avgPrice}`)
  await sleep(500)
  const afterClose = await positionSize()
  record('flat after close, not flipped', afterClose.size === 0, `${afterClose.side || 'flat'} ${afterClose.size}`)

  // 8. reduceOnly while flat must not open anything.
  const ghost = await client.raw('POST', '/v5/order/create', {
    category: CATEGORY, symbol: SYMBOL, side: 'Sell', orderType: 'Market', qty, reduceOnly: true,
    positionIdx: 0, orderLinkId: orderLinkIdFor('close', `${runKey}:ghost`),
  })
  const afterGhost = await positionSize()
  record('reduceOnly while flat opens nothing', afterGhost.size === 0,
    `retCode ${ghost.retCode} ${ghost.retMsg} · position ${afterGhost.size}`)
}

main()
  .catch(e => record('unexpected error', false, String(e?.message ?? e)))
  .finally(() => {
    const failed = results.filter(r => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exitCode = failed.length ? 1 : 0
  })
