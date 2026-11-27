import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Footer, Nav, VIDEO } from '../components/ui'
import { PageEnter, EASE } from '../components/motion'
import {
  ensureSandbox, getState, getSettings, LimitError, MOCK, PausedError, onTokenChange, pairStatus, sendSample, startPair, waitForServer,
  type CardLite, type JudgeSettings, type PairStart, type PairStatus, type SampleKind, type StateLite,
} from '../lib/api'
import { startMic, type MicHandle } from '../lib/mic'

type Input = 'click' | 'double_click' | 'up' | 'down'

const SAMPLES: { kind: SampleKind; title: string; expect: string }[] = [
  { kind: 'clean', title: 'Admin call', expect: 'Near live price → placeable' },
  { kind: 'scam', title: 'Scam call', expect: '“100% WIN” + link → blocked' },
  { kind: 'impostor', title: 'Impostor', expect: 'Look-alike name → ignored' },
  { kind: 'vague', title: 'Vague message', expect: '“might long soon” → no card' },
  { kind: 'far', title: 'Stale price', expect: '10% off live price → blocked' },
  { kind: 'holding', title: 'Taking profit', expect: 'Closes your open position' },
  { kind: 'chatter', title: 'Chatter', expect: '“gm everyone” → muted' },
]

interface LogLine { at: number; text: string; tone?: 'amber' | 'green' }

