// HTTP API + the hosted site, one origin (see docs/HOSTED.md).
// Every /api call is scoped to a sandbox: the owner (from .env) or a judge session from the site.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { ingest } from './pipeline.js'
import { ActionError, cancel, confirm, dismiss, skip } from './executor.js'
import { isActive } from './store.js'
import { handleVoice } from './voice/apply.js'
import { filledOpensSince } from './db.js'
import { startOfUtcDay } from './rules.js'
import { hintFor } from './voice/commands.js'
import { MAX_AUDIO_MS, pcmDurationMs } from './voice/stt.js'
import { livePrice } from './market.js'
import { budgetLeft } from './budget.js'
import {
  byTokenOrNull, createJudge, demoAdminId, JUDGE, JUDGE_AUTO_CLOSE_MS, judgePosition, newPairCode, owner, ownerTokenConfigured,
  quotaLeft, takeQuota, type Sandbox,
} from './sandbox.js'
import { group } from './telegram.js'
import type { Card } from './types.js'

declare module 'fastify' {
  interface FastifyRequest {
    sandbox: Sandbox
  }
}

const RESULT_STATES: Card['state'][] = ['filled', 'failed', 'cancelled']
const NOTICE_MS = 8000

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
    userStop: c.userStop ?? null,
    voice: c.voice ?? null,
    voiceHint: hintFor({ state: c.state, action: c.action }),
    record: c.record ?? null,
    notice: c.notice && c.noticeAt && Date.now() - c.noticeAt < NOTICE_MS ? c.notice : null,
    error: c.state === 'failed' ? (c.error ?? null) : null,
  }
}
export type CardView = ReturnType<typeof cardView>

export function stateView(sb: Sandbox) {
  const all = [...sb.cards.values()].sort((a, b) => b.createdAt - a.createdAt)
  const visible = all.filter(c => isActive(c) || (RESULT_STATES.includes(c.state) && !c.dismissed))
  return {
    now: Date.now(),
    session: {
      groups: sb.allow.chats.size,
      muted: sb.session.muted,
      forYou: all.filter(c => c.state === 'ready' || c.state === 'holding').length,
      expired: sb.session.expired,
      last: sb.session.lastResult,
    },
    cards: visible.map(cardView),
  }
}

// ── auth ─────────────────────────────────────────────────────────────────────────────────────
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** A direct request from this machine (not through a proxy, which would add X-Forwarded-For). */
const isLocalDirect = (req: FastifyRequest) => LOCAL.has(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for']
const clientIp = (req: FastifyRequest) => String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0]!.trim()

function tokenOf(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) return h.slice(7).trim()
  const q = (req.query as Record<string, string> | undefined)?.s
  return q || undefined
}

const sandboxCreations = new Map<string, number[]>() // ip → timestamps (10 per hour)

// ── judge sample calls ───────────────────────────────────────────────────────────────────────
const SAMPLE_KINDS = ['clean', 'scam', 'impostor', 'vague', 'far', 'holding', 'chatter'] as const
type SampleKind = (typeof SAMPLE_KINDS)[number]
const r100 = (v: number) => Math.round(v / 100) * 100
const k1 = (v: number) => `${Number((v / 1000).toFixed(1))}k`

async function sampleMessage(kind: SampleKind): Promise<{ text: string; senderId: string; senderName: string }> {
  const px = (await livePrice('BTCUSDT', 2000)) ?? 60000
  const [E, S, T] = [r100(px), r100(px * 0.98), r100(px * 1.04)]
  const admin = { senderId: demoAdminId, senderName: '@CalloutAdmin' }
  switch (kind) {
    case 'clean': return { ...admin, text: `LONG BTC entry ${k1(E)} SL ${k1(S)} TP ${k1(T)}` }
    case 'scam': return { ...admin, text: `🔥 GUARANTEED 100% WIN 🔥 LONG BTC ${E} SL ${S} TP ${T} join t.me/vip_pumps` }
    case 'impostor': return { senderId: 'impostor-0', senderName: '@CalIoutAdmin', text: `LONG BTC entry ${k1(E)} SL ${k1(S)} TP ${k1(T)}` }
    case 'vague': return { ...admin, text: 'btc looking spicy here 👀 might long soon, levels later' }
    case 'far': return { ...admin, text: `LONG BTC entry ${k1(r100(px * 0.9))} SL ${k1(r100(px * 0.88))} TP ${k1(r100(px * 0.95))}` }
    case 'holding': return { ...admin, text: 'Taking profit on BTC here, closing the long' }
    case 'chatter': return { ...admin, text: 'gm everyone, coffee first ☕ charts later' }
  }
}

