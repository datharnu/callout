// List Bybit DEMO positions, or close them with reduceOnly market orders.
// Usage: npm run positions            (list)
//        npm run positions -- --close (close every open demo position)
import { requireEnv } from '../src/env.js'
import { BybitDemoClient } from '../src/bybit/client.js'
import { closePosition, listPositions } from '../src/positions.js'

const bybit = new BybitDemoClient(requireEnv('BYBIT_DEMO_API_KEY'), requireEnv('BYBIT_DEMO_API_SECRET'))
const show = async (label: string) => {
  const ps = await listPositions(bybit)
  console.log(`${label}: ${ps.length ? '' : 'flat'}`)
  for (const p of ps) console.log(`  ${p.symbol} ${p.side} ${p.size} @ ${p.avgPrice} · mark ${p.markPrice} · uPnL ${p.unrealisedPnl} · SL ${p.stopLoss} TP ${p.takeProfit}`)
  return ps
}

const open = await show('Demo positions')
if (process.argv.includes('--close')) {
  for (const p of open) {
    const r = await closePosition(bybit, p.symbol, `manual:${p.symbol}:${Date.now()}`)
    console.log(`close ${r.symbol} ${r.qty} reduceOnly → retCode ${r.retCode} ${r.retMsg} · orderId ${r.orderId}`)
  }
  await new Promise(r => setTimeout(r, 1500))
  await show('After close')
}
