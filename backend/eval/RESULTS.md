# Callout parser + checks accuracy

Run 2026-11-27T13:27:12.642Z · model `claude-haiku-5-5` · 269 synthetic messages (38 trade_call, 8 holding_update, 216 noise, 7 unsure; 6 from non-allowlisted senders).
The set is synthetic and was written by the same team that wrote the parser prompt, so treat these numbers as a smoke test, not a benchmark.

**Unsafe one-tap cards: 0** (a card you could place with one tap whose values differ from the message, or that the checks should have blocked).

## Classification (allowlisted senders only)

| Kind | Support | Precision | Recall |
|---|---|---|---|
| trade_call | 32 | 100.0% | 90.6% |
| holding_update | 8 | 88.9% | 100.0% |
| noise | 216 | 100.0% | 99.5% |
| unsure | 7 | 70.0% | 100.0% |

## Field accuracy (29 trade calls parsed as trade calls)

| Field | Accuracy |
|---|---|
| symbol | 100.0% |
| side | 100.0% |
| entry | 100.0% |
| stop | 100.0% |
| targets | 100.0% |

## End-to-end decision

- Final card state matches expectation: 261/269 (97.0%)
- Tradable calls shown as tradable: 23/23
- Non-allowlisted senders muted: 6/6
- Parser errors (fell back to "unsure"): 0

## Classification misses

- m022 [stop-wrong-side] `ETH long 2400 SL 2450 TP 2550` → expected trade_call, got unsure
- m034 [scam] `🔥 GUARANTEED 100% WIN 🔥 LONG BTC 60.5k SL 59k TP 63k join t.me/vip_signals` → expected trade_call, got unsure
- m038 [scam] `Free money! ETH long 2400 sl 2350 tp 2600 www.cryptowin.xyz` → expected trade_call, got unsure
- m061 [tricky-noise] `Last week our SOL long hit TP at 148, nice` → expected noise, got holding_update
