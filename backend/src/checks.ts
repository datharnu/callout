// Code-only checks. Pure functions, no I/O: the LLM output is treated as untrusted input here.
// Flags are factual and neutral ("price 4.1% from call"), never "good"/"bad".
import type { CheckFacts, ParsedCall } from './types.js'

export interface CheckSettings {
  symbolWhitelist: ReadonlySet<string>
  maxEntryDistancePct: number
  callExpiryMs: number
  minConfidence?: number
}

export interface CheckInput {
  parsed: ParsedCall
  rawText: string
  livePrice: number | undefined
  /** Stop the USER set by voice. Replaces the caller's stop; exempt from the "written in the message" check. */
  stopOverride?: number
  sentAt: number
  now: number
  /** Link targets Telegram hides behind text ("Join VIP" → t.me/...): not in rawText, still a link. */
  hiddenLinks?: string[]
}

export type CheckVerdict =
  | { state: 'ready'; flags: string[]; facts: CheckFacts }
  | { state: 'blocked' | 'unsure' | 'expired'; flags: string[]; facts: CheckFacts }

const MIN_CONFIDENCE = 0.7

/** Every number written in the message, with "k" expanded. "92.4k" → 92400, "92,400" → 92400. */
export function numbersInText(text: string): number[] {
  const out: number[] = []
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([kK])?(?![\d])/g
  for (const m of text.matchAll(re)) {
    let v = Number(`${m[1]!.replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`)
    if (m[3]) v *= 1000
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6)

/**
 * Is `value` literally traceable to the message? Accepts the number as written, the
 * shorthand form ("SL 90" for 90000 → ×1000), or the midpoint of two written numbers (entry ranges).
 */
export function traceable(value: number, written: number[]): boolean {
  const candidates = written.flatMap(n => [n, n * 1000])
  if (candidates.some(c => close(c, value))) return true
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++)
      if (close((candidates[i]! + candidates[j]!) / 2, value)) return true
  return false
}

/**
 * Undo the usual tricks for hiding a link from filters: zero-width characters, full-width letters
 * ("ｔ.ｍｅ"), "t . me", "t[.]me", "(dot)", "vipsignals dot com" and "hxxp". Red-team cases r24–r29.
 */
export function deobfuscate(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s*(\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)|\{dot\})\s*/gi, '.')
    .replace(/(\w)\s+dot\s+(com|io|xyz|net|org|app|link|site|me|gg|co|cc|top|vip)\b/gi, '$1.$2')
    .replace(/\b([a-z0-9-]+)\s+\.\s+([a-z]{2,6})\b/gi, '$1.$2')
    .replace(/\bhxxp(s?)/gi, 'http$1')
}

/** Factual risk flags from the raw text. Wording states what is there, not a judgment. */
export function scamFlags(text: string): string[] {
  const t = text.toLowerCase()
  const flags: string[] = []
  if (/(https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]+\.(com|io|xyz|net|org|app|link|site)\b)/i.test(deobfuscate(text))) flags.push('contains link')
  for (const word of ['guaranteed', 'risk free', 'risk-free', '100% win', 'cant lose', "can't lose", 'sure shot', 'free money']) {
    if (t.includes(word)) flags.push(`says "${word}"`)
  }
  if (/\b(dm|pm|message) me\b/.test(t)) flags.push('asks for DM')
  if (/\b(send|deposit|transfer)\b.{0,30}\b(usdt|btc|eth|sol|funds|wallet)\b/.test(t)) flags.push('asks to send funds')
  if (/\b(0x[a-f0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|T[1-9A-HJ-NP-Za-km-z]{33})\b/i.test(text)) flags.push('contains wallet address')
  if (/\b(pump|moon(ing)?)\b.{0,20}\b(now|soon|incoming|today)\b/.test(t)) flags.push('pump wording')
  return flags
}

const fmtPct = (p: number) => `${Math.abs(p).toFixed(1)}%`

export function runChecks(input: CheckInput, s: CheckSettings): CheckVerdict {
  const { parsed, rawText, livePrice, sentAt, now, stopOverride } = input
  // The user's own stop (if any) replaces the caller's for every check except traceability.
  const p = stopOverride !== undefined ? { ...parsed, stop: stopOverride } : parsed
  const facts: CheckFacts = { livePrice }

  if (now - sentAt > s.callExpiryMs) {
    return { state: 'expired', flags: [`older than ${Math.round(s.callExpiryMs / 60_000)} min`], facts }
  }

  // Couldn't read it → "unsure" card, never tradable.
  if (p.kind !== 'trade_call' || !p.symbol || !p.side || p.confidence < (s.minConfidence ?? MIN_CONFIDENCE)) {
    return { state: 'unsure', flags: ["Couldn't read this clearly"], facts }
  }

  const flags: string[] = []
  flags.push(...scamFlags(rawText))
  if (input.hiddenLinks?.length && !flags.includes('contains link')) flags.push('contains hidden link')

  if (!s.symbolWhitelist.has(p.symbol)) flags.push('coin not on list')

  if (p.entry === null || p.entry <= 0) flags.push('no entry price')
  if (p.stop === null || p.stop <= 0) flags.push('no stop-loss')
  if (p.targets.length === 0) flags.push('no target')

  // Anti-hallucination / anti-injection: every price must be written in the message.
  const written = numbersInText(rawText)
  const prices = [p.entry, stopOverride === undefined ? p.stop : null, ...p.targets].filter((v): v is number => v !== null && v > 0)
  if (prices.some(v => !traceable(v, written))) flags.push('values not found in message')

  if (p.entry !== null && p.entry > 0) {
    const long = p.side === 'long'
    if (p.stop !== null && p.stop > 0 && (long ? p.stop >= p.entry : p.stop <= p.entry)) {
      flags.push(`stop ${long ? 'above' : 'below'} entry`)
    }
    if (p.targets.some(t => (long ? t <= p.entry! : t >= p.entry!))) {
      flags.push(`target ${long ? 'below' : 'above'} entry`)
    }
    if (p.stop !== null && p.stop > 0 && p.targets[0] !== undefined) {
      const risk = Math.abs(p.entry - p.stop)
      if (risk > 0) facts.rr = Math.round((Math.abs(p.targets[0] - p.entry) / risk) * 10) / 10
    }

    if (livePrice === undefined || !(livePrice > 0)) {
      flags.push('live price unavailable')
    } else {
      facts.distancePct = ((livePrice - p.entry) / p.entry) * 100
      if (Math.abs(facts.distancePct) > s.maxEntryDistancePct) flags.push(`price ${fmtPct(facts.distancePct)} from call`)
      if (p.stop !== null && p.stop > 0 && (long ? livePrice <= p.stop : livePrice >= p.stop)) flags.push('price already past stop')
      const t0 = p.targets[0]
      if (t0 !== undefined && (long ? livePrice >= t0 : livePrice <= t0)) flags.push('price already past target')
    }
  }

  return flags.length ? { state: 'blocked', flags, facts } : { state: 'ready', flags: [], facts }
}
