// Mainnet public market data: what every price check is measured against.
import { mainnetPublic } from './bybit/client.js'

export interface Instrument {
  symbol: string
  qtyStep: string
  minOrderQty: string
  minNotionalValue: number
  tickSize: string
}

const priceCache = new Map<string, { price: number; at: number }>()
const instrumentCache = new Map<string, Instrument>()

/** Last traded price on Bybit mainnet. `maxAgeMs: 0` forces a fresh read (used at confirm time). */
export async function livePrice(symbol: string, maxAgeMs = 2000): Promise<number | undefined> {
  const hit = priceCache.get(symbol)
  if (hit && Date.now() - hit.at <= maxAgeMs) return hit.price
  try {
    const r = await mainnetPublic('/v5/market/tickers', { category: 'linear', symbol })
    const price = Number(r.list?.[0]?.lastPrice)
    if (!(price > 0)) return undefined
    priceCache.set(symbol, { price, at: Date.now() })
    return price
  } catch {
    return undefined // unknown symbol or network issue → the "live price unavailable" check blocks the card
  }
}

export async function instrument(symbol: string): Promise<Instrument> {
  const hit = instrumentCache.get(symbol)
  if (hit) return hit
  const r = await mainnetPublic('/v5/market/instruments-info', { category: 'linear', symbol })
  const i = r.list?.[0]
  if (!i) throw new Error(`No instrument info for ${symbol}`)
  const inst: Instrument = {
    symbol,
    qtyStep: i.lotSizeFilter.qtyStep,
    minOrderQty: i.lotSizeFilter.minOrderQty,
    minNotionalValue: Number(i.lotSizeFilter.minNotionalValue ?? 0),
    tickSize: i.priceFilter.tickSize,
  }
  instrumentCache.set(symbol, inst)
  return inst
}

/** Round a price to the instrument tick (for SL/TP attached to the order). */
export function roundToTick(price: number, tickSize: string): string {
  const decimals = tickSize.includes('.') ? tickSize.split('.')[1]!.replace(/0+$/, '').length : 0
  const t = Number(tickSize)
  return (Math.round(price / t) * t).toFixed(decimals)
}
