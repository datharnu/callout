# Test report

Every suite Callout has, with the exact command, when it last ran and what it showed. All results below are real
runs, not targets. Orders only ever go to **Bybit Demo Trading** (Bybit's paper-trading environment).

| Suite | Command | What it proves | Last run | Result |
|---|---|---|---|---|
| Backend unit tests | `cd backend && npm test` | Code checks, user rules, track record, voice command matching, judge sandboxes, kill switch, stale taps, `/pair` guard, link tricks, owner rules from Telegram | 2026-11-27 (also on every push, see the **tests** badge) | **66 / 66** pass, with no API keys |
| Glasses unit tests | `cd glasses && npm test` | On-device speech detection, the browser-preview bridge, session token handling, the standalone `.ehpk` session | 2026-11-27 (every push) | **22 / 22** pass |
| Live judge mode | `CALLOUT_API=https://callout-production-049324a2.up.railway.app npm run e2e:judge` | Against the **hosted** server with real Bybit Demo orders: three isolated sessions, two judges filling in parallel on different coins, same-coin refusal, one position per judge, reduce-only close, auto-close after 2 min, per-judge daily counts | 2026-11-27, twice (after each deploy) | **16 / 16** |
| Owner safety | `npm run e2e:safety` (backend running) | Clean call ready; tap starts the cancel window; cancel inside it sends nothing and can't be re-confirmed; scam blocked with factual flags; prompt injection never tradable; non-allowlisted sender, vague message and chatter muted or not tradable; stale entry blocked; calls older than 15 min expired; an edit supersedes the pending card. Places no orders | 2026-11-27 | **12 / 12** |
| Voice end to end | `npm run e2e:voice` (backend running, macOS) | Spoken commands through real speech-to-text into the running backend: half/full size; set stop (checks re-run, a wrong-side stop blocks, fixing it unblocks); two commands in one sentence; "set stop", a pause, then the price; "place it" only selects; "cancel" during the countdown; skip, dismiss, unclear and too-short audio. Places no orders | 2026-11-27 | **17 / 17** |
| Message accuracy | `npm run eval` | 269 labelled messages through the production allowlist, parser (Claude Haiku) and checks | 2026-11-27 | **0 unsafe one-tap cards**; full table in [`backend/eval/RESULTS.md`](../backend/eval/RESULTS.md) |
| Red team | `npm run eval:redteam` | 46 hostile messages from a hacked caller's account: prompt injection, missing or absurd values, scams, disguised and hidden links | 2026-11-27 | **0 / 46 got through** (the first run found 6 disguised-link gaps; fixed, see [`backend/eval/REDTEAM.md`](../backend/eval/REDTEAM.md)) |
| Voice accuracy | `npm run eval:voice` (macOS) | 30 phrases × 6 accents = 180 utterances through real speech-to-text and the interpreter | 2026-11-26 | **0 risky misfires**, 95% correct, median 468 ms; [`backend/eval/VOICE_RESULTS.md`](../backend/eval/VOICE_RESULTS.md) |
| Official simulator, live server | manual, Even Hub simulator 0.9.5 | The standalone `.ehpk` build: own session → "Tap: send a sample call" → card → tap → filled on Bybit Demo (`…e1771f5b`), then auto-closed | 2026-11-27 | pass |
| Browser preview, live server | headless Chrome on `/try` | Sample call → "Tap to place $100 demo order" → filled (`…f70bf646`) in about 8 s, then auto-closed | 2026-11-27 | pass |
| Telegram, live | manual, real group and bot | `/pair` from a phone links the session; a call posted in the group becomes a card; the receipt replies in the thread (`…c8bf8df8`, close `…a1255735`) | 2026-11-27 | pass |
| One order, three places | manual, recorded in the demo video | The same order ID on the glasses, in Bybit's Order History and in the Telegram receipt (`5b8cf401`) | 2026-11-26 | pass ([proof](../README.md#proof-one-real-order-three-places)) |

## What is not tested

- **Physical G2 hardware.** Everything above ran in the official Even Hub simulator or the browser preview. Fonts, input and the glasses microphone may differ on the real device.
- **Real money.** Out of scope by design: Bybit Demo only.
- **New attack shapes.** The red-team set and the labelled set were written by us. They catch the known patterns; they are not proof against new ones.

## How to reproduce

```bash
cd backend && npm ci && npm test            # no keys needed
cd ../glasses && npm ci && npm test
# with keys in the repo-root .env (see .env.example) and the backend running:
cd ../backend && npm run e2e:safety && npm run e2e:voice
CALLOUT_API=https://callout-production-049324a2.up.railway.app npm run e2e:judge   # the hosted server, real Demo orders
npm run eval && npm run eval:redteam        # about 300 Claude Haiku calls, a few cents
```
