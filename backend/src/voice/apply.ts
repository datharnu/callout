// Apply one spoken utterance (possibly several commands) to one card.
// Voice never places or closes anything: Place/Close are only selected (a tap confirms).
// Modifiers (half size, set stop) re-run every check. Safe actions (skip/keep/cancel/ok) run now.
import { config } from '../config.js'
import { ActionError, cancel, dismiss, reevaluate, sizeProblem, skip } from '../executor.js'
import { audit } from '../store.js'
import { takeQuota, type Sandbox } from '../sandbox.js'
import { takeBudget } from '../budget.js'
import type { Card, VoiceNote } from '../types.js'
import { interpretAll, type VoiceCommand, type VoiceParse } from './commands.js'
import { SttError, transcribe } from './stt.js'

/** How long an unfinished command ("set stop…") waits for the rest ("…59K"). */
const PENDING_MS = 6000

const fmt = (v: number) =>
  v >= 10_000 ? `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : String(Number(v.toPrecision(6)))
const coin = (c: Card) => (c.parsed?.symbol ?? '').replace(/USDT$/, '')

export interface VoiceResult {
  heard: string
  commands: VoiceCommand[]
  note: VoiceNote
  /** Navigation is handled on the glasses. */
  navigate?: 'next' | 'prev'
}

function finish(card: Card, heard: string, result: VoiceNote['result'], message: string, commands: VoiceCommand[] = []): VoiceResult {
  const n: VoiceNote = {
    heard, result, message, state: card.state, at: Date.now(),
    ...(commands.length ? { command: commands.map(c => c.type).join('+') } : {}),
  }
  card.voice = n
  audit('voice', { id: card.id, heard, commands, result, message })
  const nav = commands.find(c => c.type === 'next' || c.type === 'prev')
  return { heard, commands, note: n, ...(nav ? { navigate: nav.type as 'next' | 'prev' } : {}) }
}

/**
 * Parse with any pending fragment. "set stop" + (pause) + "59K" arrive as two utterances; the
 * second is read as the continuation of the first, but only if that actually completes a stop.
 */
function parseWithPending(card: Card, heard: string): VoiceParse {
  const ctx = { state: card.state, action: card.action, entry: card.parsed?.entry ?? null }
  const pending = card.voicePending && Date.now() < card.voicePending.until ? card.voicePending : undefined
  card.voicePending = undefined
  if (pending) {
    const joined = interpretAll(`${pending.prefix} ${heard}`, ctx)
    if (joined.commands.some(c => c.type === 'set_stop')) return joined
  }
  return interpretAll(heard, ctx)
}

export async function handleVoice(sb: Sandbox, cardId: string, pcm: Buffer): Promise<VoiceResult> {
  const card = sb.cards.get(cardId)
  if (!card) throw new ActionError(404, 'card not found')
  if (!takeQuota(sb, 'voice')) return finish(card, '', 'refused', 'Voice limit for this hour reached · tap still works')
  if (sb.kind === 'judge' && !takeBudget('stt')) return finish(card, '', 'refused', 'Demo voice limit reached for today · tap still works')

  let heard: string
  try {
    heard = await transcribe(pcm)
  } catch (e) {
    const msg = e instanceof SttError && e.message === 'too short' ? "Didn't catch that" : "Couldn't hear that · try again"
    return finish(card, '', 'error', msg)
  }

  const parse = parseWithPending(card, heard)
  const quoted = heard ? `"${heard.slice(0, 40)}"` : 'nothing'
  if (parse.proceed) return finish(card, heard, 'not_available', 'Order continues · say cancel to stop')
  if (parse.ignored) return finish(card, heard, 'not_understood', 'Ignored: sounded like conversation')

  const parts: string[] = []
  let anyDone = false
  let anySelected = false
  let anyApplied = false
  let refused = false

  for (const cmd of parse.commands) {
    try {
      switch (cmd.type) {
        case 'size': {
          const prev = { factor: card.sizeFactor, usd: card.sizeUsd }
          card.sizeFactor = cmd.factor
          card.sizeUsd = Math.min(config.sizeUsd * cmd.factor, config.maxSizeUsd) // settings × factor, capped
          const problem = await sizeProblem(card)
          if (problem) {
            card.sizeFactor = prev.factor
            card.sizeUsd = prev.usd
            parts.push(`${cmd.factor === 0.5 ? 'Half' : 'Full'} size refused: ${problem}`)
            refused = true
          } else {
            parts.push(`${cmd.factor === 0.5 ? 'Half' : 'Full'} size $${card.sizeUsd}`)
            anyApplied = true
          }
          break
        }
        case 'set_stop': {
          card.userStop = cmd.price
          await reevaluate(card)
          const s = card.state as Card['state']
          parts.push(s === 'ready' ? `Stop ${fmt(cmd.price)} (yours)` : `Stop ${fmt(cmd.price)}: ${card.flags.join(' · ') || s}`)
          anyApplied = true
          break
        }
        case 'place':
          anySelected = true
          break
        case 'close':
          parts.push(`Close ${coin(card)} (reduce-only)`)
          anySelected = true
          break
        case 'skip':
          skip(sb, card.id)
          parts.push('Skipped')
          anyDone = true
          break
        case 'keep':
          skip(sb, card.id)
          parts.push(`Keeping ${coin(card)}`)
          anyDone = true
          break
        case 'cancel':
          cancel(sb, card.id)
          parts.push('Cancelled · no order sent')
          anyDone = true
          break
        case 'dismiss':
          dismiss(sb, card.id)
          parts.push('OK')
          anyDone = true
          break
        case 'next':
        case 'prev':
          return finish(card, heard, 'navigate', cmd.type === 'next' ? 'Next card' : 'Previous card', [cmd])
      }
    } catch {
      // e.g. the countdown ended (order already sent) a moment before "cancel" arrived.
      parts.push(`too late: card is ${card.state}`)
      refused = true
    }
  }

  for (const i of parse.issues) parts.push(i.kind === 'no_price' ? 'no stop price (e.g. "set stop 59.2k")' : `"${i.text}" not available here`)

  if (parse.partial === 'stop') {
    card.voicePending = { prefix: 'set stop', until: Date.now() + PENDING_MS }
    parts.push('Stop at what price?')
  }

  if (!parse.commands.length && !parse.partial) {
    const why = parse.issues.length ? parts.join(' · ') : parse.hint
    return finish(card, heard, parse.issues.length ? 'not_available' : 'not_understood', `Heard ${quoted} · ${why}`)
  }

  // One confirmation hint at the end, for whatever the tap will now do.
  const s = card.state as Card['state']
  if (!anyDone && !parse.partial && (anyApplied || anySelected)) {
    if (s === 'ready') parts.push(`tap to place $${card.sizeUsd}`)
    else if (s === 'holding') parts.push('tap to confirm')
  }
  const result: VoiceNote['result'] = anyDone ? 'done'
    : parse.partial && !anyApplied ? 'partial'
    : anyApplied ? 'applied'
    : anySelected ? 'selected'
    : refused ? 'refused' : 'not_understood'
  return finish(card, heard, result, parts.join(' · '), parse.commands)
}
