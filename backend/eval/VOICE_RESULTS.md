# Callout voice command accuracy

Run 2026-11-26T17:24:38.433Z · ElevenLabs `scribe_v2` on 16 kHz s16le PCM (the G2 mic format) · production interpreter.
28 phrases × 6 synthetic voices (Samantha, Daniel, Karen, Moira, Rishi, Tessa: US, UK, AU, IE, IN, ZA accents) = 168 utterances.
Synthetic speech (macOS `say`), so this measures the pipeline, not a noisy street or a real glasses mic.

**Risky misfires: 0** (a Place/Close/size/stop command that wasn't asked for, or a wrong stop price).

- Correct command: 159/168 (94.6%)
- Commands recognised: 135/144 (93.8%)
- Non-commands correctly ignored: 24/24
- Speech-to-text latency (sequential, warm connection): median 472 ms, p90 658 ms

## By voice

| Voice | Correct |
|---|---|
| Samantha | 27/28 |
| Daniel | 28/28 |
| Karen | 27/28 |
| Moira | 25/28 |
| Rishi | 26/28 |
| Tessa | 26/28 |

## Misses

- Samantha · [ready] "half" → heard "Have" → no command
- Karen · [ready] "pass" → heard "Pause" → no command
- Moira · [ready] "half" → heard "Path" → no command
- Moira · [ready] "place it" → heard "Places" → no command
- Moira · [ready] "pass" → heard "Pause" → no command
- Rishi · [ready] "place it" → heard "Play set" → no command
- Rishi · [ready] "pass" → heard "Pause" → no command
- Tessa · [ready] "move my stop to fifty nine thousand" → heard "Move my stock to 59,000" → no command
- Tessa · [ready] "pass" → heard "Pause" → no command
