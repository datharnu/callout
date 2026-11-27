// The glasses app talks to the display/input/mic through this small interface.
//   EvenBridge    → the Even Hub SDK (Even app WebView, official simulator, real G2)
//   PreviewBridge → postMessage to a parent page (the browser preview at /try)
import type { SpeakerRole } from './vad'

export type GlassesEvent =
  | { kind: 'click' }
  | { kind: 'double_click' }
  | { kind: 'up' } // swipe toward the top (SCROLL_TOP)
  | { kind: 'down' } // swipe toward the bottom (SCROLL_BOTTOM)
  | { kind: 'exit' } // host closed the app (system or abnormal exit)
  | { kind: 'audio'; pcm: Uint8Array; role: SpeakerRole }

export interface Bridge {
  /** Create the single full-screen text page (or rebuild it if the host already has one). */
  createPage(text: string): Promise<void>
  /** Replace the page text. */
  update(text: string): Promise<void>
  /** Subscribe to input + audio. Returns an unsubscribe function. */
  onEvent(cb: (e: GlassesEvent) => void): () => void
  /** Turn the microphone on/off. Resolves false if the host refused. */
  audioControl(on: boolean): Promise<boolean>
  /** Leave the app (double-tap on home). */
  shutdown(): Promise<void>
  /** Optional: tell a host page which card is on screen (browser preview only; the Even SDK has no use for it). */
  focus?(card: { id: string; state: string } | null): void
}

/** Browser preview: only when there is no Even app host AND the page asked for it. */
export function isPreview(loc: Pick<Location, 'search'> = location, win: unknown = window): boolean {
  const host = (win as { flutter_inappwebview?: unknown }).flutter_inappwebview
  return !host && new URLSearchParams(loc.search).get('preview') === '1'
}

export async function createBridge(): Promise<Bridge> {
  if (isPreview()) {
    const { PreviewBridge } = await import('./preview-bridge')
    return PreviewBridge.forWindow()
  }
  const { EvenBridge } = await import('./even-bridge')
  return EvenBridge.connect()
}
