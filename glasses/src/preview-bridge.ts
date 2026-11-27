// Browser preview bridge (docs/HOSTED.md): the glasses app runs unchanged inside an iframe and the
// parent page (/try) draws the 576×288 display, sends touch/ring input and microphone audio.
// No SDK import here, so this file is testable in Node.
import type { Bridge, GlassesEvent } from './bridge'

export type PreviewMessage =
  | { type: 'callout:display'; content: string }
  | { type: 'callout:mic'; on: boolean }
  | { type: 'callout:focus'; id: string | null; state: string | null } // which card is on screen

type Incoming = { type: 'callout:input'; action: string } | { type: 'callout:audio'; pcm: ArrayBuffer | ArrayBufferView }

export interface PreviewDeps {
  /** Send a message to the parent page. */
  post(msg: PreviewMessage): void
  /** Listen to messages; the handler receives the raw MessageEvent-like object. */
  subscribe(handler: (ev: { origin: string; source: unknown; data: unknown }) => void): () => void
  /** Our own origin: only same-origin messages are accepted. */
  origin: string
  /** The parent window: only messages from it are accepted. */
  parent: unknown
}

const INPUT: Record<string, GlassesEvent['kind']> = { click: 'click', double_click: 'double_click', up: 'up', down: 'down' }

export class PreviewBridge implements Bridge {
  private listeners = new Set<(e: GlassesEvent) => void>()
  private stop: () => void

  constructor(private readonly deps: PreviewDeps) {
    this.stop = deps.subscribe(ev => this.handle(ev))
  }

  static forWindow(): PreviewBridge {
    return new PreviewBridge({
      origin: location.origin,
      parent: window.parent,
      post: msg => window.parent.postMessage(msg, location.origin),
      subscribe: h => {
        const fn = (ev: MessageEvent) => h(ev)
        window.addEventListener('message', fn)
        return () => window.removeEventListener('message', fn)
      },
    })
  }

  /** Exposed for tests: route one incoming message. */
  handle(ev: { origin: string; source: unknown; data: unknown }): void {
    if (ev.origin !== this.deps.origin || ev.source !== this.deps.parent) return
    const d = ev.data as Incoming | null
    if (!d || typeof d !== 'object' || typeof (d as { type?: unknown }).type !== 'string') return
    if (d.type === 'callout:input') {
      const kind = INPUT[d.action]
      if (kind) this.emit({ kind } as GlassesEvent)
      return
    }
    if (d.type === 'callout:audio') {
      const src = d.pcm
      const pcm =
        src instanceof ArrayBuffer ? new Uint8Array(src)
        : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
        : null
      if (pcm && pcm.byteLength >= 2) this.emit({ kind: 'audio', pcm, role: 'unknown' })
    }
  }

  private emit(e: GlassesEvent) {
    for (const l of this.listeners) l(e)
  }

  async createPage(text: string) {
    this.deps.post({ type: 'callout:display', content: text })
  }
  async update(text: string) {
    this.deps.post({ type: 'callout:display', content: text })
  }
  onEvent(cb: (e: GlassesEvent) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  async audioControl(on: boolean) {
    this.deps.post({ type: 'callout:mic', on })
    return true
  }
  focus(card: { id: string; state: string } | null) {
    this.deps.post({ type: 'callout:focus', id: card?.id ?? null, state: card?.state ?? null })
  }
  async shutdown() {
    this.deps.post({ type: 'callout:display', content: 'CALLOUT · closed\n\nReload the page to start again' })
    this.stop()
  }
}
