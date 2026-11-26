// Voice command interpreter. Pure code, no LLM: a transcript + the card's state → one command.
//
// Safety model (BRIEF: "voice only picks an action; a tap always confirms"):
//   - Risky actions (place an order, close a position) are only SELECTED by voice; a tap confirms.
//   - Modifiers (half size, set stop) change the card; every code check re-runs; a tap still confirms.
//   - Safe actions (skip, keep, cancel the countdown, dismiss, navigate) run immediately:
//     waiting for a tap to *cancel* would defeat the point of a cancel.
import { numbersInText } from '../checks.js'
import type { CardState } from '../types.js'

export type VoiceCommand =
  | { type: 'place' } // select Place (tap confirms)
  | { type: 'close' } // select Close (reduce-only) (tap confirms)
  | { type: 'size'; factor: 0.5 | 1 } // half / full size
  | { type: 'set_stop'; price: number } // user's own stop; checks re-run
  | { type: 'skip' }
  | { type: 'keep' }
  | { type: 'cancel' }
  | { type: 'dismiss' }
  | { type: 'next' }
  | { type: 'prev' }

export type Interpretation =
  | { ok: true; command: VoiceCommand }
  | { ok: false; reason: 'empty' | 'not_understood' | 'not_available' | 'no_price'; hint: string }

export interface VoiceContext {
  state: CardState
  action: 'open' | 'close'
  /** Entry price, to resolve shorthand like "set stop 59.2" → 59200. */
  entry: number | null
}

/** What can be said on each card, also shown as the on-screen hint. */
export function availableCommands(ctx: Pick<VoiceContext, 'state' | 'action'>): VoiceCommand['type'][] {
  switch (ctx.state) {
    case 'ready':
      return ['place', 'size', 'set_stop', 'skip', 'next', 'prev']
    case 'blocked':
      // A stop can be fixed by voice (checks re-run); nothing else here can be traded.
      return ['set_stop', 'skip', 'next', 'prev']
    case 'unsure':
      return ['skip', 'next', 'prev']
    case 'holding':
      return ['close', 'keep', 'next', 'prev']
    case 'countdown':
      return ['cancel']
    case 'filled':
    case 'failed':
    case 'cancelled':
      return ['dismiss']
    default:
      return []
  }
}

export function hintFor(ctx: Pick<VoiceContext, 'state' | 'action'>): string {
  switch (ctx.state) {
    case 'ready':
      return 'say: half size · set stop 59k · skip'
    case 'blocked':
      return 'say: skip · set stop 59k'
    case 'unsure':
      return 'say: skip'
    case 'holding':
      return 'say: close · keep'
    case 'countdown':
      return 'say: cancel'
    case 'filled':
    case 'failed':
    case 'cancelled':
      return 'say: ok'
    default:
      return ''
  }
}

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/**
 * Spelled-out numbers → digits, for transcripts like "fifty-nine thousand two hundred" or
 * "one thirty four point five". Digits already in the text are left alone.
 */
export function wordsToDigits(text: string): string {
  const tokens = text.replace(/-/g, ' ').split(/\s+/)
  const out: string[] = []
  let i = 0
  const isNum = (w: string | undefined) => !!w && (w in SMALL || w in TENS || w === 'hundred' || w === 'thousand')
  while (i < tokens.length) {
    if (!isNum(tokens[i]) || (tokens[i] === 'oh' && !isNum(tokens[i + 1]))) {
      out.push(tokens[i]!)
      i++
      continue
    }
    let total = 0
    let current = 0
    let lastSmall = -1 // for "one thirty four" style (134): a small number directly followed by tens
    while (i < tokens.length && isNum(tokens[i])) {
      const w = tokens[i]!
      if (w in SMALL) {
        current += SMALL[w]!
        lastSmall = SMALL[w]!
      } else if (w in TENS) {
        // "one thirty four" → 134: a lone small number before tens acts as hundreds.
        if (current > 0 && current < 10 && lastSmall === current) current = current * 100
        current += TENS[w]!
        lastSmall = -1
      } else if (w === 'hundred') {
        current = (current || 1) * 100
        lastSmall = -1
      } else if (w === 'thousand') {
        total += (current || 1) * 1000
        current = 0
        lastSmall = -1
      }
      i++
    }
    let value = String(total + current)
    // decimals: "point two" / "point five"
    if (tokens[i] === 'point' && tokens[i + 1] && tokens[i + 1]! in SMALL) {
      i++
      let dec = ''
      while (i < tokens.length && tokens[i]! in SMALL && SMALL[tokens[i]!]! < 10) dec += String(SMALL[tokens[i++]!])
      value += `.${dec}`
    }
    out.push(value)
  }
  return out.join(' ').replace(/(\d) k\b/g, '$1k')
}

const has = (t: string, ...words: string[]) => words.some(w => new RegExp(`(^| )${w}( |$)`).test(t))

