import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Footer, GITHUB, Nav, SplitHeading, Eyebrow, VIDEO } from '../components/ui'
import { Lift, PageEnter, Reveal, EASE } from '../components/motion'
import { G2Frames, type FrameName } from '../components/G2Frames'

export function Landing() {
  return (
    <div className="page">
      <Nav />
      <PageEnter>
        <Hero />
        <Stats />
        <Problem />
        <How />
        <Proof />
        <Voice />
        <Safety />
        <Record />
        <Judges />
        <Faq />
        <Closing />
      </PageEnter>
      <Footer />
    </div>
  )
}

/* ── hero ─────────────────────────────────────────────────────────────── */
/* What Callout is built with, shown twice (each mark is the service's own logo; sources and changes in
   public/brand/partners/SOURCES.md):
   1. under the hero buttons: a small static row, each item linking to the section that shows how Callout uses it;
   2. under the hero window: a caption and a slow logo ticker. */
const BUILT_WITH: { id: string; name: string; icon: string; href: string; wordmark?: string; wordmarkH?: number }[] = [
  { id: 'even', name: 'Even Realities G2', icon: '/brand/partners/even-realities-icon.svg', href: '#how', wordmark: '/brand/partners/even-realities.svg', wordmarkH: 15 },
  { id: 'telegram', name: 'Telegram', icon: '/brand/partners/telegram.svg', href: '#how' },
  { id: 'bybit', name: 'Bybit', icon: '', href: '#proof', wordmark: '/brand/partners/bybit.png', wordmarkH: 20 },
  { id: 'claude', name: 'Claude', icon: '/brand/partners/claude.svg', href: '#safety' },
  { id: 'elevenlabs', name: 'ElevenLabs', icon: '/brand/partners/elevenlabs.svg', href: '#voice' },
]

