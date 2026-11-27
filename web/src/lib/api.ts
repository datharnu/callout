// Sandbox client for /try (docs/HOSTED.md). The token is a per-visitor sandbox id, kept in localStorage.
const KEY = 'callout.token'
export const MOCK = new URLSearchParams(location.search).get('mock') === '1' // local dev only
/** Backend origin. Empty = same origin (local / single-service hosting); set at build time when the API lives elsewhere. */
export const API = ((import.meta.env.VITE_CALLOUT_API as string | undefined) ?? '').replace(/\/$/, '')

/**
 * Free hosting puts the backend to sleep when idle; the first request wakes it (~30-50 s).
 * Resolves once /api/health answers; reports elapsed seconds while waiting.
 */
/** Thrown when the owner has paused the public judge mode (backend kill switch). */
export class PausedError extends Error {}
const PAUSED_TEXT = 'Try it live is paused right now. Please watch the demo video, or check back later.'

export async function waitForServer(onWaiting: (seconds: number) => void, maxMs = 150_000): Promise<void> {
  if (MOCK) return
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
      if (r.ok) {
        const h = (await r.json().catch(() => ({}))) as { judges?: string }
        if (h.judges === 'paused') throw new PausedError(PAUSED_TEXT)
        return
      }
    } catch (e) {
      if (e instanceof PausedError) throw e
    }
    onWaiting(Math.round((Date.now() - t0) / 1000))
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('The Callout server did not wake up. Please reload in a minute.')
}

/** Fire-and-forget: start waking the backend while the visitor reads the landing page. */
export function prewarm() {
  if (!MOCK) fetch(`${API}/api/health`, { cache: 'no-store' }).catch(() => {})
}

export class LimitError extends Error {}

export interface Sandbox { token: string; sandboxId: string; expiresAt: number | string }

let current: Sandbox | null = null
const tokenListeners = new Set<(t: string) => void>()
export function onTokenChange(fn: (t: string) => void) {
  tokenListeners.add(fn)
  return () => tokenListeners.delete(fn)
}

export async function ensureSandbox(force = false): Promise<Sandbox> {
  if (!force && current) return current
  const stored = !force && !MOCK ? localStorage.getItem(KEY) : null
  if (stored) {
    current = { token: stored, sandboxId: '', expiresAt: '' }
    return current
  }
  if (MOCK) current = { token: 'mock', sandboxId: 'mock', expiresAt: '' }
  else {
    const r = await fetch(`${API}/api/sandbox`, { method: 'POST' })
    if (r.status === 429) throw new LimitError('Too many new sessions from your network. Try again in a few minutes.')
    if (r.status === 503) throw new PausedError(PAUSED_TEXT)
    if (!r.ok) throw new Error(`Could not start a session (${r.status})`)
    current = (await r.json()) as Sandbox
  }
  if (!MOCK) localStorage.setItem(KEY, current.token) // never persist the dev-only mock token
  tokenListeners.forEach(f => f(current!.token))
  return current
}

/** Authenticated JSON call. A 401 recreates the sandbox once; 429 becomes a LimitError. */
export async function api<T = unknown>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const sb = await ensureSandbox()
  const headers = new Headers(init.headers)
  if (!MOCK) headers.set('authorization', `Bearer ${sb.token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const r = await fetch(`${API}${path}`, { ...init, headers })
  if (r.status === 401 && retry && !MOCK) {
    localStorage.removeItem(KEY)
    current = null
    await ensureSandbox(true)
    return api<T>(path, init, false)
  }
  const body = (await r.json().catch(() => ({}))) as { error?: string }
  if (r.status === 429) throw new LimitError(body.error ?? 'You reached this sandbox’s limit for now. It resets soon.')
  if (r.status === 503) throw new PausedError(body.error ?? PAUSED_TEXT)
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`)
  return body as T
}

// ── shapes from the contract ────────────────────────────────────────────────────────────────────
export interface CardLite {
  id: string; state: string; symbol: string | null; side: string | null; flags: string[]; raw: string
  sizeUsd: number; userStop: number | null; order: { orderId: string; avgPrice?: string; qty: string; kind: string } | null
  voice: { heard: string; message: string; at: number } | null
  notice?: string | null
}
export interface StateLite { now: number; session: { muted: number; forYou: number; expired: number; last: string }; cards: CardLite[] }
export interface PairStart { code: string; expiresAt: number | string; command?: string; group?: { title?: string; inviteUrl?: string } }
export interface PairStatus { linked: boolean; telegram?: string }
export type SampleKind = 'clean' | 'scam' | 'impostor' | 'vague' | 'far' | 'holding' | 'chatter'

export const getState = () => api<StateLite>('/api/state')
export const getSettings = () => api<JudgeSettings>('/api/settings')

export interface SampleResult { kind?: string; text?: string; sender?: string; outcome: string; reason?: string; card?: CardLite }
export interface JudgeSettings {
  kind?: 'judge' | 'owner'; sizeUsd?: number; tradesToday?: number; rules?: { maxTradesPerDay?: number }
  telegram?: { linked: boolean; name?: string }
  limits?: Record<string, unknown>
  judgePosition?: null | { mine: boolean; closesInSec: number }
}

export async function sendSample(kind: SampleKind): Promise<SampleResult> {
  if (MOCK) return mockSample(kind)
  return api('/api/judge/sample', { method: 'POST', body: JSON.stringify({ kind }) })
}
export async function startPair(): Promise<PairStart> {
  if (MOCK) return { code: '482913', expiresAt: Date.now() + 600_000, group: { title: "A'ska & Callout" } }
  return api('/api/pair', { method: 'POST' })
}
export async function pairStatus(): Promise<PairStatus> {
  if (MOCK) return { linked: false }
  return api('/api/pair')
}

// Local-dev stand-in for /api/judge/sample: replays a message through the owner pipeline.
async function mockSample(kind: SampleKind) {
  const t = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT').then(r => r.json())
  const px = Number(t.result.list[0].lastPrice)
  const k = (v: number) => `${(Math.round(v / 100) * 100 / 1000).toFixed(1)}k`
  const [E, S, T] = [k(px), k(px * 0.98), k(px * 1.04)]
  const text: Record<SampleKind, string> = {
    clean: `LONG BTC entry ${E} SL ${S} TP ${T}`,
    scam: `🔥 GUARANTEED 100% WIN 🔥 LONG BTC ${E} SL ${S} TP ${T} join t.me/vip_pumps`,
    impostor: `LONG BTC entry ${E} SL ${S} TP ${T}`,
    vague: 'btc looking spicy here 👀 might long soon, levels later',
    far: `LONG BTC entry ${k(px * 0.9)} SL ${k(px * 0.88)} TP ${k(px * 0.95)}`,
    holding: 'Taking profit on BTC here, closing the long',
    chatter: 'gm everyone ☕',
  }
  const extra = kind === 'impostor' ? { senderId: '123456', senderName: '@impostor' } : {}
  const r = await fetch('/api/demo/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text[kind], ...extra }) })
  return r.json()
}
