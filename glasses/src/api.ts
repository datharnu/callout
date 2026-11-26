// Backend client. The glasses app holds no secrets: it only reads state and sends the user's taps.
export const API_BASE: string = import.meta.env.VITE_CALLOUT_API ?? 'http://127.0.0.1:8787'

export type CardState =
  | 'ready' | 'holding' | 'blocked' | 'unsure' | 'countdown' | 'placing'
  | 'filled' | 'failed' | 'cancelled' | 'skipped' | 'expired' | 'superseded'

export interface CardView {
  id: string
  action: 'open' | 'close'
  state: CardState
  edited: boolean
  sender: string
  allowlisted: boolean
  chat: string
  kind?: string
  symbol: string | null
  side: 'long' | 'short' | null
  entry: number | null
  stop: number | null
  targets: number[]
  rr: number | null
  livePrice: number | null
  distancePct: number | null
  flags: string[]
  raw: string
  sizeUsd: number
  expiresAt: number
  countdownEndsAt: number | null
  cancelWindowMs: number
  order: { kind: 'open' | 'close'; orderId: string; side: string; qty: string; avgPrice?: string; status: string; receiptSent?: boolean } | null
  position: { side: 'Buy' | 'Sell'; size: string; avgPrice: number; markPrice: number; pnlPct: number } | null
  record: { seen: number; tp: number; sl: number; open: number; noEntry: number; ambiguous: number; synthetic: boolean } | null
  error: string | null
}

export interface StateView {
  now: number
  session: { groups: number; muted: number; forYou: number; expired: number; last: string }
  cards: CardView[]
}

export async function fetchState(): Promise<StateView> {
  const r = await fetch(`${API_BASE}/api/state`)
  if (!r.ok) throw new Error(`state ${r.status}`)
  return (await r.json()) as StateView
}

export type Action = 'confirm' | 'cancel' | 'skip' | 'dismiss'

export type ActionResult = { ok: true; card: CardView } | { ok: false; error: string }

export async function sendAction(id: string, action: Action): Promise<ActionResult> {
  const r = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
  const body = (await r.json()) as any
  return r.ok ? { ok: true, card: body as CardView } : { ok: false, error: String(body?.error ?? r.status) }
}
