// On-device voice activity detection for the G2 mic (16 kHz, s16le, mono).
// Only finished utterances leave the glasses: no continuous streaming, no audio while idle.
// Pure logic (no SDK imports) so it can be unit-tested with synthetic PCM.

export const SAMPLE_RATE = 16_000
const CHUNK_MS = 20
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000 // 320

export interface VadOptions {
  preRollMs: number // audio kept from before speech starts (so the first word isn't clipped)
  startMs: number // loud this long → speech started
  endSilenceMs: number // quiet this long → utterance ended
  minSpeechMs: number // shorter bursts (clicks, coughs) are dropped
  maxUtteranceMs: number // hard cap per utterance
  startFactor: number // start threshold = noise floor × this
  continueFactor: number // stay-in-speech threshold = noise floor × this
  minStartRms: number // absolute floors (int16 scale) so a silent room doesn't trigger on hiss
  minContinueRms: number
}

export const DEFAULT_VAD: VadOptions = {
  preRollMs: 300,
  startMs: 60,
  endSilenceMs: 600,
  minSpeechMs: 250,
  maxUtteranceMs: 6000,
  startFactor: 3,
  continueFactor: 2,
  minStartRms: 500,
  minContinueRms: 350,
}

export type SpeakerRole = 'self' | 'other' | 'unknown'

export class Vad {
  private readonly o: VadOptions
  private noiseFloor = 200
  private pending = new Int16Array(0) // partial chunk carried between frames
  private preRoll: Int16Array[] = []
  private utterance: Int16Array[] = []
  private loudRun = 0
  private quietRun = 0
  private speechChunks = 0
  private _speaking = false

  constructor(
    private readonly onUtterance: (pcm: Uint8Array) => void,
    opts: Partial<VadOptions> = {},
  ) {
    this.o = { ...DEFAULT_VAD, ...opts }
  }

  get speaking(): boolean {
    return this._speaking
  }

  /** Drop any partial utterance (e.g. the card changed or the mic was turned off). */
  reset(): void {
    this.pending = new Int16Array(0)
    this.preRoll = []
    this.utterance = []
    this.loudRun = this.quietRun = this.speechChunks = 0
    this._speaking = false
  }

  /** Feed one mic frame (any length). Frames from another speaker are treated as silence. */
  push(frame: Uint8Array, role: SpeakerRole = 'unknown'): void {
    const samples = new Int16Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + (frame.byteLength & ~1)))
    const buf = new Int16Array(this.pending.length + samples.length)
    buf.set(this.pending)
    buf.set(samples, this.pending.length)
    let i = 0
    for (; i + CHUNK_SAMPLES <= buf.length; i += CHUNK_SAMPLES) this.chunk(buf.slice(i, i + CHUNK_SAMPLES), role)
    this.pending = buf.slice(i)
  }

  private chunk(c: Int16Array, role: SpeakerRole): void {
    let sum = 0
    for (let k = 0; k < c.length; k++) sum += c[k]! * c[k]!
    const rms = role === 'other' ? 0 : Math.sqrt(sum / c.length)
    const n = (ms: number) => Math.round(ms / CHUNK_MS)

    if (!this._speaking) {
      this.preRoll.push(c)
      if (this.preRoll.length > n(this.o.preRollMs)) this.preRoll.shift()
      const loud = rms > Math.max(this.noiseFloor * this.o.startFactor, this.o.minStartRms)
      this.loudRun = loud ? this.loudRun + 1 : 0
      if (!loud && role !== 'other') this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05 // adapt to the room
      if (this.loudRun >= n(this.o.startMs)) {
        this._speaking = true
        this.utterance = [...this.preRoll]
        this.preRoll = []
        this.speechChunks = this.loudRun
        this.quietRun = 0
      }
      return
    }

    this.utterance.push(c)
    const voiced = rms > Math.max(this.noiseFloor * this.o.continueFactor, this.o.minContinueRms)
    if (voiced) {
      this.speechChunks++
      this.quietRun = 0
    } else this.quietRun++
    const tooLong = this.utterance.length >= n(this.o.maxUtteranceMs)
    if (this.quietRun >= n(this.o.endSilenceMs) || tooLong) this.finish()
  }

  private finish(): void {
    // Keep ~200 ms of the trailing silence, drop the rest.
    const trim = Math.max(0, this.quietRun - Math.round(200 / CHUNK_MS))
    const chunks = this.utterance.slice(0, this.utterance.length - trim)
    const enough = this.speechChunks * CHUNK_MS >= this.o.minSpeechMs
    this.utterance = []
    this._speaking = false
    this.loudRun = this.quietRun = this.speechChunks = 0
    if (!enough) return
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Int16Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    this.onUtterance(new Uint8Array(out.buffer))
  }
}
