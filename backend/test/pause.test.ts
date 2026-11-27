import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'callout-pause-'))
process.env.CALLOUT_DB = path.join(dir, 'callout.sqlite')
delete process.env.CALLOUT_JUDGES_PAUSED
const { judgesPaused, setJudgesPaused } = await import('../src/pause.js')

test('kill switch: pause persists as a flag file, resume removes it, env forces it on', () => {
  assert.equal(judgesPaused(), false)
  setJudgesPaused(true)
  assert.equal(judgesPaused(), true)
  assert.ok(existsSync(path.join(dir, 'judges-paused')))
  setJudgesPaused(false)
  assert.equal(judgesPaused(), false)
  assert.ok(!existsSync(path.join(dir, 'judges-paused')))
  process.env.CALLOUT_JUDGES_PAUSED = '1'
  assert.equal(judgesPaused(), true)
  delete process.env.CALLOUT_JUDGES_PAUSED
})
