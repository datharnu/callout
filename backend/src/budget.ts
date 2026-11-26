// Global daily ceilings on paid calls made for JUDGE sandboxes (the owner is never limited).
// Protects the Anthropic and ElevenLabs credits from a burst of public traffic.
const LIMITS = {
  parse: Number(process.env.CALLOUT_JUDGE_PARSE_PER_DAY ?? 1500),
  stt: Number(process.env.CALLOUT_JUDGE_STT_PER_DAY ?? 600),
}
let day = ''
const used = { parse: 0, stt: 0 }

function roll() {
  const d = new Date().toISOString().slice(0, 10)
  if (d !== day) { day = d; used.parse = 0; used.stt = 0 }
}

/** true (and counted) while today's ceiling for `kind` isn't reached. */
export function takeBudget(kind: keyof typeof LIMITS): boolean {
  roll()
  if (used[kind] >= LIMITS[kind]) return false
  used[kind]++
  return true
}

export function budgetLeft() {
  roll()
  return { parse: LIMITS.parse - used.parse, stt: LIMITS.stt - used.stt }
}
