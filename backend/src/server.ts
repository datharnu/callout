// HTTP API for the glasses app. Bound to 127.0.0.1 by default: no auth/pairing yet,
// so it must not be exposed publicly until a glasses-to-user pairing step exists.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { ingest } from './pipeline.js'
import { ActionError, cancel, confirm, dismiss, skip } from './executor.js'
import { cards, isActive, session } from './store.js'
import type { Card } from './types.js'

const RESULT_STATES: Card['state'][] = ['filled', 'failed', 'cancelled']

export function cardView(c: Card) {
  const p = c.parsed
  return {
    id: c.id,
    action: c.action,
    state: c.state,
    edited: !!c.edited,
    sender: c.msg.senderName,
    allowlisted: true, // only allowlisted senders ever produce cards
    chat: c.msg.chatTitle,
    kind: p?.kind,
    symbol: p?.symbol ?? null,
    side: p?.side ?? null,
    entry: p?.entry ?? null,
    stop: p?.stop ?? null,
    targets: p?.targets ?? [],
    rr: c.facts.rr ?? null,
    livePrice: c.facts.livePrice ?? null,
    distancePct: c.facts.distancePct ?? null,
    flags: c.flags,
    raw: c.msg.text.slice(0, 160),
    sizeUsd: c.sizeUsd,
    expiresAt: c.expiresAt,
    countdownEndsAt: c.countdownEndsAt ?? null,
    cancelWindowMs: config.cancelWindowMs,
    order: c.order ?? null,
    position: c.position ?? null,
    record: c.record ?? null,
    error: c.state === 'failed' ? (c.error ?? null) : null,
  }
}
export type CardView = ReturnType<typeof cardView>

export function stateView() {
  const all = [...cards.values()].sort((a, b) => b.createdAt - a.createdAt)
  const visible = all.filter(c => isActive(c) || (RESULT_STATES.includes(c.state) && !c.dismissed))
  return {
    now: Date.now(),
    session: {
      groups: config.allowedChatIds.size,
      muted: session.muted,
      forYou: all.filter(c => c.state === 'ready' || c.state === 'holding').length,
      expired: session.expired,
      last: session.lastResult,
    },
    cards: visible.map(cardView),
  }
}

export async function startServer() {
  const app = Fastify({ logger: false })
  await app.register(cors, {
    origin: (process.env.CALLOUT_CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),
  })

  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/state', async () => stateView())

  app.post<{ Params: { id: string; action: string } }>('/api/cards/:id/:action', async (req, reply) => {
    const { id, action } = req.params
    try {
      const card =
        action === 'confirm' ? await confirm(id)
        : action === 'cancel' ? cancel(id)
        : action === 'skip' ? skip(id)
        : action === 'dismiss' ? dismiss(id)
        : null
      if (!card) return reply.code(400).send({ error: `unknown action ${action}` })
      return cardView(card)
    } catch (e) {
      const code = e instanceof ActionError ? e.code : 500
      return reply.code(code).send({ error: (e as Error).message })
    }
  })

  // Demo/replay: push a message straight into the pipeline (bots can't see other bots' messages).
  if (config.demoMode) {
    let nextId = Date.now() // unique across restarts (Telegram ids are far smaller)
    app.post<{
      Body: { text: string; senderId?: string; chatId?: string; messageId?: number; sentAt?: number; senderName?: string }
    }>('/api/demo/message', async req => {
      const b = req.body
      const r = await ingest({
        chatId: b.chatId ?? [...config.allowedChatIds][0] ?? 'demo',
        chatTitle: 'Demo replay',
        messageId: b.messageId ?? nextId++,
        senderId: b.senderId ?? [...config.allowedSenderIds][0] ?? 'demo',
        senderName: b.senderName ?? 'demo-admin',
        text: b.text,
        sentAt: b.sentAt ?? Date.now(),
        source: 'replay',
      })
      return r.outcome === 'card' ? { outcome: 'card', card: cardView(r.card) } : r
    })
  }

  const host = process.env.HOST ?? '127.0.0.1'
  await app.listen({ host, port: config.port })
  console.log(`[api] http://${host}:${config.port}${config.demoMode ? ' · demo replay ON' : ''}`)
}
