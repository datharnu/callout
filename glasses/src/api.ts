// Backend client. The glasses app holds no secrets: it only reads state and sends the user's taps.
// The sandbox token (docs/HOSTED.md) identifies this visitor's sandbox; it is not an API key.
import { apiBase, isAutoSession, isLocalApi, readToken, saveAutoToken } from './auth'

export const API_BASE: string = apiBase()
let TOKEN = readToken()
/** This app created the session itself (opened from the .ehpk against the hosted backend). */
export let OWN_SESSION = isAutoSession()

/** The backend did not recognise this session (missing/expired token). */
export class AuthError extends Error {}
/** The owner has paused the public demo (backend kill switch). */
export class PausedError extends Error {}

/**
 * Make sure there is a session. With a hosted backend and no token (the .ehpk on real glasses), start a
 * demo session of our own. Locally, none is needed. A /try link brings its own token.
 */
export async function ensureSession(): Promise<void> {
  if (TOKEN || isLocalApi(API_BASE)) return
  await newSession()
}

let renewing: Promise<boolean> | null = null
/**
 * The session was lost (the server restarted, or an old one was remembered): start a new one of our own,
 * once at a time. Not for a session handed over by a /try link in this launch (that page owns it) and not
 * for a local backend.
 */
export function renewOwnSession(): Promise<boolean> {
  const linked = typeof location !== 'undefined' && new URLSearchParams(location.search).has('s')
  if (linked || isLocalApi(API_BASE)) return Promise.resolve(false)
  renewing ??= newSession().then(() => true, () => false).finally(() => { renewing = null })
  return renewing
}

async function newSession(): Promise<void> {
  const r = await fetch(`${API_BASE}/api/sandbox`, { method: 'POST' })
  if (r.status === 503) throw new PausedError('paused')
  if (!r.ok) throw new Error(`session ${r.status}`)
  const body = (await r.json()) as { token: string }
  TOKEN = body.token
  OWN_SESSION = true
  saveAutoToken(body.token)
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}`, ...extra } : extra
}

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
  userStop: number | null
  rev?: number // revision of the values on screen; sent back with a tap so it places exactly what was seen
  voice: { heard: string; command?: string; result: string; message: string; state: CardState; at: number } | null
  voiceHint: string
  record: { seen: number; tp: number; sl: number; open: number; noEntry: number; ambiguous: number; synthetic: boolean } | null
  error: string | null
  /** Short neutral message from the backend, shown for a few seconds (e.g. a refused tap). */
  notice?: string | null
}

export interface StateView {
  now: number
  session: { groups: number; muted: number; forYou: number; expired: number; last: string }
  cards: CardView[]
}

export async function fetchState(): Promise<StateView> {
  const r = await fetch(`${API_BASE}/api/state`, { headers: headers() })
  if (r.status === 401) throw new AuthError('session not recognised')
  if (r.status === 503) throw new PausedError('paused')
  if (!r.ok) throw new Error(`state ${r.status}`)
  return (await r.json()) as StateView
}

// ── own demo session (the .ehpk on real glasses): pairing + sample calls ──
export interface PairCode { code: string; expiresAt: number; group: { title?: string; inviteUrl?: string } }

export async function newPairCode(): Promise<PairCode> {
  const r = await fetch(`${API_BASE}/api/pair`, { method: 'POST', headers: headers() })
  if (!r.ok) throw new Error(`pair ${r.status}`)
  return (await r.json()) as PairCode
}

export async function pairStatus(): Promise<{ linked: boolean; telegram?: string }> {
  const r = await fetch(`${API_BASE}/api/pair`, { headers: headers() })
  if (!r.ok) throw new Error(`pair ${r.status}`)
  return (await r.json()) as { linked: boolean; telegram?: string }
}

/** Ask the backend for a sample call on this session's own coin (it goes through the normal checks). */
export async function sendSample(kind = 'clean'): Promise<{ outcome: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/judge/sample`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ kind }),
  })
  const body = (await r.json().catch(() => ({}))) as { outcome?: string; error?: string }
  return r.ok ? { outcome: body.outcome ?? 'card' } : { outcome: 'error', error: body.error ?? `sample ${r.status}` }
}

export type Action = 'confirm' | 'cancel' | 'skip' | 'dismiss'

export interface VoiceResponse {
  heard: string
  note: { result: string; message: string }
  navigate?: 'next' | 'prev'
  card: CardView | null
}

/** One utterance of raw 16 kHz s16le mono PCM → transcript + what it did to the card. */
export async function sendVoice(id: string, pcm: Uint8Array): Promise<VoiceResponse> {
  const r = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(id)}/voice`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/octet-stream' }),
    body: new Uint8Array(pcm),
  })
  if (!r.ok) throw new Error(`voice ${r.status}`)
  return (await r.json()) as VoiceResponse
}

export type ActionResult = { ok: true; card: CardView } | { ok: false; error: string }

export async function sendAction(id: string, action: Action, rev?: number): Promise<ActionResult> {
  const q = action === 'confirm' && rev !== undefined ? `?rev=${rev}` : ''
  const r = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(id)}/${action}${q}`, { method: 'POST', headers: headers() })
  const body = (await r.json()) as any
  return r.ok ? { ok: true, card: body as CardView } : { ok: false, error: String(body?.error ?? r.status) }
}
