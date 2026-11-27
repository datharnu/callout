import type { CSSProperties, ReactNode } from 'react'

/** Two-tone heading: the first sentence in ink, the continuation in grey. */
export function SplitHeading({ first, second, as = 'h2', className = 't-h2', style }: { first: ReactNode; second?: ReactNode; as?: 'h1' | 'h2' | 'h3'; className?: string; style?: CSSProperties }) {
  const Tag = as
  return (
    <Tag className={className} style={style}>
      <span>{first}</span>
      {second ? <> <span className="ink-2">{second}</span></> : null}
    </Tag>
  )
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow" style={{ marginBottom: 18 }}>{children}</div>
}

export function Logo({ height = 26 }: { height?: number }) {
  return <img src="/brand/logo-light.png" alt="Callout" style={{ height, width: 'auto' }} />
}

export const GITHUB = 'https://github.com/datharnu/callout'
export const VIDEO = 'https://youtu.be/EQE6fJ02oIU' // the demo on YouTube; opens in a new tab

export function Nav({ cta = true }: { cta?: boolean }) {
  return (
    <header className="nav">
      <div className="wrap inner nav-row">
        <a href="/" aria-label="Callout home"><Logo /></a>
        <nav className="nav-links">
          <a href="/#how">How it works</a>
          <a href="/#proof">Proof</a>
          <a href="/#safety">Safety</a>
          <a href="/#voice">Voice</a>
          <a href="/#judges">For judges</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <div className="nav-cta">
          {cta
            ? <a className="nav-quiet" href={VIDEO} target="_blank" rel="noreferrer">Watch the demo</a>
            : <a className="btn btn-outline btn-sm nav-demo" href={VIDEO} target="_blank" rel="noreferrer"><span aria-hidden>▶</span> Watch the demo</a>}
          {cta && <a className="btn btn-solid btn-sm" href="/try/">Try it</a>}
        </div>
      </div>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap inner footer-grid">
        <div>
          <Logo height={24} />
          <p className="t-small" style={{ marginTop: 14, maxWidth: 320 }}>Checks the call before you take it. Built for Even Realities G2 at the Heads Up hackathon.</p>
          <p className="t-small" style={{ marginTop: 14 }}><span className="tag amber">Demo money only · Not financial advice</span></p>
        </div>
        <div className="footer-cols">
          <div>
            <div className="footer-h">Product</div>
            <a href="/#how">How it works</a><a href="/#safety">Safety</a><a href="/#voice">Voice</a><a href="/#record">Caller record</a>
          </div>
          <div>
            <div className="footer-h">For judges</div>
            <a href="/try/">Try it in your browser</a><a href={VIDEO} target="_blank" rel="noreferrer">Demo video (2:08)</a><a href="/#proof">Proof</a><a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          </div>
        </div>
      </div>
      <div className="wrap inner footer-base t-small">
        <span>© 2026 datharnu · MIT license</span>
        <span className="mono">Bybit Demo · Telegram · Even Realities G2</span>
      </div>
    </footer>
  )
}
