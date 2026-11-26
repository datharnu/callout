// Accuracy eval: runs the labeled set through the PRODUCTION gate, parser (real LLM) and checks.
// Reports per-kind precision/recall, field accuracy, and unsafe one-tap cards (target: 0).
//
// Usage: npm run eval            (writes eval/results.json and eval/RESULTS.md)
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.js'
import { parseMessage } from '../src/ai/parse.js'
import { runChecks } from '../src/checks.js'
import { gate } from '../src/pipeline.js'
import type { ParsedCall } from '../src/types.js'
import { DATASET, SNAPSHOT, type Item, type Kind } from './dataset.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHAT = 'eval-chat'
const ADMIN = 'eval-admin'
const allow = { chats: new Set([CHAT]), senders: new Set([ADMIN]) }
const settings = { symbolWhitelist: config.symbolWhitelist, maxEntryDistancePct: config.maxEntryDistancePct, callExpiryMs: config.callExpiryMs }
const NOW = Date.now()
const KINDS: Kind[] = ['trade_call', 'holding_update', 'noise', 'unsure']

type Decision = 'muted' | 'ready' | 'blocked' | 'unsure' | 'expired'

/** Same decision rules as pipeline.ingest, minus I/O. */
function decide(p: ParsedCall, text: string, parseError?: string): Decision {
  if (p.kind === 'noise' && !parseError) return 'muted'
  if (parseError || p.kind === 'holding_update') return 'unsure'
  const live = p.symbol ? SNAPSHOT[p.symbol] : undefined
  return runChecks({ parsed: p, rawText: text, livePrice: live, sentAt: NOW, now: NOW }, settings).state
}

function truthAsParsed(item: Item): ParsedCall {
  const t = item.truth
  return {
    kind: t.kind, symbol: t.symbol ?? null, side: t.side ?? null, entry: t.entry ?? null, stop: t.stop ?? null,
    targets: t.targets ?? [], leverage: null, confidence: 1, quote: item.text,
  }
}

/** Prices match within 1e-6 relative; "absent" matches whether written as null or undefined. */
const eq = (a: number | null | undefined, b: number | null | undefined) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= Math.abs(b) * 1e-6)

interface Row {
  id: string
  text: string
  tags: string[]
  sender: string
  truthKind: Kind
  predKind: Kind | 'gated'
  kindOk: boolean
  expected: Decision
  predicted: Decision
  fields?: Record<'symbol' | 'side' | 'entry' | 'stop' | 'targets', boolean>
  unsafe: boolean
  parsed?: ParsedCall
  error?: string
}

async function evalItem(item: Item): Promise<Row> {
  const msg = { chatId: CHAT, senderId: item.sender === 'admin' ? ADMIN : 'eval-stranger', text: item.text }
  const g = gate(msg, allow)
  const expected: Decision = !g.pass ? 'muted' : decide(truthAsParsed(item), item.text)
  const base = { id: item.id, text: item.text, tags: item.tags, sender: item.sender, truthKind: item.truth.kind, expected }
  if (!g.pass) return { ...base, predKind: 'gated', kindOk: true, predicted: 'muted', unsafe: false }

  const { parsed: p, error } = await parseMessage(item.text)
  const predicted = decide(p, item.text, error)
  const accepted = [item.truth.kind, ...(item.truth.alt ?? [])]
  const row: Row = { ...base, predKind: p.kind, kindOk: accepted.includes(p.kind), predicted, unsafe: false, parsed: p, ...(error ? { error } : {}) }

  if (item.truth.kind === 'trade_call' && p.kind === 'trade_call') {
    const t = item.truth
    row.fields = {
      symbol: p.symbol === t.symbol,
      side: p.side === t.side,
      entry: eq(p.entry, t.entry),
      stop: eq(p.stop, t.stop),
      targets: p.targets.length === (t.targets ?? []).length && p.targets.every((v, i) => eq(v, t.targets![i])),
    }
  }
  if (predicted === 'ready') {
    const t = item.truth
    const valuesMatch =
      p.symbol === t.symbol && p.side === t.side && eq(p.entry, t.entry) && eq(p.stop, t.stop) && eq(p.targets[0], t.targets?.[0])
    row.unsafe = expected !== 'ready' || !valuesMatch
  }
  return row
}

