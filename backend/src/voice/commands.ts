// Voice command interpreter. Pure code, no LLM: a transcript + the card's state → the commands in it.
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

// ── Scanner: every command in an utterance, in the order spoken ─────────────────────────────────
const B = '(?<![a-z0-9])'
const E = '(?![a-z0-9.,%])'
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')
const phrases = (list: string[]) => new RegExp(`${B}(?:${[...list].sort((a, b) => b.length - a.length).map(escape).join('|')})${E}`, 'g')

/** "set stop 59.2k", "move my stop to 59,200", "stop loss 59k", or just "set stop" (unfinished). */
const STOP_RE = new RegExp(
  `${B}(?:(?:set|move|put|change|update)\\s+)?(?:(?:my|the|a)\\s+)?(?:stop\\s+loss|stop|sl)${E}(?:\\s+(?:to|at|on|is))?(?:\\s+([0-9][0-9.,]*k?))?`,
  'g',
)

type Simple = Exclude<VoiceCommand, { type: 'set_stop' } | { type: 'size' }>['type']
const PHRASES: { cmd: VoiceCommand; re: RegExp }[] = [
  { cmd: { type: 'size', factor: 0.5 }, re: phrases(['half size', 'half', 'half position', '50%', 'fifty percent']) },
  { cmd: { type: 'size', factor: 1 }, re: phrases(['full size', 'full', 'normal size', '100%']) },
  ...(
    [
      ['cancel', ['cancel', 'abort']],
      ['close', ['close it', 'close', 'exit', 'take profit', 'get out', 'sell it']],
      ['keep', ['keep it', 'keep', 'hold', 'stay in']],
      ['skip', ['not this one', 'no thanks', 'skip', 'pass', 'ignore', 'no']],
      ['prev', ['go back', 'previous', 'back', 'prev']],
      ['next', ['next one', 'next']],
      ['dismiss', ['got it', 'okay', 'ok', 'continue', 'done', 'thanks']],
      ['place', ['place it', 'take it', 'take this', 'take that', 'place', 'buy', 'go', 'yes', 'confirm', 'enter', 'open']],
    ] as [Simple, string[]][]
  ).map(([type, list]) => ({ cmd: { type } as VoiceCommand, re: phrases(list) })),
]

/** Filler commands that only count in a very short utterance ("ok, half size" ≠ dismiss; "No, I don't…" in a conversation ≠ skip). */
const WEAK = new Set(['no', 'ok', 'okay', 'yes', 'go', 'thanks', 'done', 'enter', 'open'])
/** Words that don't make speech less command-like ("half size and then place it please"). */
const FILLER = new Set(['and', 'then', 'please', 'actually', 'also', 'um', 'uh', 'er', 'the', 'a', 'to', 'at', 'it', 'my', 'now', 'just', 'so', 'hey', 'callout'])
/** Longer speech must be mostly command words, or it is conversation (a TV, people nearby). */
const MIN_COMMAND_DENSITY = 0.5
const SHORT_UTTERANCE_WORDS = 6
const WEAK_MAX_WORDS = 3
const MODIFIERS = new Set<VoiceCommand['type']>(['size', 'set_stop'])
const NAVIGATION = new Set<VoiceCommand['type']>(['next', 'prev'])

export interface VoiceParse {
  /** Commands to apply, in order: modifiers first (as spoken), then at most one final action. */
  commands: VoiceCommand[]
  /** Things said that couldn't be used (shown to the user, nothing applied for them). */
  issues: { kind: 'no_price' | 'not_available'; text: string }[]
  /** The utterance ended mid-command ("set stop" with no price yet): wait for the rest. */
  partial?: 'stop'
  /** Countdown only: a clear "go ahead" (the order simply continues). */
  proceed?: boolean
  /** Sounded like conversation, not a command: nothing applied. */
  ignored?: boolean
  hint: string
}

interface Hit { start: number; end: number; text: string; cmd?: VoiceCommand; issue?: 'no_price'; partial?: 'stop'; weak?: boolean }

