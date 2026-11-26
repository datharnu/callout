// Voice command accuracy: each phrase spoken by 6 macOS voices (US, UK, AU, IE, IN, ZA accents)
// into 16 kHz s16le PCM (the G2 mic format) → real ElevenLabs Scribe → production interpreter.
// macOS only (uses `say`). Synthetic speech, so this measures the pipeline, not real-world mics.
//
// Usage: npm run eval:voice   (writes eval/VOICE_RESULTS.md; ~170 short STT calls)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { interpretAll, type VoiceCommand, type VoiceContext } from '../src/voice/commands.js'
import { transcribe } from '../src/voice/stt.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Tessa']

const ready: VoiceContext = { state: 'ready', action: 'open', entry: 60400 }
const countdown: VoiceContext = { state: 'countdown', action: 'open', entry: 60400 }
const holding: VoiceContext = { state: 'holding', action: 'close', entry: null }
const result: VoiceContext = { state: 'filled', action: 'open', entry: 60400 }

/** expected: the command(s), or null = must NOT produce any command. */
const CASES: { phrase: string; ctx: VoiceContext; expected: VoiceCommand | VoiceCommand[] | null }[] = [
  { phrase: 'half size', ctx: ready, expected: { type: 'size', factor: 0.5 } },
  { phrase: 'half', ctx: ready, expected: { type: 'size', factor: 0.5 } },
  { phrase: 'full size', ctx: ready, expected: { type: 'size', factor: 1 } },
  { phrase: 'set stop fifty nine thousand two hundred', ctx: ready, expected: { type: 'set_stop', price: 59200 } },
  { phrase: 'set stop fifty nine point two K', ctx: ready, expected: { type: 'set_stop', price: 59200 } },
  { phrase: 'move my stop to fifty nine thousand', ctx: ready, expected: { type: 'set_stop', price: 59000 } },
  { phrase: 'stop loss fifty nine thousand five hundred', ctx: ready, expected: { type: 'set_stop', price: 59500 } },
  { phrase: 'place it', ctx: ready, expected: { type: 'place' } },
  { phrase: 'take it', ctx: ready, expected: { type: 'place' } },
  { phrase: 'skip', ctx: ready, expected: { type: 'skip' } },
  { phrase: 'skip this one', ctx: ready, expected: { type: 'skip' } },
  { phrase: 'pass', ctx: ready, expected: { type: 'skip' } },
  { phrase: 'next', ctx: ready, expected: { type: 'next' } },
  { phrase: 'go back', ctx: ready, expected: { type: 'prev' } },
  { phrase: 'cancel', ctx: countdown, expected: { type: 'cancel' } },
  { phrase: 'stop', ctx: countdown, expected: { type: 'cancel' } },
  { phrase: 'wait', ctx: countdown, expected: { type: 'cancel' } },
  { phrase: 'abort', ctx: countdown, expected: { type: 'cancel' } },
  { phrase: 'close it', ctx: holding, expected: { type: 'close' } },
  { phrase: 'take profit', ctx: holding, expected: { type: 'close' } },
  { phrase: 'keep it', ctx: holding, expected: { type: 'keep' } },
  { phrase: 'hold', ctx: holding, expected: { type: 'keep' } },
  { phrase: 'okay', ctx: result, expected: { type: 'dismiss' } },
  { phrase: 'continue', ctx: result, expected: { type: 'dismiss' } },
  // Several commands in one breath.
  { phrase: 'half size, set stop fifty nine thousand', ctx: ready, expected: [{ type: 'size', factor: 0.5 }, { type: 'set_stop', price: 59000 }] },
  { phrase: 'set stop fifty nine point five K and place it', ctx: ready, expected: [{ type: 'set_stop', price: 59500 }, { type: 'place' }] },
  // Negatives: must not produce any command.
  { phrase: 'what do you think about this one', ctx: ready, expected: null },
  { phrase: 'the market is crazy today', ctx: ready, expected: null },
  { phrase: 'close it', ctx: ready, expected: null }, // not available on a call card
  { phrase: 'half size', ctx: holding, expected: null }, // not available on a holding card
]

const RISKY = new Set(['place', 'close', 'size', 'set_stop'])
const dir = mkdtempSync(path.join(tmpdir(), 'callout-voice-eval-'))

