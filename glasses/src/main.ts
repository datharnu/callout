import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { fetchState, sendAction, type Action, type CardView, type StateView } from './api'
import { cardScreen, homeScreen } from './screens'

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
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }))

let state: StateView | null = null
let offline = false
let selectedId: string | null = null
let shownKey = '' // identity of what's on screen (card id + state) for the tap guard
let shownAt = 0
let lastContent = ''
let busy = false

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
    content = cardScreen(c, now, pos)
    key = `${c.id}:${c.state}`
  }
  if (key !== shownKey) {
    shownKey = key
    shownAt = Date.now()
  }
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
  if (c.state === 'ready') void act('confirm')
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
  else if (['ready', 'blocked', 'unsure'].includes(c.state)) void act('skip')
  else if (['filled', 'failed', 'cancelled'].includes(c.state)) void act('dismiss')
}

function onSwipe(dir: 1 | -1) {
  const cs = visibleCards().filter(c => ['ready', 'blocked', 'unsure'].includes(c.state))
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

  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) return onDoubleTap()
  if (is(OsEventTypeList.CLICK_EVENT)) return onTap()
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return onSwipe(1)
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) return onSwipe(-1)
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    clearInterval(pollTimer)
    clearInterval(tickTimer)
    unsubscribe()
  }
})

const pollTimer = setInterval(() => void poll(), POLL_MS)
// Smooth countdown bar between polls.
const tickTimer = setInterval(() => {
  if (selected()?.state === 'countdown') render()
}, 250)
void poll()