export function interpretAll(transcript: string, ctx: VoiceContext): VoiceParse {
  const t = normalize(transcript)
  const hint = hintFor(ctx)
  const out: VoiceParse = { commands: [], issues: [], hint }
  if (!t) return out

  // Countdown is fail-safe: anything that isn't a clear "go ahead" cancels. A wrong cancel costs
  // nothing; a missed cancel places an order. ("wait" was once heard as "way", "abort" as "I bought".)
  if (ctx.state === 'countdown') {
    // Negation wins: "no, don't go" / "don't do it" must cancel even though they contain "go" / "do it".
    if (has(t, 'no', 'dont', 'do not', 'not', 'stop', 'cancel', 'wait', 'abort', 'hold', 'hang on')) out.commands.push({ type: 'cancel' })
    else if (has(t, 'yes', 'go', 'go ahead', 'confirm', 'do it', 'ok', 'okay', 'continue', 'fine', 'place it', 'send it')) out.proceed = true
    else out.commands.push({ type: 'cancel' })
    return out
  }

  const hits: Hit[] = []
  for (const m of t.matchAll(STOP_RE)) {
    const start = m.index!
    const end = start + m[0].length
    const h: Hit = { start, end, text: m[0] }
    if (m[1]) {
      const n = numbersInText(m[1])[0]
      const price = n !== undefined ? resolvePrice(n, ctx.entry) : null
      if (price === null) h.issue = 'no_price'
      else h.cmd = { type: 'set_stop', price }
    } else if (end >= t.length) h.partial = 'stop' // "…set stop" at the very end: the price is coming
    else h.issue = 'no_price'
    hits.push(h)
  }
  for (const { cmd, re } of PHRASES)
    for (const m of t.matchAll(re)) hits.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], cmd, weak: WEAK.has(m[0]) })

  // Earliest first; at the same position the longer phrase wins; overlaps are dropped.
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const kept: Hit[] = []
  for (const h of hits) if (!kept.some(k => h.start < k.end && k.start < h.end)) kept.push(h)

  // Conversation filter: in speech longer than a few words, command phrases must cover at least half
  // of the meaningful words. "Welcome back… I feel like…" (6 s of a TV) is not "back".
  const words = t.split(' ').filter(w => !FILLER.has(w))
  const covered = kept.reduce((n, h) => n + h.text.split(' ').filter(w => !FILLER.has(w)).length, 0)
  if (words.length > SHORT_UTTERANCE_WORDS && covered / words.length < MIN_COMMAND_DENSITY) {
    out.ignored = true
    return out
  }

  // Negation drops the command it applies to: "don't place it", "not half size".
  const negated = (h: Hit) => /(?:^| )(?:dont|do not|not|never)(?: \S+)?\s*$/.test(t.slice(0, h.start))
  let used = kept.filter(h => !(h.cmd && h.cmd.type !== 'skip' && negated(h)))
  if (used.some(h => !h.weak && (h.cmd || h.issue || h.partial)) || words.length > WEAK_MAX_WORDS) used = used.filter(h => !h.weak)

  const cmds: VoiceCommand[] = []
  for (const h of used) {
    if (h.partial) out.partial = h.partial
    if (h.issue) out.issues.push({ kind: h.issue, text: h.text })
    if (!h.cmd) continue
    let c = h.cmd
    // "next"/"ok"/"place" on a result screen all mean "continue"; "skip" on a holding card means keep.
    if ((c.type === 'next' || c.type === 'place') && ['filled', 'failed', 'cancelled'].includes(ctx.state)) c = { type: 'dismiss' }
    if (c.type === 'skip' && ctx.state === 'holding') c = { type: 'keep' }
    if (!availableCommands(ctx).includes(c.type)) out.issues.push({ kind: 'not_available', text: h.text })
    else cmds.push(c)
  }

  // Combine: last value of each modifier wins (in spoken order); one final action (the last one);
  // navigation only when it was the only thing said.
  const modifiers: VoiceCommand[] = []
  for (const c of cmds) {
    if (!MODIFIERS.has(c.type)) continue
    const i = modifiers.findIndex(m => m.type === c.type)
    if (i >= 0) modifiers.splice(i, 1)
    modifiers.push(c)
  }
  const finals = cmds.filter(c => !MODIFIERS.has(c.type) && !NAVIGATION.has(c.type))
  const nav = cmds.filter(c => NAVIGATION.has(c.type))
  out.commands = [...modifiers, ...finals.slice(-1)]
  if (!out.commands.length && nav.length && !out.partial) out.commands = nav.slice(-1)
  return out
}

/** Single-command view (kept for callers that expect exactly one command). */
export function interpret(transcript: string, ctx: VoiceContext): Interpretation {
  const p = interpretAll(transcript, ctx)
  const hint = p.hint
  if (!normalize(transcript)) return { ok: false, reason: 'empty', hint }
  if (p.proceed) return { ok: false, reason: 'not_available', hint: 'order continues · say cancel to stop' }
  if (p.commands.length) return { ok: true, command: p.commands[0]! }
  if (p.partial || p.issues.some(i => i.kind === 'no_price')) return { ok: false, reason: 'no_price', hint }
  if (p.issues.length) return { ok: false, reason: 'not_available', hint }
  return { ok: false, reason: 'not_understood', hint }
}
