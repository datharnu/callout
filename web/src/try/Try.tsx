import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Nav, VIDEO } from '../components/ui'
import { PageEnter, EASE } from '../components/motion'
import {
  ensureSandbox, getState, getSettings, LimitError, MOCK, PausedError, onTokenChange, pairStatus, sendSample, startPair, waitForServer,
  type CardLite, type JudgeSettings, type PairStart, type PairStatus, type SampleKind, type StateLite,
} from '../lib/api'
import { startMic, type MicHandle } from '../lib/mic'

type Input = 'click' | 'double_click' | 'up' | 'down'

/** The "tricky" samples: each one shows a different way Callout refuses or stays quiet. */
const TRICKY: { kind: SampleKind; title: string; expect: string }[] = [
  { kind: 'scam', title: 'Scam', expect: 'A call with “100% WIN” and a link. Callout should block it.' },
  { kind: 'impostor', title: 'Impostor', expect: 'The same call from a look-alike name. Callout should ignore it.' },
  { kind: 'vague', title: 'Vague', expect: '“Might long soon, levels later.” Callout should not offer a trade.' },
  { kind: 'far', title: 'Stale price', expect: 'An entry 10% away from the live price. Callout should block it.' },
  { kind: 'chatter', title: 'Chatter', expect: '“gm everyone.” Callout should stay quiet.' },
  { kind: 'holding', title: 'Take profit', expect: 'The caller takes profit. Close your open demo position (place a call first).' },
]

interface LogLine { at: number; text: string; tone?: 'amber' | 'green' }
interface LastMessage { text: string; sender: string; at: number; outcome?: string; reason?: string }

export function Try() {
  const [token, setToken] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [waking, setWaking] = useState<number | null>(null) // seconds spent waiting for the backend, or null
  useEffect(() => {
    const off = onTokenChange(t => setToken(t))
    // Only show the connecting screen if the server hasn't answered within ~1 s (no flash on a warm server).
    waitForServer(sec => setWaking(sec >= 1 ? sec : null))
      .then(() => {
        setWaking(null)
        return ensureSandbox()
      })
      .then(s => setToken(s.token))
      .catch(e => {
        setWaking(null)
        setPaused(e instanceof PausedError)
        setErr(e instanceof Error ? e.message : String(e))
      })
    return () => void off()
  }, [])

  return (
    <div className="page try-page">
      <Nav cta={false} />
      <PageEnter>
        <section className="wrap inner try-head">
          <div className="eyebrow">Try Callout</div>
          <div className="try-head-row">
            <h1 className="try-title">Review a Telegram trade call on G2, then place a demo order.</h1>
            <span className="demo-pill"><img src="/brand/partners/bybit.png" alt="Bybit" className="bybit-mark" /><b>Demo</b> · No real money</span>
          </div>
        </section>
        <AnimatePresence>{waking !== null && !token && <WakeUp seconds={waking} />}</AnimatePresence>
        {err && (
          <div className="wrap inner">
            <div className="try-error">
              {err}
              {paused && <> <a href={VIDEO} target="_blank" rel="noreferrer">Watch the demo video</a>.</>}
            </div>
          </div>
        )}
        {token && <Workbench token={token} />}
      </PageEnter>
      {/* No site footer here: the workbench is the whole page. Only the disclaimer stays. */}
      <p className="wrap inner try-fineprint">Bybit Demo money only · Not financial advice · © 2026 datharnu</p>
    </div>
  )
}

/** Which card the glasses are showing: results and orders in flight first, else the newest (same rule as the app). */
function focusCard(s: StateLite | null): CardLite | undefined {
  const cs = s?.cards ?? []
  return cs.find(c => ['countdown', 'placing', 'filled', 'failed', 'cancelled'].includes(c.state)) ?? cs[0]
}

