import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_RATE, Vad, type SpeakerRole } from '../src/vad'

/** Build PCM: [ms, amplitude] segments. amplitude 0 → low noise; else a 200 Hz tone. */
function pcm(parts: [number, number][]): Uint8Array {
  const total = parts.reduce((s, [ms]) => s + (ms * SAMPLE_RATE) / 1000, 0)
  const out = new Int16Array(total)
  let i = 0
  let seed = 1
  for (const [ms, amp] of parts) {
    const n = (ms * SAMPLE_RATE) / 1000
    for (let k = 0; k < n; k++, i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const noise = ((seed / 0x7fffffff) * 2 - 1) * 60
      out[i] = amp ? Math.round(Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * amp + noise) : Math.round(noise)
    }
  }
  return new Uint8Array(out.buffer)
}

/** Feed in irregular frame sizes, like a real BLE stream. */
function feed(v: Vad, data: Uint8Array, role: SpeakerRole = 'self') {
  const sizes = [640, 1000, 322, 2048, 98]
  for (let off = 0, k = 0; off < data.length; k++) {
    const len = Math.min(sizes[k % sizes.length]!, data.length - off)
    v.push(data.subarray(off, off + len), role)
    off += len
  }
}

const ms = (u: Uint8Array) => (u.length / 2 / SAMPLE_RATE) * 1000

test('one spoken phrase → one utterance with pre-roll, trailing silence trimmed', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[1000, 0], [600, 6000], [1200, 0]]))
  assert.equal(got.length, 1)
  const d = ms(got[0]!)
  assert.ok(d >= 900 && d <= 1300, `duration ${d}ms`) // ~300 pre-roll + 600 speech + ~200 tail
})

test('two phrases separated by a pause → two utterances', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[800, 0], [500, 6000], [1000, 0], [700, 6000], [1000, 0]]))
  assert.equal(got.length, 2)
})

test('short click is ignored', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[800, 0], [40, 8000], [1200, 0]])) // a real click/tap is 10–40 ms
  assert.equal(got.length, 0)
})

test('silence and steady room noise never trigger', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[5000, 0]]))
  feed(v, pcm([[3000, 300]])) // steady low hum below the start threshold
  assert.equal(got.length, 0)
})

test('another speaker (speakerRole "other") is ignored', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[800, 0], [800, 6000], [1000, 0]]), 'other')
  assert.equal(got.length, 0)
})

test('long monologue is capped at max utterance length', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[500, 0], [9000, 6000], [1000, 0]]))
  assert.ok(got.length >= 1)
  assert.ok(got.every(u => ms(u) <= 6000), got.map(ms).join(','))
})

test('exact digital silence is reported as a blocked mic; real noise is not', () => {
  const v = new Vad(() => {})
  v.push(new Uint8Array(2 * 16000 * 3)) // 3 s of exact zeros
  assert.equal(v.silentInput, true)
  const w = new Vad(() => {})
  feed(w, pcm([[3000, 0]])) // low noise, like a real quiet room
  assert.equal(w.silentInput, false)
})

test('reset drops a partial utterance', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[500, 0], [400, 6000]]))
  assert.equal(v.speaking, true)
  v.reset()
  feed(v, pcm([[1000, 0]]))
  assert.equal(got.length, 0)
})

test('live mic levels: quiet room (~55 RMS) with a short command at 600–900 RMS is detected', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  // amplitude A sine ≈ RMS A/√2: 75 → ~53 room noise; 1100 → ~780 speech for 300 ms, a 250 ms tail at ~180
  feed(v, pcm([[1500, 75], [300, 1100], [250, 250], [1200, 75]]))
  assert.equal(got.length, 1)
})

test('live mic levels: a very short command ("Close it", ~180 ms loud) over ~90 RMS noise is detected', () => {
  const got: Uint8Array[] = []
  const v = new Vad(u => got.push(u))
  feed(v, pcm([[1500, 130], [100, 1400], [100, 650], [100, 250], [1200, 130]]))
  assert.equal(got.length, 1)
})
