// tap → live-price re-check → cancel window → Bybit DEMO order (idempotent) → fill → receipt
import { config } from './config.js'
import { requireEnv } from './env.js'
import { runChecks } from './checks.js'
import { BybitDemoClient, floorToStep, orderLinkIdFor } from './bybit/client.js'
import { instrument, livePrice, roundToTick } from './market.js'
import { audit, cards, session, setState } from './store.js'
import type { Card, OrderResult } from './types.js'

const bybit = new BybitDemoClient(requireEnv('BYBIT_DEMO_API_KEY'), requireEnv('BYBIT_DEMO_API_SECRET'))
const timers = new Map<string, NodeJS.Timeout>()
const leverageSet = new Set<string>()

type ReceiptSender = (card: Card) => Promise<boolean>
let sendReceipt: ReceiptSender = async () => false
export function onReceipt(fn: ReceiptSender) {
  sendReceipt = fn
}

export class ActionError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message)
  }
}

function getCard(id: string): Card {
  const c = cards.get(id)
  if (!c) throw new ActionError(404, 'card not found')
  return c
}

/** Re-run every code check against a FRESH mainnet price. Returns false (and blocks the card) on any failure. */
async function recheck(card: Card, stage: string): Promise<boolean> {
  const p = card.parsed!
  const price = await livePrice(p.symbol!, 0)
  const v = runChecks(
    { parsed: p, rawText: card.msg.text, livePrice: price, sentAt: card.msg.sentAt, now: Date.now() },
    { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs },
  )
  if (card.state !== 'countdown') return false // cancelled while we were fetching the price
  card.facts = v.facts
  if (v.state === 'ready') return true
  if (v.state === 'expired') setState(card, 'expired', { flags: v.flags })
  else setState(card, 'blocked', { flags: [...v.flags, `re-check at ${stage}`] })
  return false
}

async function sizeFor(card: Card): Promise<string> {
  const inst = await instrument(card.parsed!.symbol!)
  const price = card.facts.livePrice!
  const usd = Math.min(card.sizeUsd, config.maxSizeUsd) // size from settings, hard-capped; never from the LLM
  const qty = floorToStep(usd / price, inst.qtyStep)
  if (Number(qty) < Number(inst.minOrderQty) || Number(qty) * price < inst.minNotionalValue) {
    throw new ActionError(409, `$${usd} is below ${card.parsed!.symbol} minimum order (${inst.minOrderQty})`)
  }
  return qty
}

/** User tapped "Place". Re-check now, then start the cancel window. */
export async function confirm(id: string): Promise<Card> {
  const card = getCard(id)
  if (card.state !== 'ready') throw new ActionError(409, `card is ${card.state}`)
  if (Date.now() > card.expiresAt) {
    setState(card, 'expired')
    return card
  }
  // Mark synchronously so a double tap can't start two countdowns.
  setState(card, 'countdown', { countdownEndsAt: Date.now() + config.cancelWindowMs })
  if (!(await recheck(card, 'confirm'))) return card
  try {
    await sizeFor(card)
  } catch (e) {
    setState(card, 'blocked', { flags: [(e as Error).message] })
    return card
  }
  if ((card.state as Card['state']) !== 'countdown') return card // cancelled while re-checking
  const remaining = Math.max(0, card.countdownEndsAt! - Date.now())
  timers.set(id, setTimeout(() => void execute(id), remaining))
  return card
}

export function cancel(id: string): Card {
  const card = getCard(id)
  if (card.state !== 'countdown') throw new ActionError(409, `card is ${card.state}`)
  clearTimeout(timers.get(id))
  timers.delete(id)
  setState(card, 'cancelled')
  return card
}

export function skip(id: string): Card {
  const card = getCard(id)
  if (!['ready', 'blocked', 'unsure'].includes(card.state)) throw new ActionError(409, `card is ${card.state}`)
  setState(card, 'skipped')
  return card
}

export function dismiss(id: string): Card {
  const card = getCard(id)
  card.dismissed = true
  return card
}

async function findOrder(symbol: string, orderLinkId: string): Promise<any | undefined> {
  for (let i = 0; i < 12; i++) {
    for (const path of ['/v5/order/realtime', '/v5/order/history']) {
      const r = await bybit.raw('GET', path, { category: 'linear', symbol, orderLinkId })
      const o = r.result?.list?.[0]
      if (o && ['Filled', 'PartiallyFilledCanceled', 'Cancelled', 'Rejected', 'Deactivated'].includes(o.orderStatus)) return o
    }
    await new Promise(r => setTimeout(r, 400))
  }
  return undefined
}

async function execute(id: string): Promise<void> {
  timers.delete(id)
  const card = cards.get(id)
  if (!card || card.state !== 'countdown') return // cancelled
  try {
    // Second re-check: price may have moved during the cancel window.
    if (!(await recheck(card, 'send'))) return
    const p = card.parsed!
    const symbol = p.symbol!
    const qty = await sizeFor(card)
    const inst = await instrument(symbol)
    setState(card, 'placing')

    if (!leverageSet.has(symbol)) {
      const lev = await bybit.raw('POST', '/v5/position/set-leverage', {
        category: 'linear', symbol, buyLeverage: '1', sellLeverage: '1',
      })
      if (lev.retCode !== 0 && lev.retCode !== 110043) throw new Error(`set leverage: ${lev.retCode} ${lev.retMsg}`)
      leverageSet.add(symbol)
    }

    const side = p.side === 'long' ? 'Buy' : 'Sell'
    const orderLinkId = orderLinkIdFor('open', card.id) // deterministic: this card can never be ordered twice
    const params: Record<string, unknown> = {
      category: 'linear', symbol, side, orderType: 'Market', qty, positionIdx: 0, orderLinkId,
      // The caller's own stop/target, attached so the position is never left unprotected.
      stopLoss: roundToTick(p.stop!, inst.tickSize),
      takeProfit: roundToTick(p.targets[0]!, inst.tickSize),
      tpslMode: 'Full',
    }
    const r = await bybit.raw('POST', '/v5/order/create', params)
    // 110072 = duplicate orderLinkId → this exact order already exists; fetch it instead of re-sending.
    if (r.retCode !== 0 && r.retCode !== 110072) throw new Error(`order rejected: ${r.retCode} ${r.retMsg}`)
    audit('order_sent', { id: card.id, orderLinkId, retCode: r.retCode, orderId: r.result?.orderId, params })

    const o = await findOrder(symbol, orderLinkId)
    const order: OrderResult = {
      orderId: o?.orderId ?? r.result?.orderId ?? '',
      orderLinkId,
      side,
      qty: o?.cumExecQty ?? '0',
      avgPrice: o?.avgPrice,
      status: o?.orderStatus ?? 'Unknown',
    }
    if (order.status !== 'Filled') {
      setState(card, 'failed', { order, error: `order status ${order.status}` })
      return
    }
    setState(card, 'filled', { order })
    session.lastResult = `${symbol.replace('USDT', '')} ${p.side} filled ${Number(order.avgPrice).toLocaleString('en-US')}`
    try {
      card.order!.receiptSent = await sendReceipt(card)
      audit(card.order!.receiptSent ? 'receipt_sent' : 'receipt_skipped', { id: card.id, source: card.msg.source })
    } catch (e) {
      audit('receipt_failed', { id: card.id, error: (e as Error).message })
    }
  } catch (e) {
    setState(card, 'failed', { error: (e as Error).message })
  }
}
