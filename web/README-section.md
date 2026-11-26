## Try it online

The hosted site serves everything from one origin (see [`docs/HOSTED.md`](../docs/HOSTED.md)):

| Path | What it is |
|---|---|
| `/` | Landing page: the problem, how a call becomes an order, the proof (one order ID in three places), voice, safety, the synthetic caller record, FAQ |
| `/try/` | **Browser G2 preview.** The real Callout glasses app runs in an iframe; the page draws its 576×288 display and stands in for the touchpads, the R1 ring and the microphone |
| `/glasses/` | The glasses app itself, for the official Even Hub simulator and the `.ehpk` |

**On `/try/` a judge gets their own sandbox** (a random token kept in the browser), then can:

- **Send a call:** admin call, scam, impostor, vague message, stale price, taking profit, chatter. Each one goes through the same parser and checks as a Telegram message.
- **Act on the card:** Tap (Enter), Double-tap (Esc), Swipe (↑/↓), and the microphone (M): "half size", "set stop 59.2k", "place it", "skip", "cancel". The browser mic is resampled to 16 kHz 16-bit mono, the G2 mic format, and goes through the same on-glasses speech detection.
- **Place a real Bybit Demo order:** tap, 5-second cancel window, fill with a real order ID. Judge orders are small, one is open at a time, and they are closed automatically (reduce-only).
- **Post a real call in Telegram:** get a code, send `/pair 123456` in the Callout group, then post a call. It lands on that judge's card only.
- **Open the same sandbox in the official simulator:** `npx @evenrealities/evenhub-simulator "<site>/glasses/?s=<token>"`.

**How the same app runs in three places.** The glasses app talks to a two-implementation `Bridge` (`glasses/src/bridge.ts`):

- **`EvenBridge`** wraps the Even Hub SDK (Even app, official simulator, real G2), including the rebuild-after-reload fallback.
- **`PreviewBridge`** uses `postMessage` to the `/try/` page. It's active only with `?preview=1` and no Even app host, and it accepts messages only from the same origin and the parent window.

Everything else (screens, voice detection, API calls) is identical.

**Build:**

```bash
cd glasses && npm run build   # → glasses/dist (served at /glasses/)
cd web && npm install && npm run build   # → web/dist (served at / and /try/)
```

For a local preview of the hosted layout without the backend's static serving: `node web/scripts/serve-local.mjs 5190` (proxies `/api` to `127.0.0.1:8787`).
