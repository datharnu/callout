// Apply one spoken utterance to one card.
// Voice never places or closes anything: Place/Close are only selected (a tap confirms).
// Modifiers (half size, set stop) re-run every check. Safe actions (skip/keep/cancel/ok) run now.
import { config } from '../config.js'
import { ActionError, cancel, dismiss, reevaluate, sizeProblem, skip } from '../executor.js'
import { audit, cards } from '../store.js'
import type { Card, VoiceNote } from '../types.js'
import { interpret, type VoiceCommand } from './commands.js'
import { SttError, transcribe } from './stt.js'

const fmt = (v: number) =>
  v >= 10_000 ? `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : String(Number(v.toPrecision(6)))
const coin = (c: Card) => (c.parsed?.symbol ?? '').replace(/USDT$/, '')

export interface VoiceResult {
  heard: string
  command?: VoiceCommand
  note: VoiceNote
  /** Navigation is handled on the glasses. */
  navigate?: 'next' | 'prev'
}

function note(card: Card, heard: string, result: VoiceNote['result'], message: string, command?: VoiceCommand): VoiceResult {
  const n: VoiceNote = { heard, result, message, state: card.state, at: Date.now(), ...(command ? { command: command.type } : {}) }
  card.voice = n
  audit('voice', { id: card.id, heard, command: command ?? null, result, message })
  return { heard, note: n, ...(command ? { command } : {}) }
}

export async function handleVoice(cardId: string, pcm: Buffer): Promise<VoiceResult> {
  const card = cards.get(cardId)
  if (!card) throw new ActionError(404, 'card not found')

  let heard: string
  try {
    heard = await transcribe(pcm)
  } catch (e) {
    const msg = e instanceof SttError && e.message === 'too short' ? "Didn't catch that" : "Couldn't hear that · try again"
    return note(card, '', 'error', msg)
  }

  const it = interpret(heard, { state: card.state, action: card.action, entry: card.parsed?.entry ?? null })
  if (!it.ok) {
    const quoted = heard ? `"${heard.slice(0, 40)}"` : 'nothing'
    if (it.reason === 'no_price') return note(card, heard, 'not_understood', `Heard ${quoted} · no stop price · e.g. "set stop 59.2k"`)
    if (it.reason === 'not_available') return note(card, heard, 'not_available', `Heard ${quoted} · not available here · ${it.hint}`)
    return note(card, heard, 'not_understood', `Heard ${quoted} · ${it.hint}`)
  }

  const cmd = it.command
  try {
    switch (cmd.type) {
      case 'place':
        return note(card, heard, 'selected', `Place $${card.sizeUsd} demo · tap to confirm`, cmd)
      case 'close':
        return note(card, heard, 'selected', `Close ${coin(card)} (reduce-only) · tap to confirm`, cmd)

      case 'size': {
        const prev = { factor: card.sizeFactor, usd: card.sizeUsd }
        card.sizeFactor = cmd.factor
        card.sizeUsd = Math.min(config.sizeUsd * cmd.factor, config.maxSizeUsd) // settings × factor, capped
        const problem = await sizeProblem(card)
        if (problem) {
          card.sizeFactor = prev.factor
          card.sizeUsd = prev.usd
          return note(card, heard, 'refused', `${cmd.factor === 0.5 ? 'Half' : 'Full'} size refused · ${problem}`, cmd)
        }
        return note(card, heard, 'applied', `${cmd.factor === 0.5 ? 'Half' : 'Full'} size: $${card.sizeUsd} · tap to place`, cmd)
      }

      case 'set_stop': {
        card.userStop = cmd.price
        await reevaluate(card)
        const s = card.state as Card['state']
        if (s === 'ready') return note(card, heard, 'applied', `Stop set to ${fmt(cmd.price)} (yours) · tap to place`, cmd)
        return note(card, heard, 'applied', `Stop set to ${fmt(cmd.price)} · ${card.flags.join(' · ') || s}`, cmd)
      }

      case 'skip':
        skip(card.id)
        return note(card, heard, 'done', 'Skipped', cmd)
      case 'keep':
        skip(card.id)
        return note(card, heard, 'done', `Keeping ${coin(card)}`, cmd)
      case 'cancel':
        cancel(card.id)
        return note(card, heard, 'done', 'Cancelled · no order sent', cmd)
      case 'dismiss':
        dismiss(card.id)
        return note(card, heard, 'done', 'OK', cmd)
      case 'next':
      case 'prev':
        return { ...note(card, heard, 'navigate', cmd.type === 'next' ? 'Next card' : 'Previous card', cmd), navigate: cmd.type }
    }
  } catch (e) {
    // e.g. the countdown ended (order already sent) a moment before "cancel" arrived.
    return note(card, heard, 'refused', `Too late · card is ${card.state}`, cmd)
  }
}
