import { useRef, type ReactNode } from 'react'
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react'

export const EASE = [0.22, 1, 0.36, 1] as const

/** Page enter: rise 16px and fade in, once. */
export function PageEnter({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.main
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ease: EASE, duration: 0.5 }}
    >
      {children}
    </motion.main>
  )
}

/** Fade-up when scrolled into view (once). `delay` staggers siblings. */
export function Reveal({ children, delay = 0, y = 18, className, as = 'div' }: { children: ReactNode; delay?: number; y?: number; className?: string; as?: 'div' | 'li' | 'section' }) {
  const reduce = useReducedMotion()
  const M = as === 'li' ? motion.li : as === 'section' ? motion.section : motion.div
  return (
    <M
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ ease: EASE, duration: 0.6, delay }}
    >
      {children}
    </M>
  )
}

/**
 * Scroll-linked lift: while the element travels up through the bottom of the viewport it rises from
 * `y` and scales from `scale` to rest, smoothed by a spring. Reversible, like the scroll itself.
 */
export function Lift({ children, y = 40, scale = 0.97, className }: { children: ReactNode; y?: number; scale?: number; className?: string }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] })
  const p = useSpring(scrollYProgress, { stiffness: 420, damping: 60, mass: 1 })
  const ty = useTransform(p, [0, 1], [y, 0])
  const s = useTransform(p, [0, 1], [scale, 1])
  if (reduce) return <div ref={ref} className={className}>{children}</div>
  return (
    <motion.div ref={ref} className={className} style={{ y: ty, scale: s }}>
      {children}
    </motion.div>
  )
}
