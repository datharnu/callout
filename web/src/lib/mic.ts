// Browser microphone → 16 kHz signed 16-bit little-endian mono PCM, the exact format the G2 mic
// produces. Frames (~100 ms) go to `onFrame`; `onLevel` gets an RMS level 0..1 for the meter.
const WORKLET = `
class CalloutMic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('callout-mic', CalloutMic)
`

const TARGET_RATE = 16000
const FRAME_SAMPLES = 1600 // 100 ms

export interface MicHandle { stop(): void }

export async function startMic(onFrame: (pcm: ArrayBuffer) => void, onLevel: (rms: number) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const ctx = new AudioContext()
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'callout-mic')
  const sink = ctx.createGain()
  sink.gain.value = 0 // keep the graph running without playing the mic back
  src.connect(node).connect(sink).connect(ctx.destination)

  const step = ctx.sampleRate / TARGET_RATE
  let pos = 0 // fractional read position into `carry`
  let carry = new Float32Array(0)
  let out = new Int16Array(FRAME_SAMPLES)
  let n = 0

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const input = ev.data
    // Join the leftover tail with the new block, then read at 16 kHz with linear interpolation.
    const buf = new Float32Array(carry.length + input.length)
    buf.set(carry)
    buf.set(input, carry.length)
    let sum = 0
    let count = 0
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos)
      const f = pos - i
      const s = buf[i]! * (1 - f) + buf[i + 1]! * f
      sum += s * s
      count++
      out[n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))
      if (n === FRAME_SAMPLES) {
        onFrame(out.buffer)
        out = new Int16Array(FRAME_SAMPLES)
        n = 0
      }
      pos += step
    }
    const keep = Math.floor(pos)
    carry = buf.slice(keep)
    pos -= keep
    if (count) onLevel(Math.min(1, Math.sqrt(sum / count) * 4))
  }

  return {
    stop() {
      node.port.onmessage = null
      src.disconnect()
      node.disconnect()
      stream.getTracks().forEach(t => t.stop())
      void ctx.close()
    },
  }
}
