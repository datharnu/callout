# Callout

**Checks the call before you take it.**

Callout reads the Telegram trade-call groups you choose. It checks each call against the live market, the caller's track record and your own trading rules. Then it puts one card on your Even Realities G2 glasses. Tap once, or say "half size", "set stop 59.2k" or "skip", and the order goes to **Bybit Demo Trading**, with a cancel window, a real order ID on the glasses and a receipt posted back to Telegram.

> Callout executes the user's own confirmed decision, never the group's advice. **Not financial advice.** Demo money only: orders go to Bybit Demo Trading, and no user funds are held.

- **Tracks:** 03 Exchanges & Stocks (main), 01 Messaging & News. Also entered for Best Telegram integration.
- **Who it's for:** active crypto traders who follow Telegram call groups and trade on Bybit.
- **Status:** works end to end in the Even Hub simulator. A real Telegram call was placed on Bybit Demo from the glasses UI, with the receipt replied in the group. Voice commands work end to end through real speech-to-text (screenshots below).

| Call card | Scam call blocked | Cancel window |
|---|---|---|
| ![card](screenshots/30-card-with-record.png) | ![blocked](screenshots/12-scam-blocked.png) | ![countdown](screenshots/14-countdown.png) |
| **Filled from a live Telegram call** | **Holding update** | **Reduce-only close** |
| ![filled](screenshots/22-telegram-result.png) | ![holding](screenshots/32-holding.png) | ![closed](screenshots/34-closed.png) |
| **Voice: "set stop 59.7k"** | **Voice: "close it" (tap confirms)** | **Countdown: say "cancel"** |
| ![voice stop](screenshots/42-voice-set-stop.png) | ![voice close](screenshots/45-voice-holding-close.png) | ![voice countdown](screenshots/43-voice-countdown.png) |

## The problem

Call groups post hundreds of messages a day. A few matter, and many calls are bad or outright scams. Traders decide in seconds without knowing whether the price has already moved, whether the caller is any good, or whether the trade breaks their own rules.

Callout runs in **session mode**: start a trading session, keep Callout open, and step away from the screen without leaving the session. It does **not** alert you when the app is closed. G2 can't show anything then, and iOS suspends the app in the background.

## How it works

```
Telegram group ──► Callout backend ───────────────────────────────────────────► G2 glasses
                   1. GATE    chat + sender allowlist (user id or sender_chat id)
                   2. PARSE   Claude Haiku 5.5 → strict JSON, validated with zod
                              (extracts values only; never advises, never sets size)
                   3. CHECK   code only: symbol whitelist · SL/TP on the right side ·
                              entry within ±3% of Bybit MAINNET live price · every price
                              must literally appear in the message · scam wording/links ·
                              15-min expiry · your rules (trades/day, daily loss, loss streak)
                   4. SHOW    one card: parsed values + neutral facts + caller record
                   5. ACT     tap → re-check (price + rules) → 5 s cancel window →
                              re-check again → Bybit DEMO market order, 1x, caller's SL/TP
                              attached, deterministic orderLinkId
                   6. PROVE   real order ID + fill on the glasses → receipt reply in Telegram
```

### Cards on the glasses (576×288 monochrome, one text container)

| Card | What you see | Tap | Double-tap | Voice |
|---|---|---|---|---|
| Home / session | `CALLOUT · session on · 1 group` · `37 muted · 1 for you` · calls that expired while away · last result | none | exit | mic off |
| Call (ready) | sender (allowlisted), side/symbol/entry, SL/TP, R:R, live price and distance from call, caller record, expiry | **Place $200 demo** | skip | "half size", "full size", "set stop 59.2k", "place it"\*, "skip", "next" |
| Blocked | parsed values, raw text, factual flags such as `contains link · says "guaranteed"` or `price 4.1% from call` | skip (only option) | skip | "skip", "set stop 59k" (checks re-run) |
| Unsure | raw text + `Couldn't read this clearly` (no trade button) | skip | skip | "skip" |
| Holding | `"Taking profit on BTC"` · `Your BTC long 0.003 · +1.2%` | **Close (reduce-only)** | keep | "close it"\*, "keep it" |
| Countdown | progress bar + seconds left | cancel | cancel | "cancel" / "stop" / "wait" (anything but a clear "go ahead" cancels) |
| Result | `FILLED 0.003 BTC @ 60,740.8` · order ID · receipt status | continue | continue | "okay" |

