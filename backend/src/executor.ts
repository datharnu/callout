// tap → re-check → cancel window → Bybit DEMO order (idempotent) → fill → receipt
//   open  cards: live-price checks + user rules, market order at 1x with the caller's SL/TP attached
//   close cards: position still there → reduceOnly market close (can never open or flip)
import { config } from './config.js'
import { runChecks } from './checks.js'
import { floorToStep, orderLinkIdFor } from './bybit/client.js'
import { bybit } from './bybit/demo.js'
import { insertOrder } from './db.js'
import { instrument, livePrice, roundToTick } from './market.js'
import { positionInfo, userRuleFlags } from './pipeline.js'
import { invalidateStats } from './rules.js'
import { audit, BOOT, cards, session, setState } from './store.js'
import type { Card, OrderResult } from './types.js'

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

/** Still in the cancel window? (A cancel can land while we await I/O.) */
const counting = (card: Card) => (card.state as Card['state']) === 'countdown'

/** Re-run every check against fresh data. Returns false (and blocks the card) on any failure. */
async function recheck(card: Card, stage: string): Promise<boolean> {
  const p = card.parsed!
  if (card.action === 'close') {
    const pos = await positionInfo(p.symbol!).catch(() => undefined)
    if (!counting(card)) return false
    if (!pos) {
      setState(card, 'blocked', { flags: ['position already closed', `re-check at ${stage}`] })
      return false
    }
    card.position = pos
    return true
  }
  const price = await livePrice(p.symbol!, 0)
  const v = runChecks(
    { parsed: p, rawText: card.msg.text, livePrice: price, sentAt: card.msg.sentAt, now: Date.now() },
    { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs },
  )
  const rules = v.state === 'ready' ? await userRuleFlags() : []
  if (!counting(card)) return false
  card.facts = v.facts
  if (v.state === 'expired') {
    setState(card, 'expired', { flags: v.flags })
    return false
  }
  const flags = [...v.flags, ...rules]
  if (flags.length) {
    setState(card, 'blocked', { flags: [...flags, `re-check at ${stage}`] })
    return false
  }
  return true
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

/** User tapped Place (open) or Close (holding). Re-check now, then start the cancel window. */
export async function confirm(id: string): Promise<Card> {
  const card = getCard(id)
  const expected = card.action === 'close' ? 'holding' : 'ready'
  if (card.state !== expected) throw new ActionError(409, `card is ${card.state}`)
  if (Date.now() > card.expiresAt) {
    setState(card, 'expired')
    return card
  }
  // Mark synchronously so a double tap can't start two countdowns.
  setState(card, 'countdown', { countdownEndsAt: Date.now() + config.cancelWindowMs })
  if (!(await recheck(card, 'confirm'))) return card
  if (card.action === 'open') {
    try {
      await sizeFor(card)
    } catch (e) {
      setState(card, 'blocked', { flags: [(e as Error).message] })
      return card
    }
  }
  if (!counting(card)) return card
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

/** Skip a call, or Keep a position (holding card). */
export function skip(id: string): Card {
  const card = getCard(id)
  if (!['ready', 'holding', 'blocked', 'unsure'].includes(card.state)) throw new ActionError(409, `card is ${card.state}`)
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

async function ensureLeverage1x(symbol: string) {
  if (leverageSet.has(symbol)) return
  const lev = await bybit.raw('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: '1', sellLeverage: '1' })
  if (lev.retCode !== 0 && lev.retCode !== 110043) throw new Error(`set leverage: ${lev.retCode} ${lev.retMsg}`)
  leverageSet.add(symbol)
}

/** Build the order. Deterministic orderLinkId per card: the same card can never be ordered twice. */
async function orderParams(card: Card): Promise<{ params: Record<string, unknown>; side: 'Buy' | 'Sell'; orderLinkId: string }> {
  const p = card.parsed!
  const symbol = p.symbol!
  if (card.action === 'close') {
    const pos = card.position!
    const side = pos.side === 'Buy' ? 'Sell' : 'Buy'
    const orderLinkId = orderLinkIdFor('close', `${BOOT}:${card.id}`)
    return {
      side,
      orderLinkId,
      params: { category: 'linear', symbol, side, orderType: 'Market', qty: pos.size, reduceOnly: true, positionIdx: 0, orderLinkId },
    }
  }
  const qty = await sizeFor(card)
  const inst = await instrument(symbol)
  await ensureLeverage1x(symbol)
  const side = p.side === 'long' ? 'Buy' : 'Sell'
  const orderLinkId = orderLinkIdFor('open', `${BOOT}:${card.id}`)
  return {
    side,
    orderLinkId,
    params: {
      category: 'linear', symbol, side, orderType: 'Market', qty, positionIdx: 0, orderLinkId,
      // The caller's own stop/target, attached so the position is never left unprotected.
      stopLoss: roundToTick(p.stop!, inst.tickSize),
      takeProfit: roundToTick(p.targets[0]!, inst.tickSize),
      tpslMode: 'Full',
    },
  }
}

async function execute(id: string): Promise<void> {
  timers.delete(id)
  const card = cards.get(id)
  if (!card || card.state !== 'countdown') return // cancelled
  try {
    // Second re-check: price/position may have changed during the cancel window.
    if (!(await recheck(card, 'send'))) return
    const symbol = card.parsed!.symbol!
    const { params, side, orderLinkId } = await orderParams(card)
    if (!counting(card)) return
    setState(card, 'placing')

    const r = await bybit.raw('POST', '/v5/order/create', params)
    // 110072 = duplicate orderLinkId → this exact order already exists; fetch it instead of re-sending.
    if (r.retCode !== 0 && r.retCode !== 110072) throw new Error(`order rejected: ${r.retCode} ${r.retMsg}`)
    audit('order_sent', { id: card.id, orderLinkId, retCode: r.retCode, orderId: r.result?.orderId, params })

    const o = await findOrder(symbol, orderLinkId)
    // A duplicate is only "ours" if Bybit created it after this card existed. Anything older is a
    // key collision: report it, never show someone else's fill as this card's result.
    if (r.retCode === 110072 && (!o || Number(o.createdTime) < card.createdAt)) {
      throw new Error('order key already used by an earlier order; nothing placed')
    }
    const order: OrderResult = {
      kind: card.action,
      orderId: o?.orderId ?? r.result?.orderId ?? '',
      orderLinkId,
      side,
      qty: o?.cumExecQty ?? '0',
      avgPrice: o?.avgPrice,
      status: o?.orderStatus ?? 'Unknown',
    }
    insertOrder({
      card_id: `${BOOT}:${card.id}`, kind: order.kind, order_id: order.orderId, order_link_id: orderLinkId, symbol,
      side, qty: order.qty, avg_price: order.avgPrice ?? null, status: order.status, created_at: Date.now(),
    })
    invalidateStats()
    if (order.status !== 'Filled') {
      setState(card, 'failed', { order, error: `order status ${order.status}` })
      return
    }
    setState(card, 'filled', { order })
    const coin = symbol.replace('USDT', '')
    const px = Number(order.avgPrice).toLocaleString('en-US')
    session.lastResult = card.action === 'close' ? `${coin} closed ${px}` : `${coin} ${card.parsed!.side} filled ${px}`
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