/** Lowercase, keep letters/digits/.,% and spaces; "59.2k" stays intact for the number parser. */
export function normalize(transcript: string): string {
  const cleaned = transcript
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/-/g, ' ') // "fifty-nine" → "fifty nine"
    .replace(/[^a-z0-9.,%\s]/g, ' ')
    .replace(/(\D)[.,](?=\s|$)/g, '$1') // sentence punctuation, not decimal points
    .replace(/\s+/g, ' ')
    .trim()
  return wordsToDigits(cleaned).replace(/\s+/g, ' ').trim()
}

/**
 * Turn a spoken number into a price on the entry's scale. "59.2" next to a 60,400 entry is 59,200
 * (same shorthand rule as the call parser). Returns null if nothing plausible (within ±50% of entry).
 */
export function resolvePrice(spoken: number, entry: number | null): number | null {
  if (!(spoken > 0)) return null
  if (entry === null || !(entry > 0)) return spoken
  const candidates = [spoken, spoken * 1000]
  let best: number | null = null
  for (const c of candidates) {
    const ratio = c / entry
    if (ratio >= 0.5 && ratio <= 1.5 && (best === null || Math.abs(c - entry) < Math.abs(best - entry))) best = c
  }
  return best
}

function detect(t: string, ctx: VoiceContext): VoiceCommand | 'no_price' | 'proceed' | null {
  // Countdown is fail-safe: anything that isn't a clear "go ahead" cancels. A wrong cancel costs
  // nothing; a missed cancel places an order. ("wait" was once heard as "way", "abort" as "I bought".)
  if (ctx.state === 'countdown') {
    // Negation wins: "no, don't go" / "don't do it" must cancel even though they contain "go" / "do it".
    if (has(t, 'no', 'dont', 'do not', 'not', 'stop', 'cancel', 'wait', 'abort', 'hold', 'hang on')) return { type: 'cancel' }
    if (has(t, 'yes', 'go', 'go ahead', 'confirm', 'do it', 'ok', 'okay', 'continue', 'fine', 'place it', 'send it')) return 'proceed'
    return { type: 'cancel' }
  }
  // Order matters: specific phrases before single words ("set stop 59k" before "stop" = cancel).
  if (/\b(stop|stop loss|sl)\b/.test(t) && /\d/.test(t)) {
    const nums = numbersInText(t)
    const price = nums.length ? resolvePrice(nums[nums.length - 1]!, ctx.entry) : null
    return price === null ? 'no_price' : { type: 'set_stop', price }
  }
  if (has(t, 'half', 'half size', '50%', 'fifty percent')) return { type: 'size', factor: 0.5 }
  if (has(t, 'full size', 'full', 'normal size', '100%')) return { type: 'size', factor: 1 }

  if (has(t, 'cancel', 'abort')) return { type: 'cancel' }

  if (has(t, 'close', 'close it', 'exit', 'take profit', 'get out', 'sell it')) return { type: 'close' }
  if (has(t, 'keep', 'keep it', 'hold', 'stay in')) return { type: 'keep' }
  if (has(t, 'skip', 'pass', 'ignore', 'not this one', 'no', 'no thanks')) return { type: 'skip' }
  // Navigation before "place": "go back" must not match "go".
  if (has(t, 'previous', 'back', 'prev', 'go back')) return { type: 'prev' }
  if (has(t, 'next', 'next one')) return { type: 'next' }
  if (has(t, 'ok', 'okay', 'continue', 'done', 'got it', 'thanks')) return { type: 'dismiss' }
  if (has(t, 'place', 'place it', 'buy', 'take it', 'take this', 'take that', 'go', 'yes', 'confirm', 'enter', 'open')) return { type: 'place' }
  return null
}

export function interpret(transcript: string, ctx: VoiceContext): Interpretation {
  const t = normalize(transcript)
  const hint = hintFor(ctx)
  if (!t) return { ok: false, reason: 'empty', hint }
  let cmd = detect(t, ctx)
  if (cmd === 'no_price') return { ok: false, reason: 'no_price', hint }
  if (cmd === 'proceed') return { ok: false, reason: 'not_available', hint: 'order continues · say cancel to stop' }
  if (!cmd) return { ok: false, reason: 'not_understood', hint }
  // "next"/"ok" on a result screen both mean "continue".
  if ((cmd.type === 'next' || cmd.type === 'place') && ['filled', 'failed', 'cancelled'].includes(ctx.state)) cmd = { type: 'dismiss' }
  // On a holding card, "skip" means keep the position.
  if (cmd.type === 'skip' && ctx.state === 'holding') cmd = { type: 'keep' }
  if (!availableCommands(ctx).includes(cmd.type)) return { ok: false, reason: 'not_available', hint }
  return { ok: true, command: cmd }
}
