import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

export type FrameName = 'home' | 'card' | 'voice' | 'countdown' | 'filled' | 'scam' | 'rule' | 'holding' | 'closing' | 'closed'

export const FRAME_LABEL: Record<FrameName, string> = {
  home: 'Session · watching your groups',
  card: 'A call, checked',
  voice: '“Half size, set stop 59.7k”',
  countdown: 'Tap · 5-second cancel window',
  filled: 'Filled on Bybit Demo',
  scam: 'Blocked: link + “guaranteed”',
  rule: 'Blocked: your daily limit',
  holding: 'Holding update · your position',
  closing: 'Reduce-only close',
  closed: 'Closed (reduce-only)',
}

/** The G2 display with real simulator captures. Cycles through `frames`, or shows `frame` if given. */
export function G2Frames({ frames, frame, interval = 2600, caption = 'Even Realities G2 · simulator capture' }: { frames?: FrameName[]; frame?: FrameName; interval?: number; caption?: string }) {
  const reduce = useReducedMotion()
  const [i, setI] = useState(0)
  useEffect(() => {
    if (frame || !frames || frames.length < 2 || reduce) return
    const t = setInterval(() => setI(x => (x + 1) % frames.length), interval)
    return () => clearInterval(t)
  }, [frame, frames, interval, reduce])
  const current: FrameName = frame ?? frames?.[i] ?? 'home'
  return (
    <div className="g2">
      <div className="g2-screen">
        <AnimatePresence initial={false}>
          <motion.img
            key={current}
            src={`/frames/${current}.png`}
            alt={FRAME_LABEL[current]}
            initial={reduce ? false : { opacity: 0, filter: 'blur(2px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            style={{ position: 'absolute', inset: 0 }}
          />
        </AnimatePresence>
      </div>
      <div className="g2-caption"><span>{caption}</span><span>{FRAME_LABEL[current]}</span></div>
    </div>
  )
}
