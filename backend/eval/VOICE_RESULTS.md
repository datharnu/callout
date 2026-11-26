# Callout voice command accuracy

Run 2026-11-26T17:46:53.099Z · ElevenLabs `scribe_v2` on 16 kHz s16le PCM (the G2 mic format) · production interpreter.
30 phrases × 6 synthetic voices (Samantha, Daniel, Karen, Moira, Rishi, Tessa: US, UK, AU, IE, IN, ZA accents) = 180 utterances.
Synthetic speech (macOS `say`), so this measures the pipeline, not a noisy street or a real glasses mic.

**Risky misfires: 0** (a Place/Close/size/stop command that wasn't asked for, or a wrong stop price).

- Correct command: 171/180 (95.0%)
- Commands recognised: 147/156 (94.2%)
- Non-commands correctly ignored: 24/24
- Speech-to-text latency (sequential, warm connection): median 468 ms, p90 643 ms

## By voice

| Voice | Correct |
|---|---|
| Samantha | 29/30 |
| Daniel | 30/30 |
| Karen | 29/30 |
| Moira | 27/30 |
| Rishi | 28/30 |
| Tessa | 28/30 |

## Misses

- Samantha · [ready] "half" → heard "Tab" → no command
- Karen · [ready] "pass" → heard "Pause" → no command
- Moira · [ready] "half" → heard "Path" → no command
- Moira · [ready] "place it" → heard "Places" → no command
- Moira · [ready] "pass" → heard "Pause" → no command
- Rishi · [ready] "place it" → heard "Play set" → no command
- Rishi · [ready] "pass" → heard "Pause" → no command
- Tessa · [ready] "move my stop to fifty nine thousand" → heard "Move my stock to 59,000" → no command
- Tessa · [ready] "pass" → heard "Pause" → no command
