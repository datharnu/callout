// Minimal Bybit V5 REST client.
//  - Private (signed) calls go to Bybit DEMO Trading only: execution venue.
//  - Public market data comes from MAINNET: price checks and track record.
import { createHmac } from 'node:crypto'

export const DEMO_BASE = 'https://api-demo.bybit.com'
export const MAINNET_PUBLIC_BASE = 'https://api.bybit.com'
const RECV_WINDOW = '5000'

export interface BybitResponse<T = any> {
  retCode: number
  retMsg: string
  result: T
  retExtInfo?: unknown
  time?: number
}

export class BybitError extends Error {
  constructor(
    public readonly path: string,
    public readonly retCode: number,
    public readonly retMsg: string,
  ) {
    super(`${path} → retCode ${retCode}: ${retMsg}`)
  }
}

function toQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

/** Public, unsigned GET against Bybit MAINNET market data. */
export async function mainnetPublic<T = any>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const qs = toQuery(params)
  const res = await fetch(`${MAINNET_PUBLIC_BASE}${path}${qs ? `?${qs}` : ''}`)
  const body = (await res.json()) as BybitResponse<T>
  if (body.retCode !== 0) throw new BybitError(path, body.retCode, body.retMsg)
  return body.result
}

export class BybitDemoClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly base = DEMO_BASE,
  ) {
    if (!base.includes('api-demo.bybit.com') && !base.includes('api-testnet.bybit.com')) {
      // Hard guard: this client must never point at a real-money endpoint.
      throw new Error(`Refusing non-demo/testnet base URL: ${base}`)
    }
  }

  private sign(timestamp: string, payload: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(timestamp + this.apiKey + RECV_WINDOW + payload)
      .digest('hex')
  }

  /** Returns the raw envelope so callers can inspect non-zero retCodes deliberately. */
  async raw<T = any>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, any> = {},
  ): Promise<BybitResponse<T>> {
    const timestamp = Date.now().toString()
    let url = `${this.base}${path}`
    let body: string | undefined
    let payload: string
    if (method === 'GET') {
      payload = toQuery(params)
      if (payload) url += `?${payload}`
    } else {
      body = JSON.stringify(params)
      payload = body
    }
    const res = await fetch(url, {
      method,
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': this.sign(timestamp, payload),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    })
    const text = await res.text()
    if (!text && (res.status === 401 || res.status === 403)) {
      // Bybit answers a bad key/signature with an empty 401 body.
      return {
        retCode: -res.status,
        retMsg: `HTTP ${res.status}: key/secret rejected (is it a Demo Trading key?)`,
        result: {} as T,
      }
    }
    try {
      return JSON.parse(text) as BybitResponse<T>
    } catch {
      throw new Error(`${path} → HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`)
    }
  }

  /** Like raw(), but throws on retCode !== 0. */
  async call<T = any>(method: 'GET' | 'POST', path: string, params: Record<string, any> = {}): Promise<T> {
    const r = await this.raw<T>(method, path, params)
    if (r.retCode !== 0) throw new BybitError(path, r.retCode, r.retMsg)
    return r.result
  }
}

/** Deterministic, ≤36-char orderLinkId so the same call can never be ordered twice. */
export function orderLinkIdFor(kind: 'open' | 'close' | 'smoke', key: string): string {
  const h = createHmac('sha256', 'callout-olid').update(`${kind}:${key}`).digest('hex').slice(0, 24)
  return `co-${kind[0]}-${h}` // e.g. co-o-<24 hex> = 29 chars
}

/** Round a quantity DOWN to the instrument's qtyStep (never exceed the size cap). */
export function floorToStep(qty: number, step: string): string {
  const decimals = step.includes('.') ? step.split('.')[1]!.length : 0
  const s = Number(step)
  const floored = Math.floor(qty / s + 1e-9) * s
  return floored.toFixed(decimals)
}
