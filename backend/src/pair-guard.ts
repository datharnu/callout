// Guessing pairing codes: 5 wrong /pair tries per person per 10 minutes, then a pause.
// A code has a million values and expires in minutes, so this makes guessing hopeless.
export const PAIR_TRIES = 5
export const PAIR_WINDOW_MS = 10 * 60_000
const failures = new Map<string, number[]>()

export function pairTriesLeft(key: string, now = Date.now()): number {
  const recent = (failures.get(key) ?? []).filter(t => now - t < PAIR_WINDOW_MS)
  failures.set(key, recent)
  return PAIR_TRIES - recent.length
}

export function notePairFailure(key: string, now = Date.now()): void {
  failures.set(key, [...(failures.get(key) ?? []), now])
}
