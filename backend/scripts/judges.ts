// Kill switch for the public "Try it" judge mode on the hosted backend (owner only).
// Usage: npm run judges -- status | pause | resume
// Targets CALLOUT_API (default: the hosted URL) with the owner token CALLOUT_HOSTED_OWNER_TOKEN from .env.
import { requireEnv } from '../src/env.js'

const API = process.env.CALLOUT_API ?? 'https://callout-production-049324a2.up.railway.app'
const cmd = process.argv[2] ?? 'status'
if (!['status', 'pause', 'resume'].includes(cmd)) {
  console.error('usage: npm run judges -- status | pause | resume')
  process.exit(2)
}
const token = requireEnv('CALLOUT_HOSTED_OWNER_TOKEN')
const r = await fetch(`${API}/api/admin/judges`, {
  method: cmd === 'status' ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${token}`, ...(cmd === 'status' ? {} : { 'content-type': 'application/json' }) },
  body: cmd === 'status' ? undefined : JSON.stringify({ paused: cmd === 'pause' }),
})
const body = (await r.json().catch(() => ({}))) as { paused?: boolean; forcedByEnv?: boolean; openJudgePositions?: number; error?: string }
if (!r.ok) {
  console.error(`${r.status} ${body.error ?? ''}`)
  process.exit(1)
}
console.log(`Try it live: ${body.paused ? 'PAUSED' : 'open'}${body.forcedByEnv ? ' (forced by CALLOUT_JUDGES_PAUSED=1)' : ''} · open judge positions: ${body.openJudgePositions} (they still auto-close)`)
