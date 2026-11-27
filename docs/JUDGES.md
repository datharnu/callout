# Judging Callout in 2 minutes

Three ways to try it, from fastest to closest to the real thing. All orders go to **Bybit Demo Trading** (paper
trading, no real money). Several judges can test at the same time: each gets a private session and their own coin.

## 1 · In your browser (no install, about 2 minutes)

Open **https://callout-production-049324a2.up.railway.app/try/**

1. Press **Send a sample call**. A call arrives as a Telegram message and a card appears on the G2 display.
2. Press the green **Tap to place $100 demo order** (or Enter). Optional first: turn on the microphone and say **"half size"**.
3. Wait out the 5-second cancel window. The glasses show **FILLED** with the Bybit Demo order ID. The position closes by itself after 2 minutes.
4. Under **Try a tricky one**, press **Scam**, **Impostor**, **Vague** or **Stale price** to see Callout refuse, with the reasons.

## 2 · From your own Telegram (about 2 minutes)

On the same page, open **Connect your Telegram**:

1. **Get my code**, then **Pair in one tap**: Telegram opens a private chat with the bot, you press **Start**, and you're linked. (Or send `/pair 123456` to the bot or in the group.)
2. **Join the group** ("Open A'ska & Callout").
3. Post the example call shown on the page in the group. It appears on the glasses; tap to place it, and the receipt replies under your message in the group.

**Also try a private chat with the bot** ([@callout8_bot](https://t.me/callout8_bot)): forward it any trade call and it replies privately with what it read, how far the live price is, any scam signs and the caller's record. Once paired, your session's rules live there too:

- `/summary`: your calls today, what was blocked and why, your orders
- `/rules`: the rules checked in code before every order
- `/setrule maxTradesPerDay 1`: tighten your own limit. Then place one order on `/try` and send another call: the card is blocked with "rule: 1/1 trades today"
- `/audit`: your last decisions with order IDs

Nothing is ever traded from Telegram, and the bot never posts checks into a group.

## 3 · On G2 glasses or the official simulator

- **Real G2:** install [`callout.ehpk`](https://github.com/datharnu/callout/releases/download/v1.0/callout.ehpk) in the Even app. It starts its own demo session: **tap** on the home screen for a sample call, **tap** again to place it. To post your own calls, send the `/pair` code shown on the glasses in the Callout group (invite link on the glasses).
- **Official simulator:** on `/try`, open **Session details** and copy the simulator command. It runs the same app on your same session.

## What to look for

- **The AI only reads the call.** Every check runs in code: entry within 3% of the live Bybit price, stop and target on the right side, every number written in the message, scam wording and links (including disguised ones), 15-minute expiry, your own rules.
- **A tap places only what you saw.** The price is re-checked at the tap and again when the cancel window ends; if a voice command changed the size or stop after the screen was drawn, the tap is refused.
- **Proof:** the same order ID on the glasses, in Bybit and in the Telegram receipt ([video](https://youtu.be/EQE6fJ02oIU), [screenshots](../README.md#proof-one-real-order-three-places)).
- **Numbers:** 0 unsafe one-tap cards in 269 messages, 0 / 46 red-team messages got through, 0 risky voice misfires in 180 commands. Every suite is in the [test report](TEST-REPORT.md).

If something looks stuck, reload the page; your session starts fresh.
