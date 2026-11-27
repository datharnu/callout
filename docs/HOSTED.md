# Hosted Callout: architecture and API contract

One Railway service serves everything from one origin (no CORS between our own parts):

| Path | What |
|---|---|
| `/` | Landing page (`web/`, Vite + React + motion, built to static files) |
| `/try` | Browser G2 preview: the real glasses app in an iframe + G2 display, touch/ring buttons, mic, judge panel |
| `/glasses/` | The glasses app build (`glasses/`, base `./`). Loaded by the browser preview, by the official Even Hub simulator, and by the `.ehpk` |
| `/api/*` | The Callout backend (Fastify) |

## Sandboxes and auth

Every visitor works in their own **sandbox**: their own cards, session counters, daily limits and open demo order. The owner's
sandbox is configured from `.env` (allowlisted Telegram group + senders), exactly as today.

- `POST /api/sandbox` → `{ token, sandboxId, expiresAt }`. Creates a judge sandbox (rate-limited per IP). The token is a random
  secret; store it in `localStorage` (`callout.token`).
- Every other `/api/*` call (except `/api/health`) needs `Authorization: Bearer <token>`. Missing/unknown token → `401`.
- The glasses app reads the token from the URL (`/glasses/?s=<token>`) on first load, stores it, and sends it on every call.
- The owner token comes from `CALLOUT_OWNER_TOKEN` (backend env). Locally, with no token configured, the backend accepts
  token-less requests from 127.0.0.1 as the owner (keeps `npm run dev` and all existing scripts working).

## Endpoints (all relative to the same origin, JSON unless noted)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok: true }` |
| POST | `/api/sandbox` | | `{ token, sandboxId, expiresAt }` |
| GET | `/api/state` | | same shape as today (`now`, `session`, `cards[]`), scoped to the sandbox |
| GET | `/api/settings` | | sizes, rules, `tradesToday` for this sandbox, `limits` (remaining judge quotas) |
| POST | `/api/cards/:id/:action` | | `action` ∈ confirm, cancel, skip, dismiss → card view |
| POST | `/api/cards/:id/voice` | raw 16 kHz s16le mono PCM (`application/octet-stream`) | `{ heard, commands, note, navigate?, card }` |
| POST | `/api/judge/sample` | `{ kind }`, kind ∈ `clean`, `scam`, `impostor`, `vague`, `far`, `holding`, `chatter` | the ingest result (`{ outcome, card? , reason? }`) |
| POST | `/api/pair` | | `{ code, expiresAt, group: { title, inviteUrl? } }`: a 6-digit code for this sandbox |
| GET | `/api/pair` | | `{ linked: boolean, telegram?: string }` |

Telegram: in the Callout group, a judge sends `/pair 123456`. The bot links that Telegram user to the sandbox. From then on,
calls that user posts in the group become cards **in that sandbox only** (that user is the sandbox's allowlisted caller),
and receipts reply in the group. Unpaired senders are ignored, as before.

## Judge safety caps (backend-enforced)

- Judges share the owner's Bybit Demo account, which keeps one position per coin. So each judge gets their own coin
  (ETH, SOL, XRP, DOGE, LINK, AVAX, ADA, BNB, TON, BTC last): up to ~9 judges trade at the same time without sharing a
  position. One open position per judge and per coin; each is closed reduce-only automatically after 120 s. Sample
  calls use the judge's coin at its live price (`POST /api/judge/sample { kind, coin? }`).
- Per sandbox: 3 orders per day, 30 sample calls per hour, 40 voice commands per hour.
- Global daily ceilings on parser (LLM) and speech-to-text calls; when reached, cards say so and taps still work.
- Order size for judge sandboxes: $100 (half size $50 refused if below the exchange minimum, as today).

## Browser preview bridge (iframe `/glasses/?s=<token>&preview=1` inside `/try`)

The glasses app talks to a small `Bridge` interface. In the Even app / official simulator it is the Even Hub SDK; in the
browser preview it is `postMessage` to the parent page:

| Direction | Message |
|---|---|
| glasses → parent | `{ type: 'callout:display', content: string }` (page created or text updated) |
| glasses → parent | `{ type: 'callout:mic', on: boolean }` |
| parent → glasses | `{ type: 'callout:input', action: 'click' \| 'double_click' \| 'up' \| 'down' }` |
| parent → glasses | `{ type: 'callout:audio', pcm: ArrayBuffer }` (16 kHz s16le mono, any frame size) |

Only messages from the same origin are accepted.
