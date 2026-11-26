// Loads the single repo-root .env (gitignored). Secrets live only here, never in the glasses app.
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '../../.env'), quiet: true })

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`Missing ${name}. Add it to the repo-root .env (see .env.example).`)
    process.exit(1)
  }
  return v
}