\* Voice only selects Place and Close; a tap confirms. The bottom line of every card shows what the mic is doing (`mic · say: half size · set stop 59k · skip`) or what the last command did (`mic · Stop set to 59.7k (yours) · tap to place`).

Swipe moves between cards. Taps are ignored for 1 second after the screen changes, so a card that appears just as you tap can't be placed by accident. Labels are neutral: no ✓, and no "good" or "bad".

## Voice

Voice is built for the moment you have a call card in front of you and your hands are busy. It follows one rule: **voice picks, a tap confirms**.

| What you say | What happens |
|---|---|
| "half size" / "full size" | Order size becomes settings × ½ (or back to full), still under the cap. Refused if below the exchange minimum. |
| "set stop 59.2k" / "move stop to 59,200" / "stop loss fifty-nine thousand" | Your stop replaces the caller's and **every check re-runs**: a stop on the wrong side or already behind the price blocks the card; a valid stop can unblock a call that had none. The card shows `SL 59.2k (you)` and the new R:R. Spoken shorthand follows the entry's scale ("59.2" on a 60k entry → 59,200). |
| "place it" / "close it" | Selects the action and shows `tap to confirm`. **Voice never places or closes anything.** |
| "skip" / "keep it" / "okay" / "next" / "back" | Safe actions run immediately. |
| "half size, set stop 59.5k and place it" | **Several commands in one breath** are applied in order: the size and stop changes first, then one final action. The card shows `Half size $100 · Stop 59.5k (yours) · tap to place $100`. |
| "set stop" … (pause) … "59.5k" | People pause before numbers. An unfinished "set stop" shows `Stop at what price?` and the next 6 seconds of speech complete it. |
| "cancel" / "stop" / "wait" during the countdown | Cancels immediately. During the countdown **anything that isn't a clear "go ahead" cancels**, and negation always wins ("no, don't go" cancels). A wrong cancel costs nothing; a missed cancel places an order. |

**How it works**

- **Mic only while a card is on screen.** It's off on the home screen and while an order is being sent. It's opened with `audioControl` after the page is created, as the SDK requires.
- **On-device speech detection** (`glasses/src/vad.ts`) adapts to room noise and cuts single utterances (500 ms pre-roll, ends after 800 ms of silence, 6 s cap). Only finished utterances leave the glasses: nothing streams continuously. Frames the G2 marks as another speaker (`speakerRole: other`) are ignored.
- Each utterance goes to the card that was on screen when you started speaking. Utterances are processed in order, never dropped, and a card change discards anything half-heard or queued for the old card.
- If the mic delivers digital silence (for example, the OS blocked microphone permission), the card says `mic · no audio (check mic permission) · tap works` instead of pretending to listen.
- **Speech-to-text:** the backend sends the raw 16 kHz PCM to ElevenLabs Scribe (`scribe_v2`, its native `pcm_s16le_16` format, so nothing is re-encoded). The key stays on the backend. A warm, kept-alive connection gives **~0.5 s** transcription.
- **Recognition is biased toward safe words only** (skip, cancel, keep, okay…). An early version also biased toward "half size", and the eval caught a mumbled "pass" being heard as "half size". Now an unclear word can only drift toward something harmless.
- **Commands are matched in code** (`backend/src/voice/commands.ts`), not by an LLM, and depend on the card: "stop" means *cancel* during the countdown and *set my stop* on a call card. Spelled-out numbers are converted ("fifty-nine thousand two hundred" → 59,200). Negation drops a command ("don't place it").
- **Conversation is ignored.** In speech longer than a few words, command phrases must cover at least half of the meaningful words. Filler commands ("no", "ok", "yes") only count in a 1–3 word utterance. A live test caught a TV in the background: "…No, I don't. Me, we are fine…" had skipped a card. That speech is now ignored. (On G2 hardware, frames the glasses mark as another speaker are dropped before this.)
- **Privacy:** audio is never stored. The audit log keeps the transcript and what it did.