function BuiltWithRow() {
  return (
    <nav className="built-row" aria-label="Built with">
      <span className="built-row-label">Built with</span>
      <ul>
        {BUILT_WITH.map(b => (
          <li key={b.id}>
            <a href={b.href} className="built-row-item" title={`${b.name}: how Callout uses it`}>
              {b.icon
                ? <><img src={b.icon} alt="" className="built-row-logo" /><span>{b.name}</span></>
                : <img src={b.wordmark} alt={b.name} className="built-row-wordmark" />}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

const TICKER_SPEED = 40 // px per second, leftwards
const TICKER_HOVER = 0.4 // runs at 40% while hovered

function LogoTicker() {
  const track = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let x = 0
    let last = performance.now()
    let raf = 0
    const step = (t: number) => {
      const dt = Math.min(t - last, 100)
      last = t
      const el = track.current, set = first.current
      if (el && set) {
        const loop = set.offsetWidth + parseFloat(getComputedStyle(el).columnGap || '0')
        x -= (TICKER_SPEED * (hovered.current ? TICKER_HOVER : 1) * dt) / 1000
        if (loop > 0 && x <= -loop) x += loop
        el.style.transform = `translateX(${x}px)`
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])
  const set = (copy: number) => (
    <div className="mark-set" ref={copy === 0 ? first : undefined} aria-hidden={copy > 0 || undefined}>
      {BUILT_WITH.map(b => (
        <div key={b.id} className="mark">
          {b.wordmark
            ? <img src={b.wordmark} alt={copy > 0 ? '' : b.name} style={{ height: b.wordmarkH }} />
            : <><img src={b.icon} alt="" style={{ height: 20 }} /><span className="mark-name">{b.name}</span></>}
        </div>
      ))}
    </div>
  )
  return (
    <div className="logo-row">
      <p className="logo-row-caption">Built with Even Realities G2, Telegram, Bybit, Claude and ElevenLabs</p>
      <div className="marks" onMouseEnter={() => (hovered.current = true)} onMouseLeave={() => (hovered.current = false)}>
        <div className="mark-track" ref={track}>{set(0)}{set(1)}</div>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="hero">
      <div className="wrap inner hero-copy">
        <Reveal>
          <span className="pill pill-er">
            <span className="ink-2">Built for</span>
            <img src="/brand/partners/even-realities.svg" alt="Even Realities" className="er-mark" />
            <b>G2</b>
            <span className="ink-2">· Heads Up hackathon</span>
          </span>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="t-display hero-title">Checks the call<br />before you take it.</h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="t-lead hero-sub">
            Telegram trade calls, checked in code against the live Bybit price, the caller’s record and your own rules,
            then placed on Bybit Demo with one tap from Even Realities G2 glasses.
          </p>
        </Reveal>
        <Reveal delay={0.15} className="hero-ctas">
          <a className="btn btn-outline" href={VIDEO} target="_blank" rel="noreferrer"><PlayIcon /> Watch the demo · 2:08</a>
          <a className="btn btn-solid" href="/try/">Try it in your browser <Arrow /></a>
        </Reveal>
        <Reveal delay={0.2}>
          <BuiltWithRow />
        </Reveal>
      </div>
      <div className="wrap inner">
        <Lift y={56} scale={0.96}>
          <div className="sky hero-sky">
            <div className="hero-window">
              <div className="window-bar"><i /><i /><i /><span className="t-mono">Callout · G2 display</span></div>
              <G2Frames frames={['home', 'card', 'voice', 'countdown', 'filled', 'scam', 'rule', 'holding', 'closing']} />
            </div>
            <div className="hero-float hero-float-a card">
              <div className="t-mono ink-2" style={{ fontSize: 11.5 }}>TELEGRAM · ADMIN</div>
              <div style={{ fontWeight: 600, marginTop: 6 }}>LONG BTC entry 60.6k SL 59.4k TP 63k</div>
            </div>
            <div className="hero-float hero-float-b card">
              <div className="t-mono ink-2" style={{ fontSize: 11.5 }}>BYBIT DEMO · ORDER</div>
              <div style={{ fontWeight: 600, marginTop: 6 }}>Open Long · Filled · <span className="tag amber">5b8cf401</span></div>
            </div>
          </div>
        </Lift>
        <p className="t-small hero-note">Every screen above is a real capture from the Even Hub simulator, from one live run.</p>
        <LogoTicker />
      </div>
    </section>
  )
}

/* ── stats ────────────────────────────────────────────────────────────── */
const STATS = [
  { big: '0', label: 'unsafe one-tap cards', sub: '269 labeled Telegram messages', href: '#safety' },
  { big: '0', label: 'risky voice misfires', sub: '180 utterances, 6 accents', href: '#voice' },
  { big: '~0.5 s', label: 'speech-to-text', sub: 'median 468 ms, warm connection', href: '#voice' },
  { big: '±3%', label: 'entry vs live Bybit price', sub: 'checked at the card, the tap and the send', href: '#how' },
]
function Stats() {
  return (
    <section className="section tight">
      <div className="wrap inner stats">
        {STATS.map((s, i) => (
          <Reveal key={s.label} delay={i * 0.05} className="stat">
            <a href={s.href}>
              <div className="stat-big">{s.big}</div>
              <div className="stat-label">{s.label}</div>
              <div className="t-small">{s.sub}</div>
            </a>
          </Reveal>
        ))}
      </div>
      <p className="wrap inner t-small" style={{ marginTop: 18 }}>Measured on synthetic test sets written by the team: a smoke test, not a benchmark.</p>
    </section>
  )
}

/* ── problem ──────────────────────────────────────────────────────────── */
function Problem() {
  const qs = [
    ['Has the price already moved?', 'The entry is compared with the live Bybit price. More than 3% away and there is no trade button.'],
    ['Is this caller any good?', 'Every card shows what happened after each call Callout saw, on real market prices.'],
    ['Does it break my own rules?', 'Trades per day, daily loss and a pause after losses in a row, checked before every order.'],
  ]
  return (
    <section className="section">
      <div className="wrap inner">
        <Reveal><Eyebrow>The problem</Eyebrow></Reveal>
        <Reveal><SplitHeading first="Hundreds of messages a day. A few are real calls." second="Some are scams, and a call gives you seconds to decide." /></Reveal>
        <div className="grid3" style={{ marginTop: 56 }}>
          {qs.map(([q, a], i) => (
            <Reveal key={q} delay={i * 0.06} className="qcard">
              <div className="t-h3">{q}</div>
              <p className="t-body" style={{ marginTop: 10 }}>{a}</p>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <div className="session-note">
            <span className="tag green">Session mode</span>
            <span className="t-body">Away from the screen, not away from the session. Callout runs while the app is open; G2 can’t show anything when it’s closed, so there are no background alerts.</span>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

/* ── how it works: sticky steps ───────────────────────────────────────── */
const STEPS: { n: string; title: string; body: string; frame: FrameName }[] = [
  { n: '01', title: 'Gate', body: 'Only the groups you pick, and only senders on your allowlist. Anyone else, including someone posing as the admin, is muted.', frame: 'home' },
  { n: '02', title: 'Parse', body: 'Claude reads the message into strict JSON: coin, side, entry, stop, targets. It never advises and never sets the size.', frame: 'card' },
  { n: '03', title: 'Check', body: 'Code decides: coin on your list, stop on the right side, every price written in the message, entry within ±3% of the live Bybit price, your own limits.', frame: 'card' },
  { n: '04', title: 'Card', body: 'One glance: entry, stop, target, R:R, distance from the live price and the caller’s record. Neutral wording, no opinions.', frame: 'card' },
  { n: '05', title: 'Voice', body: '“Half size, set stop 59.7k.” Every check runs again on your numbers. Voice can change the card; only a tap places the order.', frame: 'voice' },
  { n: '06', title: 'Tap', body: 'The price is re-checked at the tap, you get five seconds to cancel, it is re-checked again, then a Bybit Demo order goes out at 1x with the caller’s stop and target attached.', frame: 'countdown' },
  { n: '07', title: 'Proof', body: 'The fill and the real order ID on the glasses, the same ID in Bybit’s order history, and a receipt in the Telegram thread.', frame: 'filled' },
]
function How() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    const obs = new IntersectionObserver(
      entries => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i))
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    refs.current.forEach(r => r && obs.observe(r))
    return () => obs.disconnect()
  }, [])
  const reduce = useReducedMotion()
  return (
    <section className="section" id="how">
      <div className="wrap inner">
        <Reveal><Eyebrow>How Callout works</Eyebrow></Reveal>
        <Reveal><SplitHeading first="From a Telegram message to a real order." second="The AI reads the call. Code decides. You tap." /></Reveal>
      </div>
      <div className="wrap inner how">
        <div className="how-steps">
          {STEPS.map((s, i) => (
            <div key={s.n} ref={el => { refs.current[i] = el }} data-i={i} className={`how-step ${i === active ? 'on' : ''}`}>
              <div className="how-n t-mono">{s.n}</div>
              <div>
                <div className="t-h3">{s.title}</div>
                <p className="t-body" style={{ marginTop: 8 }}>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="how-visual">
          <div className="how-sticky">
            <div className="sky how-sky">
              <div className="how-index">
                {STEPS.map((s, i) => <span key={s.n} className={i === active ? 'on' : ''}>{s.title}</span>)}
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={STEPS[active]!.frame + active}
                  initial={reduce ? false : { opacity: 0, y: 14, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.35, ease: EASE }}
                  className="how-window"
                >
                  <G2Frames frame={STEPS[active]!.frame} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ── proof ────────────────────────────────────────────────────────────── */
function Proof() {
  return (
    <section className="section" id="proof">
      <div className="wrap inner">
        <Reveal><Eyebrow>Proof</Eyebrow></Reveal>
        <Reveal><SplitHeading first="One real order, three places." second="Screenshots don’t count; order IDs do." /></Reveal>
        <Reveal>
          <p className="t-lead" style={{ marginTop: 18, maxWidth: 760 }}>
            A live call in Telegram, adjusted by voice, confirmed with a tap, filled on Bybit Demo. Bybit shows the last 8
            characters of the order ID; so do the glasses and the receipt.
          </p>
        </Reveal>
        <div className="proof-grid">
          <Reveal className="proof-cell">
            <div className="proof-label t-mono">Callout · G2</div>
            <div className="g2" style={{ padding: 12 }}><div className="g2-screen"><img src="/proof/proof-glasses-order.png" alt="Glasses: FILLED 0.001 BTC, order …5b8cf401" /></div></div>
            <div className="proof-id"><span className="tag amber">…5b8cf401</span></div>
          </Reveal>
          <Reveal delay={0.06} className="proof-cell">
            <div className="proof-label t-mono">Telegram · receipt</div>
            <div className="card proof-img"><img src="/proof/proof-telegram-receipt.png" alt="Telegram receipt: Buy 0.001 @ 60,584.1, order …5b8cf401" /></div>
            <div className="proof-id"><span className="tag amber">…5b8cf401</span></div>
          </Reveal>
          <Reveal delay={0.12} className="proof-cell proof-wide">
            <div className="proof-label t-mono">Bybit Demo · Order History</div>
            <div className="card proof-img"><img src="/proof/proof-bybit-order.png" alt="Bybit Demo order history: Open Long, 0.001 BTC, order ID 5b8cf401, Filled" /></div>
            <div className="proof-id"><span className="tag amber">5b8cf401</span> <span className="t-small mono">full ID cef94558-bf1d-42d7-a02a-67955b8cf401</span></div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

/* ── voice ────────────────────────────────────────────────────────────── */
const SAY = [
  ['“half size” · “full size”', 'Size becomes your setting × ½, still under the cap.'],
  ['“set stop 59.2k”', 'Your stop replaces the caller’s and every check runs again.'],
  ['“place it” · “close it”', 'Selects the action. Only a tap confirms.'],
  ['“skip” · “keep it” · “okay”', 'Harmless actions run right away.'],
  ['“cancel” · “stop” · “wait”', 'During the countdown, unclear speech cancels. Negation always wins.'],
]
function Voice() {
  return (
    <section className="section" id="voice">
      <div className="wrap inner voice">
        <div>
          <Reveal><Eyebrow>Voice</Eyebrow></Reveal>
          <Reveal><SplitHeading first="Voice picks. A tap confirms." second="Commands are matched in code, not by an AI." /></Reveal>
          <div className="say-list">
            {SAY.map(([a, b], i) => (
              <Reveal key={a} delay={i * 0.04} className="say">
                <div className="say-a">{a}</div>
                <div className="t-body">{b}</div>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <p className="t-small" style={{ marginTop: 22 }}>
              The mic is on only while a card is shown. Speech detection runs on the glasses, only finished utterances are sent,
              other people’s speech and background conversation are ignored, and audio is never stored.
            </p>
          </Reveal>
        </div>
        <Lift y={30} scale={0.98}>
          <div className="sky voice-sky">
            <div className="quote-card card">
              <div className="t-mono ink-2" style={{ fontSize: 11.5 }}>SPOKEN TO THE GLASSES</div>
              <div className="quote">“Half size. Set stop fifty-nine point seven K.”</div>
            </div>
            <div className="voice-window"><G2Frames frame="voice" caption="live mic · real speech-to-text" /></div>
            <div className="voice-stats">
              <div><b>0</b><span>risky misfires</span></div>
              <div><b>95%</b><span>command accuracy</span></div>
              <div><b>468 ms</b><span>median transcription</span></div>
            </div>
          </div>
        </Lift>
      </div>
    </section>
  )
}

/* ── safety ───────────────────────────────────────────────────────────── */
const SAFETY = [
  ['The AI never sizes a trade', 'It only extracts values. Size comes from your settings, with a cap and a hard maximum in code.'],
  ['Prompt injection goes nowhere', 'Every entry, stop and target must literally appear in the message, so invented numbers are blocked.'],
  ['Impersonation is ignored', 'Allowlist by Telegram user ID. Someone posing as the admin never gets a card.'],
  ['No stale trades', 'Calls expire after 15 minutes. The price is re-checked at the tap and again before sending.'],
  ['No duplicate orders', 'A fixed orderLinkId per card. Bybit rejects a repeat (110072), verified on Demo.'],
  ['A close can’t flip you', 'Closes are reduce-only. Oversized closes flatten; closing while flat is refused (110017).'],
  ['Your own limits', 'Trades per day, daily loss and a loss-streak pause. If they can’t be read, the card is blocked.'],
  ['Keys stay on the server', 'No secrets in the glasses app. Only calls and orders are stored, never chatter or audio.'],
]
function Safety() {
  return (
    <section className="section" id="safety">
      <div className="wrap inner">
        <Reveal><Eyebrow>Safety</Eyebrow></Reveal>
        <Reveal><SplitHeading first="The safety lives in code, not in the AI." second="Callout executes your confirmed decision, never the group’s advice." /></Reveal>
        <div className="grid4" style={{ marginTop: 56 }}>
          {SAFETY.map(([t, b], i) => (
            <Reveal key={t} delay={(i % 4) * 0.05} className="scard">
              <div className="scard-n t-mono">{String(i + 1).padStart(2, '0')}</div>
              <div className="t-h3" style={{ fontSize: 18 }}>{t}</div>
              <p className="t-small" style={{ marginTop: 8 }}>{b}</p>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <div className="blocked-row">
            <div><G2Frames frame="scam" caption="suspicious call" /></div>
            <div><G2Frames frame="rule" caption="your own limit" /></div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

/* ── caller record ────────────────────────────────────────────────────── */
function Record() {
  return (
    <section className="section" id="record">
      <div className="wrap inner record">
        <div>
          <Reveal><Eyebrow>Caller record</Eyebrow></Reveal>
          <Reveal><SplitHeading first="Is this caller actually any good?" second="The group can’t answer that honestly. Callout answers from what it saw." /></Reveal>
          <Reveal>
            <p className="t-body" style={{ marginTop: 18, maxWidth: 520 }}>
              Each call is replayed against Bybit mainnet 1-minute candles: the entry must be touched first, then whichever of stop
              or target came first. Counts and sample size, never a score. Callers can delete losing calls; Callout still counts them.
            </p>
          </Reveal>
        </div>
        <Reveal className="record-card card">
          <div className="t-mono ink-2" style={{ fontSize: 12 }}>ON EVERY CARD</div>
          <div className="record-line">Seen 11 · 3 TP · 6 SL · 2 open</div>
          <span className="tag amber">synthetic: sample calls on real historical Bybit prices</span>
        </Reveal>
      </div>
    </section>
  )
}

/* ── judges ───────────────────────────────────────────────────────────── */
function Judges() {
  return (
    <section className="section" id="judges">
      <div className="wrap inner">
        <Reveal><Eyebrow>For judges</Eyebrow></Reveal>
        <Reveal><SplitHeading first="Try the whole flow yourself." second="Your own sandbox, real Bybit Demo orders, nothing to install." /></Reveal>
        <div className="grid3" style={{ marginTop: 56 }}>
          <Reveal className="jcard card">
            <div className="jn t-mono">01</div>
            <div className="t-h3">Try it in your browser</div>
            <p className="t-small">The real glasses app on a G2 display, with tap, double-tap, swipe, your microphone and sample calls.</p>
            <a className="btn btn-solid btn-sm" href="/try/">Open the preview <Arrow /></a>
          </Reveal>
          <Reveal delay={0.06} className="jcard card">
            <div className="jn t-mono">02</div>
            <div className="t-h3">Run it in the official simulator</div>
            <p className="t-small">The preview gives you a one-line command that opens your sandbox in the Even Hub simulator.</p>
            <code className="jcode">npx @evenrealities/evenhub-simulator "…/glasses/?s=…"</code>
          </Reveal>
          <Reveal delay={0.12} className="jcard card">
            <div className="jn t-mono">03</div>
            <div className="t-h3">Post a real call in Telegram</div>
            <p className="t-small">Join the Callout group, send <code>/pair</code> with your code, and post a call. It lands on your card only, and the receipt replies in the thread.</p>
          </Reveal>
        </div>
        <Reveal><p className="t-small" style={{ marginTop: 22 }}>Demo money only: orders go to Bybit Demo Trading. Each sandbox has small limits, one judge order is open at a time and it is closed automatically. Not financial advice.</p></Reveal>
      </div>
    </section>
  )
}

/* ── faq ──────────────────────────────────────────────────────────────── */
const FAQ = [
  ['Is this real money?', 'No. Orders go to Bybit Demo Trading with demo funds. Prices for the checks come from Bybit mainnet public data.'],
  ['What does the AI do?', 'Claude Haiku 5.5 only extracts values from the message into strict JSON. It never recommends a trade and never sets the size. Everything else is checked in code.'],
  ['What is stored?', 'Calls from allowlisted senders and the orders you place. Not chatter, and never microphone audio. Keys live only on the server.'],
  ['Does it work when the app is closed?', 'No. G2 can’t show anything while the app is in the background, so Callout is built for a trading session you keep open.'],
  ['Has it run on real G2 glasses?', 'Not yet: it was built and recorded in the official Even Hub simulator. The same app is packaged as an .ehpk for the glasses.'],
]
function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section className="section">
      <div className="wrap inner faq">
        <div>
          <Reveal><Eyebrow>Questions</Eyebrow></Reveal>
          <Reveal><SplitHeading first="Straight answers." second="Including the limits." /></Reveal>
        </div>
        <div>
          {FAQ.map(([q, a], i) => (
            <div key={q} className={`faq-item ${open === i ? 'open' : ''}`}>
              <button className="faq-q" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <span>{q}</span><span className="faq-plus">{open === i ? '–' : '+'}</span>
              </button>
              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: EASE }} style={{ overflow: 'hidden' }}>
                    <p className="t-body faq-a">{a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section className="section closing">
      <div className="wrap inner" style={{ textAlign: 'center' }}>
        <Reveal><h2 className="t-h2">Checks the call <span className="ink-2">before you take it.</span></h2></Reveal>
        <Reveal delay={0.08} className="hero-ctas" >
          <a className="btn btn-outline" href={VIDEO} target="_blank" rel="noreferrer"><PlayIcon /> Watch the demo</a>
          <a className="btn btn-solid" href="/try/">Try it in your browser <Arrow /></a>
        </Reveal>
        <Reveal delay={0.12}><p className="t-small" style={{ marginTop: 18 }}><a href={GITHUB} target="_blank" rel="noreferrer">Source on GitHub</a> · Demo money only · Not financial advice</p></Reveal>
      </div>
    </section>
  )
}

function Arrow() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m-3-3 3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function PlayIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 2.8v8.4c0 .5.5.8.9.5l6.4-4.2a.6.6 0 0 0 0-1L4.9 2.3c-.4-.3-.9 0-.9.5Z" fill="currentColor" /></svg>
}