function fail(reply: FastifyReply, e: unknown) {
  const code = e instanceof ActionError ? e.code : ((e as { status?: number }).status ?? 500)
  return reply.code(code).send({ error: (e as Error).message })
}

export async function startServer() {
  const app = Fastify({ logger: false, trustProxy: true })
  app.decorateRequest('sandbox', null as unknown as Sandbox)
  await app.register(cors, {
    origin: (process.env.CALLOUT_CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),
  })

  // Raw 16 kHz s16le mono PCM from the glasses mic (one utterance, cut by on-device VAD).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_req, body, done) =>
    done(null, body),
  )

  // Resolve the sandbox for every /api call except health and sandbox creation.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!
    if (!url.startsWith('/api/') || url === '/api/health' || (url === '/api/sandbox' && req.method === 'POST')) return
    const token = tokenOf(req)
    // A wrong token is always refused; only a request with NO token, made directly on this machine
    // while no owner token is configured, counts as the owner (local dev and scripts).
    const sb = token ? byTokenOrNull(token) : !ownerTokenConfigured && isLocalDirect(req) ? owner : null
    if (!sb) return reply.code(401).send({ error: 'unknown or missing session token' })
    req.sandbox = sb
  })

  app.get('/api/health', async () => ({ ok: true }))

  app.post('/api/sandbox', async (req, reply) => {
    const ip = clientIp(req)
    const hourAgo = Date.now() - 3_600_000
    const recent = (sandboxCreations.get(ip) ?? []).filter(t => t > hourAgo)
    if (recent.length >= 10) return reply.code(429).send({ error: 'too many sessions from this address, try again later' })
    try {
      const sb = createJudge()
      sandboxCreations.set(ip, [...recent, Date.now()])
      return { token: sb.token, sandboxId: sb.id, expiresAt: sb.lastSeen + JUDGE.idleExpiryMs }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get('/api/state', async req => stateView(req.sandbox))

  // Read-only view of this sandbox's settings, rule counters and remaining judge quotas (no secrets).
  app.get('/api/settings', async req => {
    const sb = req.sandbox
    const j = judgePosition.current
    return {
      kind: sb.kind,
      sizeUsd: sb.sizeUsd,
      maxSizeUsd: config.maxSizeUsd,
      rules: sb.rules,
      tradesToday: filledOpensSince(startOfUtcDay(), sb.id),
      cancelWindowMs: config.cancelWindowMs,
      callExpiryMin: config.callExpiryMs / 60_000,
      demoMode: config.demoMode,
      telegram: sb.telegram ? { linked: true, name: sb.telegram.name } : { linked: false },
      ...(sb.kind === 'judge'
        ? {
            limits: { ...quotaLeft(sb), ...budgetLeft() },
            judgePosition: j ? { mine: j.sandboxId === sb.id, closesInSec: Math.max(0, Math.ceil((j.openedAt + JUDGE_AUTO_CLOSE_MS - Date.now()) / 1000)) } : null,
          }
        : {}),
    }
  })

  app.post<{ Params: { id: string }; Body: Buffer }>('/api/cards/:id/voice', async (req, reply) => {
    const pcm = req.body
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return reply.code(400).send({ error: 'send raw PCM as application/octet-stream' })
    if (pcmDurationMs(pcm.length) > MAX_AUDIO_MS) return reply.code(413).send({ error: 'utterance too long' })
    try {
      const r = await handleVoice(req.sandbox, req.params.id, pcm)
      const card = req.sandbox.cards.get(req.params.id)
      return { ...r, card: card ? cardView(card) : null }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { id: string; action: string } }>('/api/cards/:id/:action', async (req, reply) => {
    const { id, action } = req.params
    const sb = req.sandbox
    try {
      const card =
        action === 'confirm' ? await confirm(sb, id)
        : action === 'cancel' ? cancel(sb, id)
        : action === 'skip' ? skip(sb, id)
        : action === 'dismiss' ? dismiss(sb, id)
        : null
      if (!card) return reply.code(400).send({ error: `unknown action ${action}` })
      return cardView(card)
    } catch (e) {
      return fail(reply, e)
    }
  })

  // Judge panel: a sample message through the real pipeline (real parser, real checks, live prices).
  let sampleId = Date.now()
  app.post<{ Body: { kind?: string } }>('/api/judge/sample', async (req, reply) => {
    const kind = req.body?.kind as SampleKind
    if (!SAMPLE_KINDS.includes(kind)) return reply.code(400).send({ error: `kind must be one of ${SAMPLE_KINDS.join(', ')}` })
    if (!takeQuota(req.sandbox, 'samples')) return reply.code(429).send({ error: `sample limit reached (${JUDGE.samplesPerHour} per hour)` })
    const m = await sampleMessage(kind)
    const r = await ingest(
      { chatId: [...config.allowedChatIds][0] ?? 'demo', chatTitle: 'Judge sample', messageId: sampleId++, ...m, sentAt: Date.now(), source: 'replay' },
      req.sandbox,
    )
    return { kind, text: m.text, sender: m.senderName, ...(r.outcome === 'card' ? { outcome: 'card', card: cardView(r.card) } : r) }
  })

  // Telegram pairing: the site shows a code; the judge sends `/pair <code>` in the group.
  app.post('/api/pair', async req => {
    const p = newPairCode(req.sandbox)
    return {
      code: p.code, expiresAt: p.expiresAt, command: `/pair ${p.code}`,
      group: { title: group.title, ...(group.inviteUrl ? { inviteUrl: group.inviteUrl } : {}) },
    }
  })
  app.get('/api/pair', async req => ({ linked: !!req.sandbox.telegram, ...(req.sandbox.telegram ? { telegram: req.sandbox.telegram.name } : {}) }))

  // Owner-only replay (scripts, e2e tests, video capture): bots can't see other bots' messages.
  if (config.demoMode) {
    let nextId = Date.now() // unique across restarts (Telegram ids are far smaller)
    app.post<{
      Body: { text: string; senderId?: string; chatId?: string; messageId?: number; sentAt?: number; senderName?: string }
    }>('/api/demo/message', async (req, reply) => {
      if (req.sandbox.kind !== 'owner') return reply.code(403).send({ error: 'owner only; judges use /api/judge/sample' })
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
      }, req.sandbox)
      return r.outcome === 'card' ? { outcome: 'card', card: cardView(r.card) } : r
    })
  }

  // ── The hosted site (served only when the builds exist) ───────────────────────────────────
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const webDist = path.join(root, 'web', 'dist')
  const glassesDist = path.join(root, 'glasses', 'dist')
  const media = path.join(root, 'docs', 'media')
  if (existsSync(glassesDist)) await app.register(fastifyStatic, { root: glassesDist, prefix: '/glasses/', decorateReply: false })
  if (existsSync(media)) await app.register(fastifyStatic, { root: media, prefix: '/media/', decorateReply: false })
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true })
    // Client-side routes (/try, …) fall back to the right HTML entry.
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0]!
      if (req.method !== 'GET' || url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
      const page = url.replace(/^\/+|\/+$/g, '')
      for (const f of [`${page}/index.html`, `${page}.html`]) if (page && existsSync(path.join(webDist, f))) return reply.sendFile(f)
      return reply.sendFile('index.html')
    })
  }

  const host = process.env.HOST ?? '127.0.0.1'
  await app.listen({ host, port: config.port })
  console.log(`[api] http://${host}:${config.port}${config.demoMode ? ' · demo replay ON' : ''}${existsSync(webDist) ? ' · site ON' : ''}`)
}
