// Pure text renderers for the 576x288 monochrome display.
// Rules: neutral wording (facts, never "good"/"bad"), no ✓, only glyphs the G2 font has:
// ● ○ ■ □ ▲ ▼ ━ ─ │ > and "·" (verified in the simulator). Unsupported glyphs are silently dropped.
import type { CardView, StateView } from './api'

const BAR_WIDTH = 20
const VOICE_NOTE_MS = 8000 // how long the result of a voice command stays on the card

export interface VoiceUi {
  status: 'off' | 'unavailable' | 'no_audio' | 'listening' | 'hearing' | 'sending'
}

/** Bottom line of every card: what the mic is doing, or what the last command did. */
export function voiceLine(c: CardView, v: VoiceUi | undefined, now: number): string {
  if (!v || v.status === 'off') return ''
  if (v.status === 'unavailable') return 'voice unavailable · tap works'
  if (v.status === 'no_audio') return 'mic · no audio (check mic permission) · tap works'
  if (v.status === 'hearing') return 'mic · hearing you...'
  if (v.status === 'sending') return 'mic · working...'
  // A note is shown only on the card state it was made in (never a stale "tap to place" on the countdown).
  if (c.voice && c.voice.state === c.state && now - c.voice.at < VOICE_NOTE_MS) {
    // When the action itself changed the screen (cancelled, skipped...), just confirm what was heard.
    if (c.voice.result === 'done') return `mic · heard "${clip(safe(c.voice.heard), 40)}"`
    return `mic · ${clip(safe(c.voice.message), 58)}`
  }
  return c.voiceHint ? `mic · ${c.voiceHint}` : ''
}

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

export interface OwnSessionUi {
  pair: { code: string; group: { title?: string; inviteUrl?: string } } | null
  linkedAs: string | null
  note: string | null
}

/**
 * Home screen for a demo session this app started itself (the .ehpk with no /try link): a tap sends a
 * sample call; a /pair code links the wearer's Telegram so their own calls arrive here.
 */
