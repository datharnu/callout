// Read Bybit DEMO positions and close them with reduceOnly market orders.
// reduceOnly guarantees a close can never open or flip a position (verified Nov 26: 110017 when flat).
import { BybitDemoClient, orderLinkIdFor } from './bybit/client.js'

export interface Position {
  symbol: string
  side: 'Buy' | 'Sell'
  size: string
  avgPrice: string
  markPrice: string
  unrealisedPnl: string
  stopLoss: string
  takeProfit: string
}

export async function listPositions(bybit: BybitDemoClient, symbol?: string): Promise<Position[]> {
  const r = await bybit.call('GET', '/v5/position/list', {
    category: 'linear',
    ...(symbol ? { symbol } : { settleCoin: 'USDT' }),
  })
  return (r.list as any[])
    .filter(p => Number(p.size) > 0)
    .map(p => ({
      symbol: p.symbol, side: p.side, size: p.size, avgPrice: p.avgPrice, markPrice: p.markPrice,
      unrealisedPnl: p.unrealisedPnl, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
    }))
}

export interface CloseResult {
  symbol: string
  orderId: string
  orderLinkId: string
  qty: string
  retCode: number
  retMsg: string
}

/**
 * Close the whole position on `symbol` with a reduceOnly market order.
 * `key` makes the orderLinkId deterministic, so retrying the same close can't send it twice.
 */
export async function closePosition(bybit: BybitDemoClient, symbol: string, key: string): Promise<CloseResult> {
  const [pos] = await listPositions(bybit, symbol)
  if (!pos) throw new Error(`no open ${symbol} position`)
  const orderLinkId = orderLinkIdFor('close', key)
  const r = await bybit.raw('POST', '/v5/order/create', {
    category: 'linear', symbol, side: pos.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market',
    qty: pos.size, reduceOnly: true, positionIdx: 0, orderLinkId,
  })
  return { symbol, orderId: r.result?.orderId ?? '', orderLinkId, qty: pos.size, retCode: r.retCode, retMsg: r.retMsg }
}
