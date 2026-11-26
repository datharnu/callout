import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
  StartUpPageCreateResult,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { fetchState, sendAction, sendVoice, type Action, type CardView, type StateView } from './api'
import { cardScreen, homeScreen, type VoiceUi } from './screens'
import { Vad, type SpeakerRole } from './vad'

const POLL_MS = 1000
const TAP_GUARD_MS = 1000 // ignore taps right after the screen changes (no accidental orders on a new card)

const bridge = await waitForEvenAppBridge()

const main = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 6,
  containerID: 1,
  containerName: 'main',
  content: 'CALLOUT · connecting...',
  isEventCapture: 1,
})
// The startup page can only be created once per session. After a reload (dev hot-reload, or the
// WebView reloading on the phone) creation fails, so rebuild the existing page instead; otherwise
// every later textContainerUpgrade silently goes nowhere and the glasses freeze on old content.
// A host that lost track of the previous session may never answer at all, so don't wait forever.
const withTimeout = <T,>(pr: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([pr, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms))])
const created = await withTimeout(bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] })), 4000)
if (created !== StartUpPageCreateResult.success) {
  const rebuilt = await withTimeout(bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [main] })), 4000)
  console.log(`[callout] page create → ${created}; rebuilt existing page → ${rebuilt}`)
} else console.log('[callout] page created')

let state: StateView | null = null
let offline = false
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
    const ok = await bridge.audioControl(on, AudioInputSource.Glasses)
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
  if (!state) {
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
    void bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }))
  }
}

let clockOffset = 0 // serverNow - localNow
async function poll() {
  try {
    state = await fetchState()
    clockOffset = state.now - Date.now()
    offline = false
  } catch {
    offline = true
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
    void bridge.shutDownPageContainer(1) // home: exit app
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

// Tap = CLICK_EVENT (0), which protobuf omits on the wire, so `eventType` can be undefined.
// Resolve the default inside the envelope check only (see template notes).
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sys = eventTypeOf(event.sysEvent)
  const text = eventTypeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sys === t || text === t

  const audio = event.audioEvent
  if (audio) {
    if (!micOn) return
    const wasSpeaking = vad.speaking
    const wasSilent = vad.silentInput
    vad.push(audio.audioPcm, (audio.speakerRole as string as SpeakerRole) ?? 'unknown')
    if (wasSilent !== vad.silentInput) render()
    if (!wasSpeaking && vad.speaking) {
      voiceCardId = selected()?.id ?? null
      render()
    }
    return
  }

  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) return onDoubleTap()
  if (is(OsEventTypeList.CLICK_EVENT)) return onTap()
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return onSwipe(1)
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) return onSwipe(-1)
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
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
