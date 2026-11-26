// Speech-to-text via ElevenLabs Scribe. Audio comes straight from the G2 mic
// (16 kHz, signed 16-bit little-endian, mono), which is Scribe's native `pcm_s16le_16` format,
// so nothing is re-encoded. The API key stays on the backend. Audio is never written to disk.
import { Agent, fetch as ufetch, FormData as UFormData } from 'undici'
import { requireEnv } from '../env.js'

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text'
const MODEL = 'scribe_v2'
const SAMPLE_RATE = 16_000
const TIMEOUT_MS = 10_000

/**
 * Recognition bias, SAFE words only. Biasing toward "half size" once turned a mumbled "pass" into
 * "half size" (see eval/VOICE_RESULTS.md). Biasing only toward harmless commands means an unclear
 * word can only drift toward something safe; size/stop/place/close must be heard on their own.
 */
const KEYTERMS = ['skip', 'cancel', 'keep', 'keep it', 'okay', 'continue', 'next', 'go back']

export class SttError extends Error {}

/**
 * Keep the TLS connection to ElevenLabs open between utterances. A cold connection costs ~0.5 s
 * (connect + TLS) on top of ~0.5 s transcription; Node's default pool drops idle sockets after ~4 s.
 */
const pool = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000, connections: 4 })
let lastWarm = 0

/** Open (or refresh) the connection before the user speaks, e.g. when a card appears. Free call. */
export function warmUp(): void {
  if (Date.now() - lastWarm < 20_000 || !process.env.ELEVENLABS_API_KEY) return
  lastWarm = Date.now()
  ufetch('https://api.elevenlabs.io/v1/models', {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    dispatcher: pool,
    signal: AbortSignal.timeout(5000),
  })
    .then(r => r.arrayBuffer())
    .catch(() => {})
}

export const MIN_AUDIO_MS = 150 // Scribe requires >= 100 ms
export const MAX_AUDIO_MS = 8_000

export const pcmDurationMs = (bytes: number) => (bytes / 2 / SAMPLE_RATE) * 1000

export async function transcribe(pcm: Buffer): Promise<string> {
  const ms = pcmDurationMs(pcm.length)
  if (pcm.length % 2 !== 0) throw new SttError('audio is not 16-bit PCM')
  if (ms < MIN_AUDIO_MS) throw new SttError('too short')
  if (ms > MAX_AUDIO_MS) throw new SttError('too long')

  const form = new UFormData()
  form.append('model_id', MODEL)
  form.append('file_format', 'pcm_s16le_16')
  form.append('language_code', 'en')
  form.append('tag_audio_events', 'false')
  if (process.env.CALLOUT_STT_KEYTERMS !== '0') for (const k of KEYTERMS) form.append('keyterms', k)
  form.append('file', new Blob([new Uint8Array(pcm)], { type: 'application/octet-stream' }), 'utterance.pcm')

  let res: Awaited<ReturnType<typeof ufetch>>
  try {
    res = await ufetch(ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': requireEnv('ELEVENLABS_API_KEY') },
      body: form,
      dispatcher: pool,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    lastWarm = Date.now()
  } catch (e) {
    throw new SttError(`speech service unreachable (${(e as Error).name})`)
  }
  if (!res.ok) throw new SttError(`speech service ${res.status}`)
  const body = (await res.json()) as { text?: string }
  return (body.text ?? '').trim()
}