function speak(phrase: string, voice: string, i: number): Buffer {
  const wav = path.join(dir, `${i}.wav`)
  execFileSync('say', ['-v', voice, '-o', wav, '--data-format=LEI16@16000', '--file-format=WAVE', phrase])
  const buf = readFileSync(wav)
  return buf.subarray(buf.indexOf('data') + 8)
}

const asList = (x: VoiceCommand | VoiceCommand[] | null): VoiceCommand[] => (x === null ? [] : Array.isArray(x) ? x : [x])
const same = (a: VoiceCommand[], b: VoiceCommand[]) => JSON.stringify(a) === JSON.stringify(b)

interface Row { voice: string; phrase: string; context: string; heard: string; got: VoiceCommand[]; ok: boolean; risky: boolean; ms: number }
const jobs = VOICES.flatMap(v => CASES.map(c => ({ v, c })))
const rows: Row[] = []
let next = 0
await Promise.all(
  Array.from({ length: 1 }, async () => { // sequential: latency numbers reflect real use (one utterance at a time)
    while (next < jobs.length) {
      const k = next++
      const { v, c } = jobs[k]!
      const pcm = speak(c.phrase, v, k)
      const t0 = Date.now()
      let heard = ''
      try {
        heard = await transcribe(pcm)
      } catch (e) {
        heard = `<error ${(e as Error).message}>`
      }
      const ms = Date.now() - t0
      const got = interpretAll(heard, c.ctx).commands
      const want = asList(c.expected)
      const ok = same(got, want)
      // Risky misfire: a money-relevant command that wasn't asked for (or with the wrong value).
      const risky = got.some(g => RISKY.has(g.type) && !want.some(w => same([w], [g])))
      rows.push({ voice: v, phrase: c.phrase, context: c.ctx.state, heard, got, ok, risky, ms })
      process.stdout.write(ok ? '.' : risky ? '!' : 'x')
    }
  }),
)
process.stdout.write('\n')
rmSync(dir, { recursive: true, force: true })

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`
const lat = rows.map(r => r.ms).sort((a, b) => a - b)
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]
const okN = rows.filter(r => r.ok).length
const risky = rows.filter(r => r.risky)
const pos = rows.filter(r => CASES.find(c => c.phrase === r.phrase && c.ctx.state === r.context)!.expected !== null)
const neg = rows.filter(r => !pos.includes(r))
const md = [
  '# Callout voice command accuracy',
  '',
  `Run ${new Date().toISOString()} · ElevenLabs \`scribe_v2\` on 16 kHz s16le PCM (the G2 mic format) · production interpreter.`,
  `${CASES.length} phrases × ${VOICES.length} synthetic voices (${VOICES.join(', ')}: US, UK, AU, IE, IN, ZA accents) = ${rows.length} utterances.`,
  'Synthetic speech (macOS `say`), so this measures the pipeline, not a noisy street or a real glasses mic.',
  '',
  `**Risky misfires: ${risky.length}** (a Place/Close/size/stop command that wasn't asked for, or a wrong stop price).`,
  '',
  `- Correct command: ${okN}/${rows.length} (${pct(okN, rows.length)})`,
  `- Commands recognised: ${pos.filter(r => r.ok).length}/${pos.length} (${pct(pos.filter(r => r.ok).length, pos.length)})`,
  `- Non-commands correctly ignored: ${neg.filter(r => r.ok).length}/${neg.length}`,
  `- Speech-to-text latency (sequential, warm connection): median ${p(0.5)} ms, p90 ${p(0.9)} ms`,
  '',
  '## By voice',
  '',
  '| Voice | Correct |',
  '|---|---|',
  ...VOICES.map(v => {
    const r = rows.filter(x => x.voice === v)
    return `| ${v} | ${r.filter(x => x.ok).length}/${r.length} |`
  }),
  '',
  '## Misses',
  '',
  ...rows
    .filter(r => !r.ok)
    .map(r => `- ${r.risky ? '**RISKY** ' : ''}${r.voice} · [${r.context}] "${r.phrase}" → heard "${r.heard}" → ${r.got.length ? JSON.stringify(r.got) : 'no command'}`),
  '',
].join('\n')
writeFileSync(path.join(here, 'VOICE_RESULTS.md'), md)
console.log(md)
process.exitCode = risky.length ? 1 : 0
