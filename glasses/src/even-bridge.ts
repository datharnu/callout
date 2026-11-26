// Even Hub SDK bridge: the Even app WebView, the official simulator and real G2 glasses.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
  StartUpPageCreateResult,
  RebuildPageContainer,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Bridge, GlassesEvent } from './bridge'
import type { SpeakerRole } from './vad'

const CONTAINER = { id: 1, name: 'main' }

const withTimeout = <T,>(pr: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([pr, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms))])

// Tap = CLICK_EVENT (0), which protobuf omits on the wire, so `eventType` can be undefined.
// Resolve the default inside the envelope check only (see template notes).
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

export class EvenBridge implements Bridge {
  private constructor(private readonly sdk: EvenAppBridge) {}

  static async connect(): Promise<EvenBridge> {
    return new EvenBridge(await waitForEvenAppBridge())
  }

  private page(text: string) {
    return new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 5, paddingLength: 6,
      containerID: CONTAINER.id, containerName: CONTAINER.name, content: text, isEventCapture: 1,
    })
  }

  // The startup page can only be created once per session. After a reload (dev hot-reload, or the
  // WebView reloading on the phone) creation fails, so rebuild the existing page instead; otherwise
  // every later textContainerUpgrade silently goes nowhere and the glasses freeze on old content.
  // A host that lost track of the previous session may never answer at all, so don't wait forever.
  async createPage(text: string) {
    const created = await withTimeout(this.sdk.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [this.page(text)] })), 4000)
    if (created !== StartUpPageCreateResult.success) {
      const rebuilt = await withTimeout(this.sdk.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [this.page(text)] })), 4000)
      console.log(`[callout] page create → ${created}; rebuilt existing page → ${rebuilt}`)
    } else console.log('[callout] page created')
  }

  async update(text: string) {
    await this.sdk.textContainerUpgrade(new TextContainerUpgrade({ containerID: CONTAINER.id, containerName: CONTAINER.name, content: text }))
  }

  onEvent(cb: (e: GlassesEvent) => void) {
    return this.sdk.onEvenHubEvent(event => {
      const audio = event.audioEvent
      if (audio) {
        cb({ kind: 'audio', pcm: audio.audioPcm, role: ((audio.speakerRole as string) ?? 'unknown') as SpeakerRole })
        return
      }
      const sys = eventTypeOf(event.sysEvent)
      const text = eventTypeOf(event.textEvent)
      const is = (t: OsEventTypeList) => sys === t || text === t
      // Double-tap before tap.
      if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) return cb({ kind: 'double_click' })
      if (is(OsEventTypeList.CLICK_EVENT)) return cb({ kind: 'click' })
      if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return cb({ kind: 'down' })
      if (is(OsEventTypeList.SCROLL_TOP_EVENT)) return cb({ kind: 'up' })
      if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) cb({ kind: 'exit' })
    })
  }

  async audioControl(on: boolean) {
    return on ? this.sdk.audioControl(true, AudioInputSource.Glasses) : this.sdk.audioControl(false)
  }

  async shutdown() {
    await this.sdk.shutDownPageContainer(1)
  }
}
