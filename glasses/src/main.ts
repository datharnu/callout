import { fetchState, sendAction, sendVoice, AuthError, type Action, type CardView, type StateView } from './api'
import { createBridge } from './bridge'
import { cardScreen, homeScreen, type VoiceUi } from './screens'
import { Vad } from './vad'

const POLL_MS = 1000
const TAP_GUARD_MS = 1000 // ignore taps right after the screen changes (no accidental orders on a new card)

// Even Hub SDK on the glasses / official simulator; postMessage in the browser preview (/try).
const bridge = await createBridge()
await bridge.createPage('CALLOUT · connecting...')

let state: StateView | null = null
let offline = false
let authFailed = false
let selectedId: string | null = null
let shownKey = '' // identity of what's on screen (card id + state) for the tap guard
let shownAt = 0
let lastContent = ''
let busy = false

// ── Voice ─────────────────────────────────────────────────────────────────────────────────────
// The mic is on only while a card is on screen (never on home). On-device VAD cuts utterances;
// each one goes to the card that was on screen when it was spoken. Voice picks, a tap confirms.
const VOICE_STATES = ['ready', 'holding', 'blocked', 'unsure', 'countdown', 'filled', 'failed', 'cancelled']
let micOn = false
let micWanted = false
let micUnavailable = false
let voiceSending = false
let voiceCardId: string | null = null // card on screen when the current utterance started
const vad = new Vad(pcm => void onUtterance(pcm))

async function setMic(on: boolean) {
  if (on === micWanted) return
  micWanted = on
  if (!on) vad.reset()
  try {
    const ok = await bridge.audioControl(on)
    micOn = on && ok
    micUnavailable = on && !ok
    console.log(`[callout] mic ${on ? 'on' : 'off'} → ${ok}`)
  } catch (e) {
    micOn = false
    micUnavailable = on
    console.warn('[callout] mic control failed', e)
  }
  render()
}

// Utterances are processed strictly in order, each against the card it was spoken to.
// ("set stop" + pause + "59K" arrive as two utterances; the second must not be dropped.)
const voiceQueue: { id: string; pcm: Uint8Array }[] = []
const MAX_QUEUE = 3

async function onUtterance(pcm: Uint8Array) {
  const id = voiceCardId
  voiceCardId = null
  console.log(`[callout] utterance ${Math.round(pcm.length / 32)} ms → ${id ?? 'no card'}${voiceSending ? ' (queued)' : ''}`)
  if (!id) return
  if (voiceQueue.length >= MAX_QUEUE) voiceQueue.shift()
  voiceQueue.push({ id, pcm })
  if (voiceSending) return
  voiceSending = true
  render()
  try {
    while (voiceQueue.length) {
      const next = voiceQueue.shift()!
      if (next.id !== selected()?.id) continue // the card changed: never apply speech to a different card
      try {
        const r = await sendVoice(next.id, next.pcm)
        console.log(`[callout] voice "${r.heard}" → ${r.note.result}: ${r.note.message}`)
        if (r.navigate) onSwipe(r.navigate === 'next' ? 1 : -1)
      } catch (e) {
        console.warn('[callout] voice failed', e)
      }
      await poll()
    }
  } finally {
    voiceSending = false
    render()
  }
}

function voiceUi(): VoiceUi {
  if (micUnavailable) return { status: 'unavailable' }
  if (!micOn) return { status: 'off' }
  if (vad.silentInput) return { status: 'no_audio' }
  if (voiceSending) return { status: 'sending' }
  if (vad.speaking) return { status: 'hearing' }
  return { status: 'listening' }
}

function visibleCards(): CardView[] {
  return state?.cards ?? []
}

function selected(): CardView | undefined {
  const cs = visibleCards()
  if (!cs.length) return undefined
  // Results and in-flight orders take priority so the user always sees what happened.
  const urgent = cs.find(c => ['countdown', 'placing', 'filled', 'failed', 'cancelled'].includes(c.state))
  if (urgent) return urgent
  return cs.find(c => c.id === selectedId) ?? cs[0]
}

