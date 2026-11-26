// Sandbox token (docs/HOSTED.md): read once from ?s=<token>, remembered in localStorage, sent as a
// bearer token on every API call. The token is a per-visitor sandbox id, not an exchange or API key.
const KEY = 'callout.token'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function readToken(search: string = location.search, store: Store | null = safeStorage()): string | null {
  const fromUrl = new URLSearchParams(search).get('s')
  if (fromUrl) {
    try {
      store?.setItem(KEY, fromUrl)
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