function Workbench({ token }: { token: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [display, setDisplay] = useState('CALLOUT · connecting...')
  const [glassesMic, setGlassesMic] = useState(false)
  const [mic, setMic] = useState<MicHandle | null>(null)
  const [micErr, setMicErr] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [pressed, setPressed] = useState<Input | null>(null)
  // After a tap that asks the server something (place / close), show it at once until the glasses change.
  const [pending, setPending] = useState<{ key: string; label: string } | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [state, setState] = useState<StateLite | null>(null)
  const [settings, setSettings] = useState<JudgeSettings | null>(null)
  const [lastMsg, setLastMsg] = useState<LastMessage | null>(null)
  // The card the glasses app is showing (it tells us); undefined until it has said anything.
  const [focus, setFocus] = useState<{ id: string | null; state: string | null } | undefined>(undefined)
  const refresh = useRef<() => void>(() => {})
  const [now, setNow] = useState(Date.now())
  const clockOffset = useRef(0) // server time - local time, so countdowns match the backend
  const firstSeen = useRef(new Map<string, number>())
  const glassesMicRef = useRef(false)
  glassesMicRef.current = glassesMic

  const push = useCallback((text: string, tone?: LogLine['tone']) => setLog(l => [{ at: Date.now(), text, tone }, ...l].slice(0, 40)), [])

  // Messages from the glasses app (same origin, from our iframe only).
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== frameRef.current?.contentWindow) return
      const d = ev.data as { type?: string; content?: string; on?: boolean; id?: string | null; state?: string | null }
      if (d?.type === 'callout:display' && typeof d.content === 'string') setDisplay(d.content)
      if (d?.type === 'callout:mic' && typeof d.on === 'boolean') setGlassesMic(d.on)
      if (d?.type === 'callout:focus') {
        setFocus({ id: d.id ?? null, state: d.state ?? null })
        refresh.current() // fetch the card's details now rather than on the next tick
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const send = useCallback((action: Input) => {
    frameRef.current?.contentWindow?.postMessage({ type: 'callout:input', action }, location.origin)
    setPressed(action)
    setTimeout(() => setPressed(p => (p === action ? null : p)), 180)
  }, [])

  // Keyboard: Enter = tap, Esc/Backspace = double-tap, ↑/↓ = swipe, M = mic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && ['INPUT', 'TEXTAREA', 'SUMMARY', 'BUTTON'].includes(t.tagName) && e.key === 'Enter') return
      if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return
      if (e.key === 'Enter') { e.preventDefault(); send('click') }
      else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); send('double_click') }
      else if (e.key === 'ArrowUp') { e.preventDefault(); send('up') }
      else if (e.key === 'ArrowDown') { e.preventDefault(); send('down') }
      else if (e.key.toLowerCase() === 'm') void toggleMic()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function toggleMic() {
    if (mic) { mic.stop(); setMic(null); setLevel(0); return }
    setMicErr(null)
    try {
      const h = await startMic(
        pcm => { if (glassesMicRef.current) frameRef.current?.contentWindow?.postMessage({ type: 'callout:audio', pcm }, location.origin, [pcm]) },
        rms => setLevel(rms),
      )
      setMic(h)
    } catch (e) {
      setMicErr(e instanceof Error && e.name === 'NotAllowedError' ? 'Microphone permission was denied. Taps still work.' : 'Could not open the microphone. Taps still work.')
    }
  }
  useEffect(() => () => mic?.stop(), [mic])

  // State (cards) every 1.5 s, settings every 5 s, a clock for countdowns.
  const prev = useRef<StateLite | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const s = await getState()
        if (!alive) return
        clockOffset.current = s.now - Date.now()
        for (const c of s.cards) if (!firstSeen.current.has(c.id)) firstSeen.current.set(c.id, Date.now())
        diff(prev.current, s, push)
        prev.current = s
        setState(s)
      } catch {}
    }
    const loadSettings = () => getSettings().then(x => alive && setSettings(x)).catch(() => {})
    refresh.current = () => void tick()
    void tick()
    void loadSettings()
    const t = setInterval(tick, 1500)
    const u = setInterval(loadSettings, 5000)
    const c = setInterval(() => setNow(Date.now()), 500)
    return () => { alive = false; clearInterval(t); clearInterval(u); clearInterval(c) }
  }, [push, token])

  async function sample(kind: SampleKind) {
    const r = await sendSample(kind)
    if (r.text) setLastMsg({ text: r.text, sender: r.sender ?? '', at: Date.now(), outcome: r.outcome, reason: r.reason })
    const said = r.text ? `“${r.text}”${r.sender ? ` from ${r.sender}` : ''}` : 'a sample'
    if (r.card) push(`Posted ${said} → card ${r.card.state}${r.card.flags?.length ? ` (${r.card.flags.join(' · ')})` : ''}`, r.card.state === 'blocked' ? 'amber' : undefined)
    else push(`Posted ${said} → ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`)
    void getSettings().then(setSettings).catch(() => {})
  }

  // Follow the glasses exactly once they report; before that, guess with the same rule the app uses.
  const card: CardLite | undefined = focus === undefined
    ? focusCard(state)
    : focus.id ? (() => { const c = state?.cards.find(x => x.id === focus.id); return c ? { ...c, state: focus.state ?? c.state } : undefined })() : undefined
  const serverNow = now + clockOffset.current
  const countdownLeft = card?.state === 'countdown' && card.countdownEndsAt ? Math.max(0, Math.ceil((card.countdownEndsAt - serverNow) / 1000)) : 0
  // The bubble shows the message behind the card on screen, or the last sample if it made no card.
  const cardMsg = card ? { text: card.raw, sender: card.sender ?? '', at: firstSeen.current.get(card.id) ?? Date.now() } : null
  const quietNewer = !!lastMsg && lastMsg.outcome !== 'card' && (!cardMsg || lastMsg.at > cardMsg.at)
  const bubble: LastMessage | null = useMemo(() => (quietNewer ? lastMsg : cardMsg ?? lastMsg), [quietNewer, lastMsg, cardMsg?.text, cardMsg?.at])
  const quiet = quietNewer
  const cardKey = card ? `${card.id}:${card.state}` : 'none'
  useEffect(() => { if (pending && pending.key !== cardKey) setPending(null) }, [cardKey, pending])
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => setPending(null), 8000) // never leave the button stuck
    return () => clearTimeout(t)
  }, [pending])
  const tap = pending ? { label: pending.label, tone: 'idle' as const } : tapLabel(card, countdownLeft)
  function onTapMain() {
    if (card?.state === 'ready') setPending({ key: cardKey, label: 'Checking the live price again…' })
    else if (card?.state === 'holding') setPending({ key: cardKey, label: 'Checking your position…' })
    send('click')
  }
  const dbl = doubleTapLabel(card)
  const swipable = (state?.cards ?? []).filter(c => ['ready', 'holding', 'blocked', 'unsure'].includes(c.state)).length > 1

  const src = MOCK ? '/glasses/?preview=1' : `/glasses/?s=${encodeURIComponent(token)}&preview=1`
  const simCmd = `npx @evenrealities/evenhub-simulator "${location.origin}/glasses/?s=${token}"`

  return (
    <section className="wrap inner bench">
      {/* left · the glasses and their controls */}
      <div className="bench-glasses">
        {bubble && <div className="only-mobile"><Bubble msg={bubble} /></div>}
        <div className="device">
          <div className="device-top">
            <span className="t-mono">Even Realities G2<span className="hide-phone"> · browser preview</span></span>
            <span className={`mic-state ${glassesMic ? 'on' : ''}`}><i />{glassesMic ? 'glasses mic listening' : 'glasses mic off'}</span>
          </div>
          <G2Text text={display} />
        </div>

        <button className={`tap-main ${tap.tone} ${pressed === 'click' ? 'down' : ''}`} onClick={onTapMain} disabled={tap.tone === 'idle'}>
          <span>{tap.label}</span><kbd>Enter</kbd>
        </button>
        <div className="tap-row">
          <button className={`ctl ${pressed === 'double_click' ? 'down' : ''}`} onClick={() => send('double_click')}>Double-tap · {dbl}<kbd>Esc</kbd></button>
          <button className={`ctl ${pressed === 'up' ? 'down' : ''}`} onClick={() => send('up')} disabled={!swipable} title={swipable ? '' : 'Swipe moves between cards when there are two or more'} aria-label="Swipe up">Swipe ↑</button>
          <button className={`ctl ${pressed === 'down' ? 'down' : ''}`} onClick={() => send('down')} disabled={!swipable} title={swipable ? '' : 'Swipe moves between cards when there are two or more'} aria-label="Swipe down">Swipe ↓</button>
        </div>

        <div className="mic-row">
          <MicIcon />
          <div className="mic-text">
            <b>Microphone</b>
            <span className="t-small">
              {micErr ?? (mic
                ? glassesMic ? 'Say “half size”, “set stop …”, “place it”, “skip” or “cancel”.' : 'Listening only while a card is on the glasses.'
                : 'Optional. Audio goes only to speech-to-text and is never stored.')}
            </span>
          </div>
          {mic && <div className="meter" aria-hidden><span style={{ width: `${Math.round(level * 100)}%` }} /></div>}
          <button role="switch" aria-checked={!!mic} aria-label="Microphone" className={`switch ${mic ? 'on' : ''}`} onClick={() => void toggleMic()}><i /></button>
        </div>

        <details className="legend" onToggle={revealOnOpen}>
          <summary>What the words on the glasses mean</summary>
          <dl>
            <dt>allowlisted</dt><dd>The sender is on the list of callers you follow. Anyone else is ignored.</dd>
            <dt>SL · TP</dt><dd>Stop-loss and take-profit (target): the prices where the trade closes at a loss or a gain.</dd>
            <dt>R:R</dt><dd>Reward to risk: how far the target is compared with how far the stop is.</dd>
            <dt>x% from call</dt><dd>How far the live Bybit price is from the call’s entry price.</dd>
            <dt>Seen · TP · SL</dt><dd>This caller’s earlier calls and how they ended. Synthetic demo data.</dd>
            <dt>reduce-only</dt><dd>A close order that can only shrink your position, never open a new one.</dd>
          </dl>
        </details>

        {/* The real glasses app. Visually hidden; it draws through the display above. */}
        <iframe ref={frameRef} src={src} title="Callout glasses app" className="glasses-frame" allow="microphone" />
      </div>

      {/* right · the session */}
      <div className="session card">
        <div className="session-head">
          <h2>Your session</h2>
          <Progress step={journeyStep(card)} />
        </div>

        {bubble && <div className="only-desktop"><Bubble msg={bubble} /></div>}

        <Checks card={quiet ? undefined : card} quiet={quiet ? lastMsg : null} countdownLeft={countdownLeft} settings={settings} />

        <div className="next">
          <div className="label">Next step</div>
          <p>{quiet && card ? `Callout stayed quiet on that message. The glasses still show the earlier card: ${tapLabel(card, countdownLeft).label.toLowerCase()}.` : nextStep(card, quiet, !!lastMsg || !!card)}</p>
        </div>

        <SampleButtons onSample={sample} push={push} started={!!lastMsg || !!card} />

        <div className="rows">
          <TelegramRow push={push} />
          <details className="row" onToggle={revealOnOpen}>
            <summary>
              <ActivityIcon />
              <span className="row-title">Activity</span>
              <span className="row-preview">{log[0]?.text ?? 'Nothing yet'}</span>
            </summary>
            <div className="log">
              <AnimatePresence initial={false}>
                {log.length === 0 && <div className="t-small">Nothing yet. Send a sample call.</div>}
                {log.map(l => (
                  <motion.div key={l.at + l.text} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }} className={`log-line ${l.tone ?? ''}`}>
                    <span className="t-mono">{new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
                    <span>{l.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </details>
          <details className="row" onToggle={revealOnOpen}>
            <summary>
              <InfoIcon />
              <span className="row-title">Session details</span>
            </summary>
            <SessionDetails s={settings} simCmd={simCmd} />
          </details>
        </div>
      </div>
    </section>
  )
}

// ── the 3-step journey shown at the top of the session panel ──
function journeyStep(c: CardLite | undefined): 1 | 2 | 3 {
  if (!c) return 1
  if (c.state === 'filled' && c.order?.kind !== 'close') return 3
  if (['ready', 'holding', 'countdown', 'placing', 'blocked', 'unsure'].includes(c.state)) return 2
  return 1
}
function Progress({ step }: { step: 1 | 2 | 3 }) {
  const names = ['Send a call', 'Review & tap', 'See the order ID']
  return (
    <ol className="progress" aria-label="Steps">
      {names.map((n, i) => (
        <li key={n} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
          <span className="progress-n">{i + 1}</span><span className="progress-t">{n}</span>
        </li>
      ))}
    </ol>
  )
}

// ── what the big button, the checks box and "next step" say ──────────────────────────────────────
function tapLabel(c: CardLite | undefined, left: number): { label: string; tone: 'go' | 'stop' | 'plain' | 'idle' } {
  if (!c) return { label: 'Nothing on the glasses yet', tone: 'idle' }
  switch (c.state) {
    case 'ready': return { label: `Tap to place $${c.sizeUsd} demo order`, tone: 'go' }
    case 'holding': return { label: 'Tap to close the demo position', tone: 'go' }
    case 'blocked': case 'unsure': return { label: 'Tap to skip this call', tone: 'plain' }
    case 'countdown': return { label: `Tap to cancel · ${left} s`, tone: 'stop' }
    case 'placing': return { label: 'Placing on Bybit Demo…', tone: 'idle' }
    default: return { label: 'Tap to clear', tone: 'plain' }
  }
}
function doubleTapLabel(c: CardLite | undefined): string {
  if (!c) return 'exit'
  if (c.state === 'countdown') return 'cancel'
  if (['ready', 'holding', 'blocked', 'unsure'].includes(c.state)) return c.state === 'holding' ? 'keep' : 'skip'
  return 'clear'
}
function nextStep(c: CardLite | undefined, quiet: boolean, started: boolean): string {
  if (!c) {
    if (quiet) return 'Callout stayed quiet: not every message is a call. Send another one.'
    return started ? 'Send another call.' : 'Send a sample call. It arrives like a Telegram message and shows up on the glasses.'
  }
  switch (c.state) {
    case 'ready': return 'Review the call, then tap to place it. Or say “half size” first.'
    case 'holding': return 'Tap to close your demo position, or double-tap to keep it.'
    case 'blocked': return 'There is nothing to place on this one. Tap to skip it, then try another.'
    case 'unsure': return 'Callout could not read this as a clear call, so it offers no trade. Tap to skip it.'
    case 'countdown': return 'Changed your mind? Tap now to cancel. Nothing has been sent yet.'
    case 'placing': return 'Sending the order to Bybit Demo…'
    case 'filled': return c.order?.kind === 'close'
      ? 'Position closed. Tap to clear, then try one of the tricky calls.'
      : 'Done: the order ID matches Bybit. Tap to clear. Then press “Take profit” within 2 minutes to close it yourself, or let it close automatically.'
    case 'failed': return 'The order did not go through. Tap to clear and try again.'
    case 'cancelled': return 'Cancelled. Nothing was sent to Bybit. Tap to clear.'
    default: return 'Tap to clear.'
  }
}

const FLAG_TEXT: Record<string, string> = {
  'contains link': 'The message contains a link',
  'asks for DM': 'It asks you to message the sender privately',
  'asks to send funds': 'It asks you to send funds',
  'contains wallet address': 'It contains a wallet address',
  'pump wording': 'It uses pump wording',
  'coin not on list': 'The coin is not on your list',
  'no entry price': 'There is no entry price',
  'no stop-loss': 'There is no stop-loss',
  'no target': 'There is no target',
  'values not found in message': 'The numbers could not be found in the message itself',
  'live price unavailable': 'The live Bybit price could not be read',
  'price already past stop': 'The price is already past the stop',
  'price already past target': 'The price is already past the target',
}
function flagText(f: string): string {
  const m = f.match(/^price ([\d.]+)% from call$/)
  if (m) return `The live price is ${m[1]}% away from the entry`
  return FLAG_TEXT[f] ?? f.charAt(0).toUpperCase() + f.slice(1)
}
const QUIET: Record<string, string> = {
  noise: 'This message is not a trade call',
  'sender not allowlisted': 'The sender is not on your caller list (a look-alike name counts as a different sender)',
  'holding update, no matching position': 'It is about closing a position, and you have no open demo position on that coin',
  'empty or command': 'The message is empty or a bot command',
  'chat not allowlisted': 'The message came from a group you do not follow',
}
function quietReason(r?: string): string {
  if (!r) return 'This message is not a trade call from a caller you follow'
  return QUIET[r] ?? r.charAt(0).toUpperCase() + r.slice(1)
}
/** When a row opens, scroll it into view (the session panel scrolls on its own on short screens). */
function revealOnOpen(e: SyntheticEvent<HTMLDetailsElement>) {
  const d = e.currentTarget
  if (d.open) requestAnimationFrame(() => d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}
const coinOf = (c: CardLite) => (c.symbol ?? '').replace(/USDT$/, '')
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '–' : String(v))

function Checks({ card: c, quiet, countdownLeft, settings }: { card?: CardLite; quiet: LastMessage | null; countdownLeft: number; settings: JudgeSettings | null }) {
  let title = ''
  let tone: 'neutral' | 'amber' | 'green' = 'neutral'
  let lines: string[] = []
  if (!c) {
    if (!quiet) return null
    title = 'Callout stayed quiet'
    lines = [quietReason(quiet.reason), 'No card, no alert, nothing to trade.']
  } else if (c.state === 'ready') {
    title = 'What Callout checked'
    lines = [
      `Read from the message: ${(c.side ?? '').toUpperCase()} ${coinOf(c)} · entry ${fmt(c.entry)} · stop ${fmt(c.stop)} · target ${fmt(c.targets?.[0])}`,
      `${c.sender ?? 'The sender'} is on your caller list`,
      c.livePrice ? `Live Bybit price ${c.livePrice} · ${Math.abs(c.distancePct ?? 0).toFixed(1)}% from the entry` : 'Live Bybit price read',
      c.record?.seen ? `Caller record: ${c.record.seen} calls seen · ${c.record.tp} reached target · ${c.record.sl} hit stop (synthetic)` : 'Caller record: no earlier calls from this sender',
      `If placed: $${c.sizeUsd} on Bybit Demo, with the stop and target attached`,
    ]
  } else if (c.state === 'blocked') {
    title = 'Blocked: nothing to place'
    tone = 'amber'
    lines = c.flags.length ? c.flags.map(flagText) : ['A check did not pass']
  } else if (c.state === 'unsure') {
    title = 'Not a clear call'
    tone = 'amber'
    lines = c.flags.length ? c.flags.map(flagText) : ['The message could not be read as one clear trade']
  } else if (c.state === 'holding') {
    title = 'Update on your open position'
    lines = [`${c.sender ?? 'The caller'} is taking profit on ${coinOf(c)}`, 'Close sends a reduce-only order: it can only shrink your demo position, never open a new one']
  } else if (c.state === 'countdown') {
    title = `Placing in ${countdownLeft} s`
    lines = ['Nothing has been sent yet', 'The price and your rules are checked again right before sending']
  } else if (c.state === 'placing') {
    title = 'Sending to Bybit Demo'
    lines = ['The order goes to Bybit’s paper-trading environment']
  } else if (c.state === 'filled' && c.order) {
    const pos = settings?.judgePosition
    title = c.order.kind === 'close' ? 'Position closed on Bybit Demo' : 'Filled on Bybit Demo'
    tone = 'green'
    lines = [
      `${c.order.qty} ${coinOf(c)} at ${c.order.avgPrice ?? '–'}`,
      `Order ID …${c.order.orderId.slice(-8)}: the same 8 characters show on the glasses and in Bybit`,
      ...(c.order.kind !== 'close' && pos?.mine ? [`Closes automatically in about ${pos.closesInSec} s (reduce-only)`] : []),
    ]
  } else if (c.state === 'failed') {
    title = 'The order did not go through'
    tone = 'amber'
    lines = [c.error ?? 'Bybit Demo refused the order']
  } else if (c.state === 'cancelled') {
    title = 'Cancelled'
    lines = ['Nothing was sent to Bybit']
  } else return null
  if (c?.notice) lines = [...lines, c.notice]
  return (
    <div className={`checks ${tone}`}>
      <div className="checks-title"><span className="checks-dot" />{title}</div>
      <ul>{lines.map(l => <li key={l}>{l}</li>)}</ul>
      {c?.state === 'ready' && <p className="checks-foot">Nothing blocked this call. Placing it is your decision.</p>}
    </div>
  )
}

function Bubble({ msg }: { msg: LastMessage }) {
  return (
    <div className="bubble">
      <TelegramIcon size={34} />
      <div className="bubble-body">
        <div className="bubble-top">
          <b>{msg.sender || 'Telegram'}</b>
          <span className="t-mono">{new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        </div>
        <p>{msg.text}</p>
      </div>
    </div>
  )
}

function SampleButtons({ onSample, push, started }: { onSample: (k: SampleKind) => Promise<void>; push: (t: string, tone?: LogLine['tone']) => void; started: boolean }) {
  const [busy, setBusy] = useState<SampleKind | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [pointed, setPointed] = useState<SampleKind | null>(null)
  const about = TRICKY.find(t => t.kind === pointed)
  async function go(kind: SampleKind) {
    if (kind !== 'clean') setPointed(kind)
    setBusy(kind)
    setHint(null)
    try {
      await onSample(kind)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setHint(m)
      push(e instanceof LimitError ? `Limit: ${m}` : `Could not send: ${m}`, 'amber')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="samples">
      <button className={`btn-send ${busy === 'clean' ? 'busy' : ''}`} onClick={() => void go('clean')} disabled={!!busy}>
        <RefreshIcon /> {busy === 'clean' ? 'Sending…' : started ? 'Send another sample call' : 'Send a sample call'}
      </button>
      <div className="tricky">
        <span className="t-small">Try a tricky one:</span>
        {TRICKY.map(s => (
          <button
            key={s.kind}
            className={`chip ${busy === s.kind ? 'busy' : ''} ${pointed === s.kind ? 'on' : ''}`}
            onMouseEnter={() => setPointed(s.kind)}
            onFocus={() => setPointed(s.kind)}
            onClick={() => void go(s.kind)}
            disabled={!!busy}
          >{s.title}</button>
        ))}
      </div>
      <p className="tricky-about t-small">
        {about ? <><b>{about.title}:</b> {about.expect}</> : 'Each one shows a different way Callout says no. Point at one to see what it does.'}
      </p>
      {hint && <p className="t-small" style={{ color: 'var(--red)' }}>{hint}</p>}
    </div>
  )
}

function SessionDetails({ s, simCmd }: { s: JudgeSettings | null; simCmd: string }) {
  if (!s) return <div className="t-small">Loading…</div>
  const l = (s.limits ?? {}) as Record<string, number>
  const sharedLow = (typeof l.parse === 'number' && l.parse < 150) || (typeof l.stt === 'number' && l.stt < 60)
  return (
    <div className="details">
      <dl className="details-grid">
        <dt>Per order</dt><dd>${s.sizeUsd ?? '–'} (demo money)</dd>
        <dt>Orders used today</dt><dd>{s.tradesToday ?? 0} of {s.rules?.maxTradesPerDay || '–'}</dd>
        <dt>Telegram</dt><dd>{s.telegram?.linked ? `connected as ${s.telegram.name ?? 'you'}` : 'not connected'}</dd>
        {typeof l.samplesThisHour === 'number' && <><dt>Sample calls left</dt><dd>{l.samplesThisHour} this hour</dd></>}
        {typeof l.voiceThisHour === 'number' && <><dt>Voice commands left</dt><dd>{l.voiceThisHour} this hour</dd></>}
      </dl>
      {sharedLow && <p className="t-small" style={{ color: '#8a5d07' }}>The shared daily limit for all visitors is almost used up. Taps keep working.</p>}
      <p className="t-small">Open demo orders close automatically after 2 minutes.</p>
      <div className="label" style={{ marginTop: 6 }}>Run it in the official Even Hub simulator</div>
      <p className="t-small">The same app and your same session, in Even Realities’ desktop simulator. Needs Node.js.</p>
      <CopyBox text={simCmd} />
    </div>
  )
}

// ── Telegram ─────────────────────────────────────────────────────────────────────────────────────
function TelegramRow({ push }: { push: (t: string, tone?: LogLine['tone']) => void }) {
  const [pair, setPair] = useState<PairStart | null>(null)
  const [status, setStatus] = useState<PairStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const linked = status?.linked ? (status.telegram ?? 'your Telegram account') : null
  const invite = pair?.group?.inviteUrl ?? status?.group?.inviteUrl
  const groupName = pair?.group?.title || status?.group?.title || 'the Callout group'

  useEffect(() => {
    pairStatus().then(setStatus).catch(() => {})
    const t = setInterval(() => pairStatus().then(setStatus).catch(() => {}), 20_000) // keeps the example price current
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!pair || linked) return
    const t = setInterval(async () => {
      try {
        const s = await pairStatus()
        setStatus(s)
        if (s.linked) push(`Connected to ${s.telegram ?? 'Telegram'}. Calls you post in the group now show up on your glasses.`, 'green')
      } catch {}
    }, 3000)
    return () => clearInterval(t)
  }, [pair, linked, push])

  async function start() {
    setErr(null)
    try { setPair(await startPair()) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  const stage = linked ? 3 : pair ? 2 : 1
  return (
    <details className={`row row-tg ${linked ? 'linked' : ''}`} onToggle={revealOnOpen}>
      <summary>
        <TelegramIcon size={20} />
        <span className="row-title">{linked ? `Telegram connected as ${linked}` : 'Connect your Telegram'}</span>
        <span className="row-preview">{linked ? 'Post a call in the group' : 'Send a real call from your phone'}</span>
      </summary>
      <p className="t-small" style={{ marginBottom: 8 }}>Post a trade call in our Telegram group and it shows up on these glasses, like a real call would.</p>
      <ol className="tg-steps">
        <li className={stage > 1 ? 'done' : 'now'}>
          <span className="tg-n">1</span>
          <div className="tg-body">
            <b>Join the group</b>
            {invite
              ? <a className="btn btn-tg btn-sm" href={invite} target="_blank" rel="noreferrer"><TelegramIcon size={16} /> Open {groupName}</a>
              : <span className="t-small">{groupName}</span>}
          </div>
        </li>
        <li className={stage > 2 ? 'done' : stage === 2 ? 'now' : ''}>
          <span className="tg-n">2</span>
          <div className="tg-body">
            <b>Send your code there</b>
            {linked ? (
              <span className="tg-ok"><span className="dot" /> Connected</span>
            ) : pair ? (
              <>
                <span className="t-small waiting"><span className="spinner" /> Waiting for it…</span>
                <CopyBox text={pair.command ?? `/pair ${pair.code}`} big />
              </>
            ) : (
              <button className="btn btn-solid btn-sm" onClick={() => void start()}>Get my code</button>
            )}
          </div>
        </li>
        <li className={stage === 3 ? 'now' : ''}>
          <span className="tg-n">3</span>
          <div className="tg-body">
            <b>Post a trade call</b>
            {status?.example
              ? <CopyBox text={status.example} wrap />
              : <span className="t-small">For example “LONG ETH entry … SL … TP …” near the live price.</span>}
          </div>
        </li>
      </ol>
      {err && <p className="t-small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</p>}
    </details>
  )
}

// ── icons (drawn here; no icon library) ──────────────────────────────────────────────────────────
function TelegramIcon({ size = 22 }: { size?: number }) {
  return (
    <svg className="tg-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#2AABEE" />
      <path fill="#fff" d="M5.4 11.7 17.6 7c.57-.2 1.06.14.88.98l-2.08 9.8c-.15.7-.57.87-1.16.54l-3.2-2.36-1.54 1.49c-.17.17-.31.31-.64.31l.23-3.26 5.93-5.36c.26-.23-.06-.36-.4-.13l-7.33 4.62-3.16-.99c-.69-.21-.7-.69.14-1.02Z" />
    </svg>
  )
}
const Svg = ({ children }: { children: ReactNode }) => (
  <svg className="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
)
const MicIcon = () => <Svg><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>
const ActivityIcon = () => <Svg><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>
const InfoIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></Svg>
const RefreshIcon = () => <Svg><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" /></Svg>

function diff(a: StateLite | null, b: StateLite, push: (t: string, tone?: LogLine['tone']) => void) {
  if (!a) return
  if (b.session.muted > a.session.muted) push(`Stayed quiet on ${b.session.muted - a.session.muted} message${b.session.muted - a.session.muted > 1 ? 's' : ''} (not a call, or not from a caller you follow)`)
  const before = new Map(a.cards.map(c => [c.id, c]))
  for (const c of b.cards) {
    const p = before.get(c.id)
    const label = cardLabel(c)
    if (!p) push(`New card · ${label} · ${c.state}${c.flags.length ? ` (${c.flags.join(' · ')})` : ''}`, c.state === 'blocked' ? 'amber' : undefined)
    else if (p.state !== c.state) {
      if (c.state === 'filled' && c.order) push(`${c.order.kind === 'close' ? 'Closed' : 'Filled'} on Bybit Demo · ${c.order.qty} @ ${c.order.avgPrice} · order …${c.order.orderId.slice(-8)}`, 'green')
      else push(`${label} · ${p.state} → ${c.state}`)
    }
    if (c.voice && (!p?.voice || p.voice.at !== c.voice.at)) push(`Heard “${c.voice.heard || '…'}” → ${c.voice.message}`)
    if (c.notice && c.notice !== p?.notice) push(c.notice, 'amber')
  }
}

function G2Text({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 576))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="g2text" ref={box}>
      <pre style={{ transform: `scale(${scale})` }}>{text}</pre>
    </div>
  )
}


function CopyBox({ text, big, wrap }: { text: string; big?: boolean; wrap?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={`copybox ${big ? 'big' : ''} ${wrap ? 'wrap' : ''}`}>
      <code>{text}</code>
      <button className="btn btn-outline btn-sm" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400) }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}


function cardLabel(c: CardLite) {
  return c.symbol ? `${(c.side ?? '').toUpperCase()} ${c.symbol}` : 'message'
}

/** Shown only if the backend hasn't answered within ~1 s, so nobody thinks the page is stuck. */
function WakeUp({ seconds }: { seconds: number }) {
  const slow = seconds >= 15
  const pct = Math.min(96, (seconds / 15) * 100)
  return (
    <motion.section
      className="wrap inner"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.4, ease: EASE }}
    >
      <div className="wake">
        <div className="wake-screen">
          <pre>{`CALLOUT · connecting to the server${'.'.repeat((seconds % 3) + 1)}\n\n${slow ? 'Taking longer than usual.\nCheck your connection, or reload the page.' : 'This usually takes a few seconds.'}\n${seconds} s so far`}</pre>
          <div className="wake-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
        <p className="t-small wake-note">
          The page continues by itself once the server answers. Nothing to click.
        </p>
      </div>
    </motion.section>
  )
}