export function Try() {
  const [token, setToken] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [waking, setWaking] = useState<number | null>(null) // seconds spent waking the backend, or null
  useEffect(() => {
    const off = onTokenChange(t => setToken(t))
    // Only show the waking screen if the server hasn't answered within ~1 s (no flash on a warm server).
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
        <section className="wrap inner try-bar">
          <h1 className="try-title"><span className="try-eyebrow">Try Callout</span>The real glasses app, in your browser.</h1>
          <p className="t-small try-sub">
            The same code as the Even Hub simulator build, on the live backend. Your own private sandbox ·{' '}
            <b>Bybit Demo money only</b> · not financial advice.
          </p>
        </section>
        <AnimatePresence>{waking !== null && !token && <WakeUp seconds={waking} />}</AnimatePresence>
        {err && (
          <div className="wrap inner">
            <div className="try-error">
              {err}
              {paused && <> <a href={VIDEO}>Watch the demo video</a>.</>}
            </div>
          </div>
        )}
        {token && <Workbench token={token} />}
      </PageEnter>
      <Footer />
    </div>
  )
}

function Workbench({ token }: { token: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [display, setDisplay] = useState('CALLOUT · connecting...')
  const [glassesMic, setGlassesMic] = useState(false)
  const [mic, setMic] = useState<MicHandle | null>(null)
  const [micErr, setMicErr] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [pressed, setPressed] = useState<Input | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const glassesMicRef = useRef(false)
  glassesMicRef.current = glassesMic

  const push = useCallback((text: string, tone?: LogLine['tone']) => setLog(l => [{ at: Date.now(), text, tone }, ...l].slice(0, 40)), [])

  // Messages from the glasses app (same origin, from our iframe only).
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== frameRef.current?.contentWindow) return
      const d = ev.data as { type?: string; content?: string; on?: boolean }
      if (d?.type === 'callout:display' && typeof d.content === 'string') setDisplay(d.content)
      if (d?.type === 'callout:mic' && typeof d.on === 'boolean') setGlassesMic(d.on)
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
      if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return
      if (e.key === 'Enter') { e.preventDefault(); send('click') }
      else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); send('double_click') }
      else if (e.key === 'ArrowUp') { e.preventDefault(); send('up') }
      else if (e.key === 'ArrowDown') { e.preventDefault(); send('down') }
      else if (e.key.toLowerCase() === 'm') toggleMic()
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

  // Live event log from state diffs.
  const prev = useRef<StateLite | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const s = await getState()
        if (!alive) return
        diff(prev.current, s, push)
        prev.current = s
      } catch {}
    }
    void tick()
    const t = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [push, token])

  const src = MOCK ? '/glasses/?preview=1' : `/glasses/?s=${encodeURIComponent(token)}&preview=1`
  const simCmd = `npx @evenrealities/evenhub-simulator "${location.origin}/glasses/?s=${token}"`

  return (
    <section className="wrap inner workbench">
      {/* 1 · the glasses */}
      <div className="col col-device">
        <div className="device">
          <div className="device-top">
            <span className="t-mono">Even Realities G2 · browser preview</span>
            <span className={`mic-state ${glassesMic ? 'on' : ''}`}><i />{glassesMic ? 'glasses mic listening' : 'glasses mic off'}</span>
          </div>
          <G2Text text={display} />
        </div>

        <div className="controls">
          <div className="pad">
            <button className={`ctl ctl-main ${pressed === 'click' ? 'down' : ''}`} onClick={() => send('click')}>Tap<kbd>Enter</kbd></button>
            <button className={`ctl ${pressed === 'double_click' ? 'down' : ''}`} onClick={() => send('double_click')}>Double-tap<kbd>Esc</kbd></button>
            <button className={`ctl ${pressed === 'up' ? 'down' : ''}`} onClick={() => send('up')} aria-label="Swipe up">Swipe ↑<kbd>↑</kbd></button>
            <button className={`ctl ${pressed === 'down' ? 'down' : ''}`} onClick={() => send('down')} aria-label="Swipe down">Swipe ↓<kbd>↓</kbd></button>
          </div>
          <div className="microw">
            <button className={`btn btn-sm ${mic ? 'btn-green' : 'btn-outline'}`} onClick={toggleMic}>{mic ? 'Microphone on' : 'Turn on microphone'}<kbd>M</kbd></button>
            <div className="meter" aria-hidden><span style={{ width: `${Math.round(level * 100)}%` }} /></div>
          </div>
          <p className="t-small">
            {micErr ?? (mic
              ? glassesMic ? 'Speak to the card: “half size, set stop …”, “place it”, “skip”, “cancel”.' : 'The glasses listen only while a card is on screen. Send a call first.'
              : 'Optional. Audio goes only to speech-to-text and is never stored.')}
          </p>
        </div>

        <div className="quick">
          <div className="quick-h t-mono">Quick start</div>
          <ol>
            <li>Press <b>Admin call</b>. A card appears on the glasses.</li>
            <li>Say <b>“half size”</b> with the mic on, or just press <b>Tap</b>.</li>
            <li>Wait out the 5 s cancel window. The Bybit Demo order ID appears on the glasses.</li>
          </ol>
        </div>

        {/* The real glasses app. Visually hidden; it draws through the display above. */}
        <iframe ref={frameRef} src={src} title="Callout glasses app" className="glasses-frame" allow="microphone" />
      </div>

      {/* 2 · send calls */}
      <div className="col col-calls">
        <Panel step="1" title="Send a test call" note="Same reader and checks as a real Telegram message.">
          <SamplePad push={push} />
        </Panel>
        <PairPanel push={push} />
      </div>

      {/* 3 · what happened */}
      <div className="col col-log">
        <Limits />
        <Panel title="Live log" note="What your sandbox did, newest first." grow>
          <div className="log">
            <AnimatePresence initial={false}>
              {log.length === 0 && <div className="t-small log-empty">Nothing yet. Send a call, then tap.</div>}
              {log.map(l => (
                <motion.div key={l.at + l.text} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }} className={`log-line ${l.tone ?? ''}`}>
                  <span className="t-mono">{new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
                  <span>{l.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </Panel>
        <details className="panel card sim">
          <summary>Run it in the official Even Hub simulator</summary>
          <p className="t-small">The same app and your same sandbox, in Even Realities’ desktop simulator. Needs Node.js.</p>
          <CopyBox text={simCmd} />
        </details>
        <p className="t-small fineprint">One open demo order per judge, closed automatically after 2 minutes. <a className="link" href={VIDEO}>Watch the 2:08 demo</a>.</p>
      </div>
    </section>
  )
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

function Panel({ title, note, step, grow, icon, children }: { title: string; note?: string; step?: string; grow?: boolean; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={`panel card ${grow ? 'grow' : ''}`}>
      <div className="panel-title">{step && <span className="step">{step}</span>}{icon}{title}</div>
      {note && <p className="t-small panel-note">{note}</p>}
      <div className="panel-body">{children}</div>
    </div>
  )
}

function SamplePad({ push }: { push: (t: string, tone?: LogLine['tone']) => void }) {
  const [busy, setBusy] = useState<SampleKind | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  async function go(kind: SampleKind) {
    setBusy(kind)
    setHint(null)
    try {
      const r = await sendSample(kind)
      const said = r.text ? `“${r.text}”${r.sender ? ` from ${r.sender}` : ''}` : `“${SAMPLES.find(s => s.kind === kind)!.title}”`
      if (r.card) push(`Posted ${said} → card ${r.card.state}${r.card.flags?.length ? ` (${r.card.flags.join(' · ')})` : ''}`, r.card.state === 'blocked' ? 'amber' : undefined)
      else push(`Posted ${said} → ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setHint(m)
      push(e instanceof LimitError ? `Limit: ${m}` : `Could not send: ${m}`, 'amber')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      <div className="samples">
        {SAMPLES.map(s => (
          <button key={s.kind} className={`sample ${busy === s.kind ? 'busy' : ''}`} onClick={() => go(s.kind)} disabled={!!busy}>
            <span className="sample-t">{s.title}</span>
            <span className="sample-e">{s.expect}</span>
          </button>
        ))}
      </div>
      {hint && <p className="t-small" style={{ marginTop: 10, color: 'var(--red)' }}>{hint}</p>}
    </div>
  )
}

function TelegramIcon({ size = 22 }: { size?: number }) {
  return (
    <svg className="tg-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#2AABEE" />
      <path fill="#fff" d="M5.4 11.7 17.6 7c.57-.2 1.06.14.88.98l-2.08 9.8c-.15.7-.57.87-1.16.54l-3.2-2.36-1.54 1.49c-.17.17-.31.31-.64.31l.23-3.26 5.93-5.36c.26-.23-.06-.36-.4-.13l-7.33 4.62-3.16-.99c-.69-.21-.7-.69.14-1.02Z" />
    </svg>
  )
}

function PairPanel({ push }: { push: (t: string, tone?: LogLine['tone']) => void }) {
  const [pair, setPair] = useState<PairStart | null>(null)
  const [status, setStatus] = useState<PairStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const linked = status?.linked ? (status.telegram ?? 'your Telegram account') : null
  const invite = pair?.group?.inviteUrl ?? status?.group?.inviteUrl
  const groupName = pair?.group?.title || status?.group?.title || 'the Callout group'

  useEffect(() => {
    pairStatus().then(setStatus).catch(() => {})
  }, [])
  // While a code is waiting, poll until the bot links it.
  useEffect(() => {
    if (!pair || linked) return
    const t = setInterval(async () => {
      try {
        const s = await pairStatus()
        setStatus(s)
        if (s.linked) push(`Linked to ${s.telegram ?? 'Telegram'}. Calls you post in the group now land on your glasses.`, 'green')
      } catch {}
    }, 3000)
    return () => clearInterval(t)
  }, [pair, linked, push])
  // Refresh now and then so the example's coin and price stay current.
  useEffect(() => {
    const t = setInterval(() => pairStatus().then(setStatus).catch(() => {}), 20_000)
    return () => clearInterval(t)
  }, [])

  async function start() {
    setErr(null)
    try { setPair(await startPair()) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const stage = linked ? 3 : pair ? 2 : 1
  return (
    <Panel
      step="2"
      icon={<TelegramIcon />}
      title="Or send one from your own Telegram"
      note="Post a call in our group, see it on these glasses."
    >
      <ol className="tg-steps">
        <li className={stage > 1 ? 'done' : stage === 1 ? 'now' : ''}>
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
              <span className="tg-ok"><span className="dot" /> Connected as {linked}</span>
            ) : pair ? (
              <>
                <span className="t-small waiting"><span className="spinner" /> Waiting for it…</span>
                <CopyBox text={pair.command ?? `/pair ${pair.code}`} big />
              </>
            ) : (
              <button className="btn btn-solid btn-sm" onClick={start}>Get my code</button>
            )}
          </div>
        </li>
        <li className={stage === 3 ? 'now' : ''}>
          <span className="tg-n">3</span>
          <div className="tg-body">
            <b>Post a trade call</b>
            {status?.example
              ? <><CopyBox text={status.example} wrap />{linked && <span className="t-small">Post it in the group. It shows up on the glasses here; tap to place it.</span>}</>
              : <span className="t-small">For example “LONG ETH entry … SL … TP …” near the live price.</span>}
          </div>
        </li>
      </ol>
      {err && <p className="t-small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</p>}
    </Panel>
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

function Limits() {
  const [s, setS] = useState<JudgeSettings | null>(null)
  const [now, setNow] = useState(Date.now())
  const loadedAt = useRef(Date.now())
  useEffect(() => {
    const load = () => getSettings().then(x => { setS(x); loadedAt.current = Date.now() }).catch(() => {})
    load()
    const t = setInterval(load, 5_000)
    const c = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(t); clearInterval(c) }
  }, [])
  if (!s) return null
  const pos = s.judgePosition
  const left = pos ? Math.max(0, Math.round(pos.closesInSec - (now - loadedAt.current) / 1000)) : 0
  const limitTags = Object.entries(s.limits ?? {}).map(([k, v]) => {
    // Backend reports remaining quota per key.
    const LABEL: Record<string, string> = {
      samplesThisHour: 'test calls left this hour', voiceThisHour: 'voice commands left this hour',
      parse: 'message reads left today, all judges', stt: 'voice transcriptions left today, all judges',
    }
    const label = LABEL[k] ?? k.replace(/([A-Z])/g, ' $1').toLowerCase()
    const val = typeof v === 'number' || typeof v === 'string' ? String(v)
      : v && typeof v === 'object' && 'used' in v && 'max' in v ? `${(v as { used: number }).used}/${(v as { max: number }).max}`
      : v && typeof v === 'object' && 'remaining' in v ? `${(v as { remaining: number }).remaining} left` : null
    return val === null ? null : <span key={k} className="tag">{val} {label}</span>
  })
  return (
    <div className="panel card status">
      <div className="panel-title">Your sandbox</div>
      <div className="status-grid">
        {s.sizeUsd !== undefined && <div><b>${s.sizeUsd}</b><span>order size</span></div>}
        {s.tradesToday !== undefined && <div><b>{s.tradesToday}{s.rules?.maxTradesPerDay ? `/${s.rules.maxTradesPerDay}` : ''}</b><span>orders today</span></div>}
        <div><b>{s.telegram?.linked ? (s.telegram.name ?? 'linked') : 'not linked'}</b><span>Telegram</span></div>
      </div>
      {pos && (
        <p className="t-small status-pos">
          <span className="dot" style={{ background: pos.mine ? 'var(--green)' : 'var(--amber)' }} />
          {pos.mine ? `Your demo position closes automatically (reduce-only) in ${left} s.` : `Another judge’s demo order is open; new orders wait about ${left} s.`}
        </p>
      )}
      {limitTags.some(Boolean) && <div className="limits">{limitTags}</div>}
    </div>
  )
}

function diff(a: StateLite | null, b: StateLite, push: (t: string, tone?: LogLine['tone']) => void) {
  if (!a) return
  if (b.session.muted > a.session.muted) push(`Muted ${b.session.muted - a.session.muted} message${b.session.muted - a.session.muted > 1 ? 's' : ''} (not a call, or not from an allowlisted sender)`)
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