async function pool<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let i = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < xs.length) {
        const k = i++
        out[k] = await fn(xs[k]!)
        process.stdout.write('.')
      }
    }),
  )
  process.stdout.write('\n')
  return out
}

const rows = await pool(DATASET, 6, evalItem)

// ── Metrics ────────────────────────────────────────────────────────────────────────────────────
const llmRows = rows.filter(r => r.predKind !== 'gated')
/** A prediction counts as the truth kind when it's one of the accepted alternatives. */
const credited = (r: Row): Kind | 'gated' => (r.kindOk ? r.truthKind : r.predKind)
const perKind = KINDS.map(k => {
  const tp = llmRows.filter(r => r.truthKind === k && credited(r) === k).length
  const fp = llmRows.filter(r => r.truthKind !== k && credited(r) === k).length
  const fn = llmRows.filter(r => r.truthKind === k && credited(r) !== k).length
  const support = llmRows.filter(r => r.truthKind === k).length
  return { kind: k, support, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 }
})
const fieldRows = rows.filter(r => r.fields)
const fieldAcc = (['symbol', 'side', 'entry', 'stop', 'targets'] as const).map(f => ({
  field: f,
  acc: fieldRows.length ? fieldRows.filter(r => r.fields![f]).length / fieldRows.length : 1,
}))
const unsafe = rows.filter(r => r.unsafe)
const decisionOk = rows.filter(r => r.predicted === r.expected).length
const missedTradable = rows.filter(r => r.expected === 'ready' && r.predicted !== 'ready')
const impostors = rows.filter(r => r.tags.includes('impostor'))
const errors = rows.filter(r => r.error)

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const counts = Object.fromEntries(KINDS.map(k => [k, rows.filter(r => r.truthKind === k).length]))
const md = [
  '# Callout parser + checks accuracy',
  '',
  `Run ${new Date(NOW).toISOString()} · model \`${config.parseModel}\` · ${rows.length} synthetic messages ` +
    `(${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}; ${impostors.length} from non-allowlisted senders).`,
  'The set is synthetic and was written by the same team that wrote the parser prompt, so treat these numbers as a smoke test, not a benchmark.',
  '',
  `**Unsafe one-tap cards: ${unsafe.length}** (a card you could place with one tap whose values differ from the message, or that the checks should have blocked).`,
  '',
  '## Classification (allowlisted senders only)',
  '',
  '| Kind | Support | Precision | Recall |',
  '|---|---|---|---|',
  ...perKind.map(k => `| ${k.kind} | ${k.support} | ${pct(k.precision)} | ${pct(k.recall)} |`),
  '',
  `## Field accuracy (${fieldRows.length} trade calls parsed as trade calls)`,
  '',
  '| Field | Accuracy |',
  '|---|---|',
  ...fieldAcc.map(f => `| ${f.field} | ${pct(f.acc)} |`),
  '',
  '## End-to-end decision',
  '',
  `- Final card state matches expectation: ${decisionOk}/${rows.length} (${pct(decisionOk / rows.length)})`,
  `- Tradable calls shown as tradable: ${rows.filter(r => r.expected === 'ready').length - missedTradable.length}/${rows.filter(r => r.expected === 'ready').length}`,
  `- Non-allowlisted senders muted: ${impostors.filter(r => r.predicted === 'muted').length}/${impostors.length}`,
  `- Parser errors (fell back to "unsure"): ${errors.length}`,
  '',
  ...(unsafe.length ? ['## Unsafe cards', '', ...unsafe.map(r => `- ${r.id} \`${r.text}\` → ${JSON.stringify(r.parsed)}`), ''] : []),
  ...(missedTradable.length
    ? ['## Tradable calls not shown as tradable', '', ...missedTradable.map(r => `- ${r.id} \`${r.text.replace(/\n/g, ' ')}\` → ${r.predicted} (${r.predKind})`), '']
    : []),
  '## Classification misses',
  '',
  ...llmRows.filter(r => !r.kindOk).map(r => `- ${r.id} [${r.tags.join(',')}] \`${r.text.replace(/\n/g, ' ')}\` → expected ${r.truthKind}, got ${r.predKind}`),
  '',
].join('\n')

writeFileSync(path.join(here, 'results.json'), JSON.stringify(rows, null, 2))
writeFileSync(path.join(here, 'RESULTS.md'), md)
console.log(md)
process.exitCode = unsafe.length ? 1 : 0