export function ownHomeScreen(s: StateView, ui: OwnSessionUi, offline: boolean): string {
  const group = clip(safe(ui.pair?.group.title || 'the Callout group'), 26)
  const invite = ui.pair?.group.inviteUrl?.replace(/^https?:\/\//, '') ?? ''
  const telegram = ui.linkedAs
    ? [`Telegram linked: ${clip(safe(ui.linkedAs), 24)}`, 'Post a call in the group to see it here']
    : ui.pair
      ? ['Or post your own call from Telegram:', `join ${group}${invite ? ` · ${invite}` : ''}`, `then send   /pair ${ui.pair.code}`]
      : ['Telegram: getting a pairing code...']
  return [
    `CALLOUT · demo session · ${s.session.muted} muted`,
    offline ? 'Backend offline · retrying' : ui.note ?? '> Tap: send a sample call',
    '',
    ...telegram,
    '',
    'Bybit Demo money only · Double-tap to exit',
  ].join('\n')
}

function header(c: CardView, pos: string): string {
  // A call the wearer sent from their private chat with the bot says so; group calls name the allowlisted caller.
  const who = c.via === 'private'
    ? c.sender === 'you' ? 'Sent by you from Telegram' : `${clip(safe(c.sender), 18)} · forwarded by you`
    : `${clip(safe(c.sender), 22)} · allowlisted`
  return `● ${who}${c.edited ? ' · edited' : ''}${pos ? `   ${pos}` : ''}`
}

/** Track record: counts and sample size, never a score. */
export function recordLine(c: CardView): string {
  const r = c.record
  if (!r) return ''
  if (!r.seen) return 'No earlier calls seen from this sender'
  const other = r.noEntry + r.ambiguous
  return `Seen ${r.seen} · ${r.tp} TP · ${r.sl} SL · ${r.open} open${other ? ` · ${other} other` : ''}${r.synthetic ? ' (synthetic)' : ''}`
}

const posSide = (s: 'Buy' | 'Sell') => (s === 'Buy' ? 'long' : 'short')
const signedPct = (p: number) => `${p >= 0 ? '+' : '-'}${Math.abs(p).toFixed(1)}%`

function levels(c: CardView): string[] {
  const tps = c.targets.map(fmtPrice).join('/')
  return [
    `${(c.side ?? '?').toUpperCase()} ${c.symbol ?? '?'}  entry ${fmtPrice(c.entry)}`,
    `SL ${fmtPrice(c.userStop ?? c.stop)}${c.userStop !== null && c.userStop !== undefined ? ' (you)' : ''}  TP ${tps || '-'}${c.rr !== null ? `   R:R ${c.rr.toFixed(1)}` : ''}`,
  ]
}

export function cardScreen(c: CardView, now: number, pos: string, v?: VoiceUi): string {
  const body = cardBody(c, now, pos)
  // A backend notice (e.g. another judge's order is open) replaces the mic line while present.
  const line = c.notice ? clip(safe(c.notice), 64) : c.state === 'placing' ? '' : voiceLine(c, v, now)
  return line ? `${body}\n${line}` : body
}

function cardBody(c: CardView, now: number, pos: string): string {
  if (c.state === 'countdown') return countdownScreen(c, now)
  if (c.state === 'placing') return [`${actionLabel(c)}...`, '', 'Sent to Bybit Demo · waiting for fill'].join('\n')
  if (c.state === 'filled' || c.state === 'failed' || c.state === 'cancelled') return resultScreen(c)

  if (c.state === 'holding' && c.position) {
    const p = c.position
    return [
      header(c, pos),
      `"${clip(safe(c.raw), 90)}"`,
      `Your ${coin(c.symbol)} ${posSide(p.side)} ${p.size} · ${signedPct(p.pnlPct)}`,
      `Entry ${fmtPrice(p.avgPrice)} · now ${fmtPrice(p.markPrice)}`,
      '',
      '> Close (reduce-only)   ○ Keep',
    ].join('\n')
  }

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
    recordLine(c),
    minsLeft(c.expiresAt, now),
    '',
    `> Place $${c.sizeUsd} demo   ○ Skip`,
  ].join('\n')
}

function actionLabel(c: CardView): string {
  if (c.action === 'close' && c.position) return `Closing ${coin(c.symbol)} ${posSide(c.position.side)} ${c.position.size} (reduce-only, demo)`
  return `Placing ${coin(c.symbol)} ${c.side} $${c.sizeUsd} (demo)`
}

export function countdownScreen(c: CardView, now: number): string {
  const total = c.cancelWindowMs || 5000
  const left = Math.max(0, (c.countdownEndsAt ?? now) - now)
  const n = Math.round((left / total) * BAR_WIDTH)
  return [
    `${actionLabel(c)}...`,
    '',
    `${'━'.repeat(n)}${'─'.repeat(BAR_WIDTH - n)}  ${Math.ceil(left / 1000)}s`,
    '',
    'Tap to cancel',
  ].join('\n')
}

export function resultScreen(c: CardView): string {
  if (c.state === 'filled' && c.order) {
    const o = c.order
    // Bybit's Order History shows the LAST 8 characters of the order ID; show exactly that.
    const id = o.orderId.length > 8 ? `...${o.orderId.slice(-8)}` : o.orderId
    return [
      `${o.kind === 'close' ? 'CLOSED' : 'FILLED'} ${o.qty} ${coin(c.symbol)} @ ${Number(o.avgPrice).toLocaleString('en-US')}${o.kind === 'close' ? ' (reduce-only)' : ''}`,
      `Order ${id} · Bybit Demo`,
      o.receiptSent ? 'Receipt sent to Telegram' : 'No receipt (sample call, not from Telegram)',
      '',
      '> Tap to continue',
    ].join('\n')
  }
  if (c.state === 'cancelled') return ['Cancelled · no order sent', '', '> Tap to continue'].join('\n')
  return ['NOT PLACED', clip(safe(c.error ?? 'unknown error'), 120), '', '> Tap to continue'].join('\n')
}
