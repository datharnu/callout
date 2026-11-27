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
import { audit, BOOT, setState } from './store.js'
import { JUDGE_AUTO_CLOSE_MS, judgePositionOf, judgePositions, sandboxById, type Sandbox } from './sandbox.js'
import { closePosition, listPositions } from './positions.js'
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

function getCard(sb: Sandbox, id: string): Card {
  const c = sb.cards.get(id)
  if (!c) throw new ActionError(404, 'card not found')
  return c
}
const sbOf = (card: Card) => sandboxById(card.sandboxId)!
/** Order keys are unique per process start, sandbox and card. */
const orderKey = (card: Card) => `${BOOT}:${card.sandboxId}:${card.id}`

/** Still in the cancel window? (A cancel can land while we await I/O.) */
const counting = (card: Card) => (card.state as Card['state']) === 'countdown'

/** Re-run every check against fresh data. Returns false (and blocks the card) on any failure. */
async function recheck(card: Card, stage: string): Promise<boolean> {
  const p = card.parsed!
  if (card.action === 'close') {
    const pos = await positionInfo(sbOf(card), p.symbol!).catch(() => undefined)
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
    { parsed: p, rawText: card.msg.text, livePrice: price, sentAt: card.msg.sentAt, now: Date.now(), stopOverride: card.userStop },
    { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs },
  )
  const rules = v.state === 'ready' ? await userRuleFlags(sbOf(card)) : []
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
export async function confirm(sb: Sandbox, id: string): Promise<Card> {
  const card = getCard(sb, id)
  const expected = card.action === 'close' ? 'holding' : 'ready'
  if (card.state !== expected) throw new ActionError(409, `card is ${card.state}`)
  if (Date.now() > card.expiresAt) {
    setState(card, 'expired')
    return card
  }
  // Judges share one Bybit Demo account: one judge position at a time, never on top of another position.
  if (sb.kind === 'judge' && card.action === 'open') {
    const busy = await judgeBusyReason(card)
    if (busy) {
      card.notice = busy
      card.noticeAt = Date.now()
      throw new ActionError(409, busy)
    }
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
  timers.set(id, setTimeout(() => void execute(sb, id), remaining))
  return card
}

export function cancel(sb: Sandbox, id: string): Card {
  const card = getCard(sb, id)
  if (card.state !== 'countdown') throw new ActionError(409, `card is ${card.state}`)
  clearTimeout(timers.get(id))
  timers.delete(id)
  setState(card, 'cancelled')
  return card
}

/** Skip a call, or Keep a position (holding card). */
export function skip(sb: Sandbox, id: string): Card {
  const card = getCard(sb, id)
  if (!['ready', 'holding', 'blocked', 'unsure'].includes(card.state)) throw new ActionError(409, `card is ${card.state}`)
  setState(card, 'skipped')
  return card
}

/** Is the card's current size placeable on this symbol? Returns a neutral reason if not. */
export async function sizeProblem(card: Card): Promise<string | null> {
  try {
    await sizeFor(card)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/**
 * Re-run all checks + rules on a card that is NOT in countdown (used after a voice "set stop").
 * Moves it between ready / blocked / expired; never places anything.
 */
export async function reevaluate(card: Card): Promise<void> {
  if (card.state !== 'ready' && card.state !== 'blocked') return
  const p = card.parsed!
  const price = p.symbol ? await livePrice(p.symbol, 0) : undefined
  const v = runChecks(
    { parsed: p, rawText: card.msg.text, livePrice: price, sentAt: card.msg.sentAt, now: Date.now(), stopOverride: card.userStop },
    { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs },
  )
  card.facts = v.facts
  if (v.state === 'expired') return setState(card, 'expired', { flags: v.flags })
  const flags = v.state === 'ready' ? await userRuleFlags(sbOf(card)) : v.flags
  if (card.state !== 'ready' && card.state !== 'blocked') return // changed while we awaited
  setState(card, flags.length ? 'blocked' : 'ready', { flags })
}

export function dismiss(sb: Sandbox, id: string): Card {
  const card = getCard(sb, id)
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
    const orderLinkId = orderLinkIdFor('close', orderKey(card))
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
  const orderLinkId = orderLinkIdFor('open', orderKey(card))
  return {
    side,
    orderLinkId,
    params: {
      category: 'linear', symbol, side, orderType: 'Market', qty, positionIdx: 0, orderLinkId,
      // The caller's own stop/target, attached so the position is never left unprotected.
      stopLoss: roundToTick(card.userStop ?? p.stop!, inst.tickSize),
      takeProfit: roundToTick(p.targets[0]!, inst.tickSize),
      tpslMode: 'Full',
    },
  }
}

async function execute(sb: Sandbox, id: string): Promise<void> {
  timers.delete(id)
  const card = sb.cards.get(id)
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
      card_id: orderKey(card), sandbox_id: sb.id, kind: order.kind, order_id: order.orderId, order_link_id: orderLinkId, symbol,
      side, qty: order.qty, avg_price: order.avgPrice ?? null, status: order.status, created_at: Date.now(),
    })
    invalidateStats()
    if (order.status !== 'Filled') {
      setState(card, 'failed', { order, error: `order status ${order.status}` })
      return
    }
    setState(card, 'filled', { order })
    if (sb.kind === 'judge') trackJudgePosition(sb, card, order)
    const coin = symbol.replace('USDT', '')
    const px = Number(order.avgPrice).toLocaleString('en-US')
    sb.session.lastResult = card.action === 'close' ? `${coin} closed ${px}` : `${coin} ${card.parsed!.side} filled ${px}`
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

// ── Judge positions: one per coin, one per judge, closed automatically ─────────────────────────
const autoClose = new Map<string, NodeJS.Timeout>() // symbol → timer
const coinName = (symbol: string) => symbol.replace(/USDT$/, '')

/** Why a judge can't open this demo position right now (or null). */
async function judgeBusyReason(card: Card): Promise<string | null> {
  const symbol = card.parsed!.symbol!
  const left = (openedAt: number) => Math.max(5, Math.ceil((openedAt + JUDGE_AUTO_CLOSE_MS - Date.now()) / 1000))
  const mine = judgePositionOf(sandboxById(card.sandboxId)!)
  if (mine) return `Your ${coinName(mine.symbol)} demo position is still open · close it or wait ~${left(mine.openedAt)} s`
  const j = judgePositions.get(symbol)
  if (j) return `Another judge is trading ${coinName(symbol)} right now · try again in ~${left(j.openedAt)} s, or use another coin`
  const open = await listPositions(bybit, symbol).catch(() => null)
  if (open === null) return "Couldn't read the demo account · try again"
  if (open.length) return `A ${coinName(symbol)} demo position is already open · try again in a minute`
  return null
}

function trackJudgePosition(sb: Sandbox, card: Card, order: OrderResult) {
  const symbol = card.parsed!.symbol!
  if (order.kind === 'close') {
    if (judgePositions.get(symbol)?.sandboxId === sb.id) {
      judgePositions.delete(symbol)
      clearTimeout(autoClose.get(symbol))
      autoClose.delete(symbol)
    }
    return
  }
  judgePositions.set(symbol, { sandboxId: sb.id, cardId: card.id, symbol, side: order.side, qty: order.qty, openedAt: Date.now() })
  clearTimeout(autoClose.get(symbol))
  const t = setTimeout(() => void autoCloseJudge(symbol), JUDGE_AUTO_CLOSE_MS)
  t.unref?.()
  autoClose.set(symbol, t)
}

/** After JUDGE_AUTO_CLOSE_MS, close the judge's demo position (reduce-only) so the shared account is clean. */
async function autoCloseJudge(symbol: string) {
  const j = judgePositions.get(symbol)
  if (!j) return
  try {
    const r = await closePosition(bybit, j.symbol, `auto:${BOOT}:${j.sandboxId}:${j.cardId}`)
    audit('judge_auto_close', { sandbox: j.sandboxId, card: j.cardId, symbol, retCode: r.retCode, orderId: r.orderId, qty: r.qty })
    const sb = sandboxById(j.sandboxId)
    const secs = Math.round(JUDGE_AUTO_CLOSE_MS / 1000)
    if (sb) sb.session.lastResult = `${coinName(symbol)} demo position auto-closed after ${secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs} s`}`
  } catch (e) {
    audit('judge_auto_close_failed', { sandbox: j.sandboxId, symbol, error: (e as Error).message })
  } finally {
    judgePositions.delete(symbol)
    autoClose.delete(symbol)
  }
}
