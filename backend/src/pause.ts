// Kill switch for the public "Try it" judge mode. Owner-only, instant, survives restarts.
// Paused: no new judge sessions, existing judge tokens get 503, Telegram /pair and judge routing stop.
// The owner's own sandbox and the Telegram bot keep working. Open judge positions still auto-close.
//
// Two ways to pause:
//   1. At runtime (no redeploy): POST /api/admin/judges { paused: true } with the owner token
//      (`npm run judges -- pause` / `resume` / `status`). Stored as a flag file next to the SQLite DB.
//   2. Env: CALLOUT_JUDGES_PAUSED=1 forces it on regardless of the runtime flag.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.dirname(process.env.CALLOUT_DB ?? path.resolve(here, '../data/callout.sqlite'))
const FLAG = path.join(dataDir, 'judges-paused')

export const PAUSED_MESSAGE = 'Try it live is paused right now. Please watch the demo video, or check back later.'

let runtimePaused = existsSync(FLAG)

export const judgesPausedByEnv = () => process.env.CALLOUT_JUDGES_PAUSED === '1'
export const judgesPaused = () => judgesPausedByEnv() || runtimePaused

export function setJudgesPaused(paused: boolean) {
  runtimePaused = paused
  if (paused) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(FLAG, new Date().toISOString())
  } else rmSync(FLAG, { force: true })
}