function render() {
  const now = Date.now() + clockOffset // server time, so the countdown matches the backend's deadline
  const c = selected()
  let content: string
  let key: string
  if (authFailed) {
    content = 'CALLOUT\n\nSession not recognised.\nOpen Callout again from your link.'
    key = 'auth'
  } else if (!state) {
    content = offline ? 'CALLOUT\n\nBackend offline · retrying' : 'CALLOUT · connecting...'
    key = 'boot'
  } else if (!c) {
    content = homeScreen(state, offline)
    key = 'home'
  } else {
    selectedId = c.id
    const cs = visibleCards()
    const pos = cs.length > 1 ? `${cs.indexOf(c) + 1}/${cs.length}` : ''
    content = cardScreen(c, now, pos, voiceUi())
    key = `${c.id}:${c.state}`
  }
  if (key !== shownKey) {
    if (key.split(':').slice(0, -1).join(':') !== shownKey.split(':').slice(0, -1).join(':')) {
      vad.reset() // new card: drop half-heard speech and anything queued for the old one
      voiceQueue.length = 0
    }
    shownKey = key
    shownAt = Date.now()
  }
  void setMic(!!c && VOICE_STATES.includes(c.state))
  if (content !== lastContent) {
    lastContent = content
    void bridge.update(content)
  }
}

let clockOffset = 0 // serverNow - localNow
async function poll() {
  try {
    state = await fetchState()
    clockOffset = state.now - Date.now()
    offline = false
    authFailed = false
  } catch (e) {
    if (e instanceof AuthError) authFailed = true
    else offline = true
  }
  render()
}

async function act(action: Action) {
  const c = selected()
  if (!c || busy) return
  busy = true
  try {
    const r = await sendAction(c.id, action)
    if (r.ok) console.log(`[callout] ${action} ${c.id} → ${r.card.state}`)
    else console.warn(`[callout] ${action} ${c.id} refused: ${r.error}`)
  } catch (e) {
    console.warn(`[callout] ${action} failed`, e)
  } finally {
    busy = false
  }
  await poll()
}

function onTap() {
  const c = selected()
  console.log(`[callout] tap on ${c ? `${c.id} (${c.state})` : 'home'}`)
  if (!c) return
  if (Date.now() - shownAt < TAP_GUARD_MS && c.state !== 'countdown') {
    console.log('[callout] tap ignored: screen just changed')
    return
  }
  if (c.state === 'ready' || c.state === 'holding') void act('confirm')
  else if (c.state === 'countdown') void act('cancel')
  else if (c.state === 'blocked' || c.state === 'unsure') void act('skip') // Skip is the only option
  else if (['filled', 'failed', 'cancelled'].includes(c.state)) void act('dismiss')
}

function onDoubleTap() {
  const c = selected()
  if (!c) {
    void bridge.shutdown() // home: exit app
    return
  }
  if (c.state === 'countdown') void act('cancel')
  else if (['ready', 'holding', 'blocked', 'unsure'].includes(c.state)) void act('skip')
  else if (['filled', 'failed', 'cancelled'].includes(c.state)) void act('dismiss')
}

function onSwipe(dir: 1 | -1) {
  const cs = visibleCards().filter(c => ['ready', 'holding', 'blocked', 'unsure'].includes(c.state))
  if (cs.length < 2) return
  const i = cs.findIndex(c => c.id === selectedId)
  selectedId = cs[(i + dir + cs.length) % cs.length]!.id
  render()
}

const unsubscribe = bridge.onEvent(e => {
  if (e.kind === 'audio') {
    if (!micOn) return
    const wasSpeaking = vad.speaking
    const wasSilent = vad.silentInput
    vad.push(e.pcm, e.role ?? 'unknown')
    if (wasSilent !== vad.silentInput) render()
    if (!wasSpeaking && vad.speaking) {
      voiceCardId = selected()?.id ?? null
      render()
    }
    return
  }
  if (e.kind === 'double_click') return onDoubleTap()
  if (e.kind === 'click') return onTap()
  if (e.kind === 'down') return onSwipe(1)
  if (e.kind === 'up') return onSwipe(-1)
  if (e.kind === 'exit') {
    clearInterval(pollTimer)
    clearInterval(tickTimer)
    void bridge.audioControl(false)
    unsubscribe()
  }
})

const pollTimer = setInterval(() => void poll(), POLL_MS)
// Smooth countdown bar between polls.
const tickTimer = setInterval(() => {
  if (selected()?.state === 'countdown') render()
}, 250)
void poll()