**Voice accuracy** (`npm run eval:voice`): 30 phrases (single commands, two-command sentences, and things that must *not* trigger anything) × 6 synthetic voices with US, UK, Australian, Irish, Indian and South African accents = 180 utterances through the real speech-to-text and interpreter.

**Risky misfires: 0** (a Place, Close, size or stop command that wasn't asked for, or a wrong stop price).

- Correct command(s): 171/180 (95.0%), including 12/12 two-command sentences. Every miss produced *no* command, and the card shows what to say.
- Non-commands correctly ignored: 24/24.
- Speech-to-text latency: median 468 ms, p90 643 ms.

We also tested by speaking into the simulator through a laptop microphone. That live test is what led to multi-command sentences, the "wait for the price" behavior, the longer pre-roll and pause, and the conversation filter.

Full report: [`backend/eval/VOICE_RESULTS.md`](backend/eval/VOICE_RESULTS.md). **Caveat:** synthetic speech (macOS voices), not a real G2 mic on a noisy street.

## Safety

| Risk | What Callout does |
|---|---|
| The AI recommends or sizes trades | The LLM only *extracts* values. Size comes from settings (default $200), with a configurable cap and a hard $1,000 cap in code. |
| Prompt injection / hostile members | All checks run in code on the LLM's output. Every entry/SL/TP must be traceable to numbers written in the message, so invented values are blocked. |
| Impersonation | Sender allowlist by Telegram user ID (or `sender_chat` ID for anonymous admins and channel posts). Everyone else is only ever counted as noise. |
| Stale trades | Calls expire after 15 min. The live price is re-checked at tap **and** again when the cancel window ends. |
| Duplicate orders | Deterministic `orderLinkId` per card. Bybit rejects a repeat (`110072`), and Callout only accepts an existing order if Bybit created it after the card existed. |
| A close that opens or flips a position | Closes are `reduceOnly`. Verified: an oversized close flattens without flipping, and a close while flat is rejected (`110017`). |
| Unprotected positions | The caller's SL and first TP are attached to the order. Leverage is set to 1x. |
| Breaking your own rules | Max trades per day, max daily loss and pause-after-N-losses are checked at card time and at confirm. If the stats can't be read, the card is blocked. |
| Edits | An edited message replaces any pending card for it and is re-parsed. It never touches an order that is already counting down or placed. |
| Voice | Voice can only *select* Place/Close (a tap confirms). Size and stop changes re-run every check. During the countdown, any unclear speech cancels. Commands are matched in code, not by an LLM. |
| Secrets | Exchange, Telegram, Anthropic and ElevenLabs keys live only in the backend `.env` (gitignored). A pre-commit hook in `.githooks/` blocks any commit containing a value from `.env`; enable it with `git config core.hooksPath .githooks`. The glasses app holds no secrets. |
| Privacy | Reads only allowlisted groups. Stores calls and orders, not chatter. Mic audio is never stored. Every card, state change, order and voice command (as text) goes to an audit log (`backend/logs/audit.jsonl`). |

## Accuracy

`npm run eval` runs a labeled set of **269 synthetic messages** (80% noise) through the production allowlist gate, the real parser and the code checks. The set covers: `92.4k` / `SL 90` shorthand, entry ranges, multiple targets, coin names, shorts, holding updates, scams, prompt injections, impersonators, edits, and price-heavy chatter that isn't a call. Whether a message *should* be tradable is not hand-labeled. It is derived by running the true values through the same checks against a fixed price snapshot.

**Unsafe one-tap cards: 0.** An unsafe card is one you could place with one tap whose values differ from the message, or that the checks should have blocked.

| Kind | Support | Precision | Recall |
|---|---|---|---|
| trade_call | 32 | 100.0% | 90.6% |
| holding_update | 8 | 88.9% | 100.0% |
| noise | 216 | 100.0% | 99.5% |
| unsure | 7 | 70.0% | 100.0% |

- Field accuracy on trade calls (symbol, side, entry, stop, targets): 100% each (29 calls).
- Tradable calls shown as tradable: 23/23. Non-allowlisted senders muted: 6/6.
- The misses are cautious ones: two scam-worded calls and one call with its stop on the wrong side were read as "unsure", which is never tradable.

Full report: [`backend/eval/RESULTS.md`](backend/eval/RESULTS.md). **Caveat:** the set was written by the same team that wrote the parser prompt, so treat these numbers as a smoke test, not a benchmark.

## Caller track record (synthetic)

For each call Callout sees, it walks **Bybit mainnet 1-minute candles** from the call time. The entry must be touched first; then whichever of TP or SL is hit first decides. If both fall inside the same candle, the call is "ambiguous". Calls with no entry within 7 days, or entered but unresolved after 7 days, are counted separately. The card shows counts and sample size, never a score: `Seen 11 · 3 TP · 6 SL · 2 open (synthetic)`.

- It only counts calls Callout saw. Callers can delete their bad calls.
- **The demo record is synthetic.** `npm run seed:track` invents calls with real past prices as entries at real timestamps from the last 30 days, so the outcomes are what the market really did. Seeded rows are flagged and the UI says "(synthetic)".

## Setup

**Prerequisites:** Node 20.17+ (or 22.13+), a Bybit account with Demo Trading enabled, a Telegram bot, an Anthropic API key, and an ElevenLabs API key (voice).

1. **Keys.** `cp .env.example .env`, run `git config core.hooksPath .githooks` (blocks committing secrets), and fill in:
   - `BYBIT_DEMO_API_KEY` / `BYBIT_DEMO_API_SECRET`: on bybit.com, switch to **Demo Trading**, then avatar → API. Live-account keys won't work.
   - `TELEGRAM_BOT_TOKEN`: from @BotFather. Run `/setprivacy` → **Disable**, add the bot to your group, then **remove it and add it back** (Telegram applies the privacy change only after a re-add).
   - `ANTHROPIC_API_KEY` (parser) and `ELEVENLABS_API_KEY` (speech-to-text).
2. **Install and verify.**
   ```bash
   cd backend && npm install
   npm run bybit:smoke -- --fund   # funds demo USDT, places + closes one order, checks dedupe/reduceOnly
   npm run tg:listen               # post a normal message in the group; note chat id + your user id
   ```
   Put the IDs in `TELEGRAM_ALLOWED_CHAT_IDS` and `TELEGRAM_ALLOWED_SENDER_IDS`.
3. **Run the backend.**
   ```bash
   npm run seed:track                    # optional: synthetic track record for the demo
   CALLOUT_DEMO_MODE=1 npm run dev       # API on http://127.0.0.1:8787 + Telegram bot
   ```
4. **Run the glasses app in the simulator.**
   ```bash
   cd glasses && npm install
   npm run dev        # Vite on :5173
   npm run simulate   # Even Hub simulator (automation API on :9898)
   ```
   Post a call in your group (for example `LONG BTC entry 60.7k SL 59.5k TP 63.2k`, using a price near the current one). The card appears on the glasses; tap to place it on Bybit Demo, or speak to it (the simulator uses your computer's microphone).

**Checks:**

```bash
cd backend
npm test             # 53 unit tests (checks, track record, rules, voice commands)
npm run e2e:safety   # 12 live safety scenarios against the running backend (places no orders)
npm run e2e:voice    # 17 spoken-command scenarios, real speech-to-text (macOS; places no orders)
npm run eval         # labeled-set accuracy (about 260 Haiku calls, a few cents)
npm run eval:voice   # voice accuracy, 180 utterances in 6 accents (macOS)
npm run positions    # list demo positions;  -- --close  closes them reduce-only
cd ../glasses && npm test   # 8 speech-detection (VAD) tests
```

### Settings

All optional, set in `.env`: `CALLOUT_SIZE_USD` (200), `CALLOUT_MAX_SIZE_USD` (500), `CALLOUT_MAX_TRADES_PER_DAY` (5), `CALLOUT_MAX_DAILY_LOSS_USD` (50), `CALLOUT_PAUSE_AFTER_LOSSES` (2), `CALLOUT_SYMBOLS`, `CALLOUT_MAX_ENTRY_DISTANCE_PCT` (3), `CALLOUT_CALL_EXPIRY_MIN` (15), `CALLOUT_CANCEL_WINDOW_SEC` (5). Set a rule to `0` to disable it. See [`.env.example`](.env.example).

## Project layout

```
backend/
  src/
    pipeline.ts     gate → parse → checks → card; edits; expiry sweep
    ai/parse.ts     Claude Haiku 5.5 structured extraction (zod schema in types.ts)
    checks.ts       pure code checks (unit-tested)
    rules.ts        user rules from Bybit Demo closed P&L
    executor.ts     confirm → re-check → cancel window → order → fill → receipt
    track.ts        caller track record from mainnet 1-minute candles
    positions.ts    demo positions + reduce-only close
    bybit/          signed Demo client (refuses non-demo URLs) + mainnet public data
    telegram.ts     grammY bot: messages/edits in, receipts out
    server.ts       HTTP API for the glasses (127.0.0.1 only)
    db.ts           SQLite: calls + orders
    voice/          stt.ts (ElevenLabs Scribe), commands.ts (transcript → command), apply.ts
  eval/             labeled set + accuracy runner + RESULTS.md
  scripts/          Bybit smoke test, Telegram listener, e2e safety, seed, positions
  test/             unit tests
glasses/            Even Hub app (Vite + TypeScript): screens.ts renders, main.ts handles input + mic, vad.ts cuts utterances
screenshots/        simulator captures
```

## What existed before Nov 23

Nothing in this repository was written before the build week. The git history starts on Nov 26, 2026. Third-party starting points:

- `glasses/` began from the official **Even Hub minimal template** (`npx degit even-realities/evenhub-templates/minimal`). We upgraded its dependencies and replaced `src/` with Callout's screens and input handling. Its MIT notice is in [`glasses/THIRD_PARTY_NOTICES.md`](glasses/THIRD_PARTY_NOTICES.md).
- Libraries: `@evenrealities/even_hub_sdk`, simulator and CLI; `@anthropic-ai/sdk`; `grammy`; `fastify`; `zod`; `better-sqlite3`; `undici`. Speech-to-text is the ElevenLabs API.

## Limitations

- **Simulator only.** Not yet tested on physical G2 hardware. Font rendering and input can differ on the real device.
- **Bot, not user account.** The bot reads groups it has been added to. It can't read channels you follow but don't administer (Telegram user login via MTProto is on the roadmap).
- **No background alerts.** Session mode only: Callout works while the app is open.
- **Runs locally.** The API binds to `127.0.0.1` and has no pairing or authentication yet, so the backend and the simulator must run on the same machine. Public hosting needs pairing first.
- **Synthetic track record.** The demo record is invented (real prices, invented calls). Real records only count calls Callout saw.
- **Demo money only.** Bybit Demo fills don't reflect real liquidity or slippage.
- **Pending cards live in memory.** A backend restart drops cards waiting for a tap (they expire within 15 min anyway). Calls and orders persist in SQLite.
- **Scam flags are keyword- and pattern-based**, and worded as facts. They are not a classifier.
- **One target attached.** Only the first TP is attached to the order and used for the track record. Holding cards close the whole position (no partial "secure 50%").
- **Rules use the UTC day.** Daily loss comes from Bybit Demo closed P&L.
- **Small, self-authored eval set** (see the accuracy caveat above).
- **Voice not yet tested on the G2 microphone.** Tested with 6 synthetic voices through real speech-to-text, and live by a person speaking into the simulator through a laptop mic. English only. Needs a network connection.
- **Speech goes to a third party.** Short utterances (only while a card is shown) are sent to ElevenLabs for transcription. Callout itself stores no audio.

## Feature requests

1. **Telegram:** read-only bot access to public channels without admin rights.
2. **Even Hub:** a priority glance alert while the app is in the background.
3. **Even Hub:** font size control.
4. **Bybit:** order-fill webhooks on Demo and testnet.
5. **Bybit:** document that Demo Trading supports `orderLinkId` deduplication (`110072`) and `reduceOnly` (`110017` when flat). We verified both by hand, but the Demo docs don't mention them.


## License

Copyright (c) 2026 datharnu. **All rights reserved.** The code is public so it can be evaluated for the Heads Up hackathon: you may view it and run it to evaluate the submission, but not copy, modify or redistribute it without written permission. Template-derived files in `glasses/` keep their MIT license ([notice](glasses/THIRD_PARTY_NOTICES.md)). See [LICENSE](LICENSE).
