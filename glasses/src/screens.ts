// Pure text renderers for the 576x288 monochrome display.
// Rules: neutral wording (facts, never "good"/"bad"), no ✓, only glyphs the G2 font has:
// ● ○ ■ □ ▲ ▼ ━ ─ │ > and "·" (verified in the simulator). Unsupported glyphs are silently dropped.
import type { CardView, StateView } from './api'

const BAR_WIDTH = 20

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  if (Math.abs(v) >= 10_000) return `${trim((v / 1000).toFixed(2))}k`
  if (Math.abs(v) >= 1) return trim(v.toFixed(Math.abs(v) >= 100 ? 2 : 4))
  return trim(v.toPrecision(4))
}
const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
const coin = (symbol: string | null) => (symbol ?? '?').replace(/USDT$/, '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
/** Strip characters the glasses font won't render (emoji etc.) so line lengths stay predictable. */
const safe = (s: string) => s.replace(/[^\x20-\x7E·●○■□▲▼━─│]/gu, '').replace(/\s+/g, ' ').trim()

function minsLeft(expiresAt: number, now: number): string {
  const m = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return `expires in ${m}m`
}

export function homeScreen(s: StateView, offline: boolean): string {
  const { groups, muted, forYou, expired, last } = s.session
  return [
    `CALLOUT · session on · ${groups} group${groups === 1 ? '' : 's'}`,
    `${muted} muted · ${forYou} for you`,
    expired ? `${expired} call${expired === 1 ? '' : 's'} while away (expired)` : '',
    last ? `Last: ${last}` : '',
    '',
    offline ? 'Backend offline · retrying' : 'Watching your groups...',
    '',
    'Double-tap to exit',
  ]
    .filter((l, i, a) => l !== '' || (a[i - 1] ?? '') !== '')
    .join('\n')
}

function header(c: CardView, pos: string): string {
  return `● ${clip(safe(c.sender), 22)} · allowlisted${c.edited ? ' · edited' : ''}${pos ? `   ${pos}` : ''}`
}

function levels(c: CardView): string[] {
  const tps = c.targets.map(fmtPrice).join('/')
  return [
    `${(c.side ?? '?').toUpperCase()} ${c.symbol ?? '?'}  entry ${fmtPrice(c.entry)}`,
    `SL ${fmtPrice(c.stop)}  TP ${tps || '-'}${c.rr !== null ? `   R:R ${c.rr.toFixed(1)}` : ''}`,
  ]
}

export function cardScreen(c: CardView, now: number, pos: string): string {
  if (c.state === 'countdown') return countdownScreen(c, now)
  if (c.state === 'placing') return [`Placing ${coin(c.symbol)} ${c.side} $${c.sizeUsd} (demo)...`, '', 'Sent to Bybit Demo · waiting for fill'].join('\n')
  if (c.state === 'filled' || c.state === 'failed' || c.state === 'cancelled') return resultScreen(c)

  if (c.state === 'unsure') {
    const holding = c.flags.includes('holding update')
    return [
      header(c, pos),
      `"${clip(safe(c.raw), 110)}"`,
      '',
      holding ? 'Holding update · no action here yet' : "Couldn't read this clearly",
      '',
      '○ Skip',
    ].join('\n')
  }

  if (c.state === 'blocked') {
    return [
      header(c, pos),
      ...(c.symbol && c.side ? levels(c) : []),
      `"${clip(safe(c.raw), 80)}"`,
      clip(c.flags.join(' · '), 120),
      '',
      '○ Skip',
    ].join('\n')
  }

  // ready
  const dist = c.distancePct !== null ? `${Math.abs(c.distancePct).toFixed(1)}% from call` : ''
  return [
    header(c, pos),
    ...levels(c),
    `Price ${fmtPrice(c.livePrice)} · ${dist}`,
    minsLeft(c.expiresAt, now),
    '',
    `> Place $${c.sizeUsd} demo   ○ Skip`,
  ].join('\n')
}

export function countdownScreen(c: CardView, now: number): string {
  const total = 5000
  const left = Math.max(0, (c.countdownEndsAt ?? now) - now)
  const n = Math.round((left / total) * BAR_WIDTH)
  return [
    `Placing ${coin(c.symbol)} ${c.side} $${c.sizeUsd} (demo)...`,
    '',
    `${'━'.repeat(n)}${'─'.repeat(BAR_WIDTH - n)}  ${Math.ceil(left / 1000)}s`,
    '',
    'Tap to cancel',
  ].join('\n')
}

export function resultScreen(c: CardView): string {
  if (c.state === 'filled' && c.order) {
    const o = c.order
    const id = o.orderId.length > 12 ? `${o.orderId.slice(0, 4)}...${o.orderId.slice(-2)}` : o.orderId
    return [
      `FILLED ${o.qty} ${coin(c.symbol)} @ ${Number(o.avgPrice).toLocaleString('en-US')}`,
      `Order ${id} · Bybit Demo`,
      o.receiptSent ? 'Receipt sent to Telegram' : 'No receipt (replayed message)',
      '',
      '> Tap to continue',
    ].join('\n')
  }
  if (c.state === 'cancelled') return ['Cancelled · no order sent', '', '> Tap to continue'].join('\n')
  return ['NOT PLACED', clip(safe(c.error ?? 'unknown error'), 120), '', '> Tap to continue'].join('\n')
}
