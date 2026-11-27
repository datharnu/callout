// Sandbox token (docs/HOSTED.md): read once from ?s=<token>, remembered in localStorage, sent as a
// bearer token on every API call. The token is a per-visitor sandbox id, not an exchange or API key.
const KEY = 'callout.token'
// Set when the glasses app created its own session (opened from the .ehpk with no link), so it may
// replace that session by itself and show its own pairing code. A session handed over by /try never is.
const AUTO = 'callout.auto'

type Store = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>

export function readToken(search: string = location.search, store: Store | null = safeStorage()): string | null {
  const fromUrl = new URLSearchParams(search).get('s')
  if (fromUrl) {
    try {
      store?.setItem(KEY, fromUrl)
      store?.removeItem?.(AUTO)
    } catch {}
    return fromUrl
  }
  try {
    return store?.getItem(KEY) ?? null
  } catch {
    return null
  }
}

function safeStorage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** API base: explicit build override, else same origin when served from the hosted /glasses/ path, else local dev. */
export function apiBase(
  env: string | undefined = import.meta.env?.VITE_CALLOUT_API,
  loc: Pick<Location, 'pathname' | 'origin' | 'protocol'> = location,
): string {
  if (env) return env.replace(/\/$/, '')
  if (/^https?:$/.test(loc.protocol) && loc.pathname.startsWith('/glasses')) return loc.origin
  return 'http://127.0.0.1:8787'
}

/** Remember a session this app created itself. */
export function saveAutoToken(token: string, store: Store | null = safeStorage()): void {
  try {
    store?.setItem(KEY, token)
    store?.setItem(AUTO, '1')
  } catch {}
}

/** True when the stored session was created by this app (not handed over by a /try link). */
export function isAutoSession(search: string = location.search, store: Store | null = safeStorage()): boolean {
  if (new URLSearchParams(search).get('s')) return false
  try {
    return store?.getItem(AUTO) === '1'
  } catch {
    return false
  }
}

/** A backend on this machine: no session needed (it treats token-less local calls as the owner). */
export function isLocalApi(base: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)
}
