// SQLite persistence. Stores calls (allowlisted, call-like messages) and orders only, never chatter.
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.CALLOUT_DB ?? path.resolve(here, '../data/callout.sqlite')
mkdirSync(path.dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,          -- chat:message:version, or synthetic id
  chat_id     TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('long','short')),
  entry       REAL NOT NULL,
  stop        REAL NOT NULL,
  target      REAL NOT NULL,             -- first target (what the track record measures)
  sent_at     INTEGER NOT NULL,          -- ms epoch
  synthetic   INTEGER NOT NULL DEFAULT 0,
  outcome     TEXT,                      -- tp | sl | no_entry | open | ambiguous | expired
  outcome_at  INTEGER,
  checked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS calls_sender ON calls(sender_id);
CREATE TABLE IF NOT EXISTS orders (
  card_id       TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('open','close')),
  order_id      TEXT NOT NULL,
  order_link_id TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,
  qty           TEXT NOT NULL,
  avg_price     TEXT,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
`)

export interface CallRow {
  id: string
  chat_id: string
  sender_id: string
  sender_name: string
  symbol: string
  side: 'long' | 'short'
  entry: number
  stop: number
  target: number
  sent_at: number
  synthetic: number
  outcome: string | null
  outcome_at: number | null
  checked_at: number | null
}

const insertCallStmt = db.prepare(`
  INSERT OR IGNORE INTO calls (id, chat_id, sender_id, sender_name, symbol, side, entry, stop, target, sent_at, synthetic)
  VALUES (@id, @chat_id, @sender_id, @sender_name, @symbol, @side, @entry, @stop, @target, @sent_at, @synthetic)`)
export function insertCall(c: Omit<CallRow, 'outcome' | 'outcome_at' | 'checked_at'>): void {
  insertCallStmt.run(c)
}

const insertOrderStmt = db.prepare(`
  INSERT OR REPLACE INTO orders (card_id, kind, order_id, order_link_id, symbol, side, qty, avg_price, status, created_at)
  VALUES (@card_id, @kind, @order_id, @order_link_id, @symbol, @side, @qty, @avg_price, @status, @created_at)`)
export function insertOrder(o: {
  card_id: string; kind: 'open' | 'close'; order_id: string; order_link_id: string; symbol: string
  side: string; qty: string; avg_price: string | null; status: string; created_at: number
}): void {
  insertOrderStmt.run(o)
}

export function filledOpensSince(sinceMs: number): number {
  return (db.prepare(`SELECT COUNT(*) n FROM orders WHERE kind='open' AND status='Filled' AND created_at >= ?`).get(sinceMs) as { n: number }).n
}
