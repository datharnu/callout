import { config } from './config.js'
import { onReceipt } from './executor.js'
import { sweepExpired } from './pipeline.js'
import { startServer } from './server.js'
import { sendReceipt, startTelegram } from './telegram.js'
import { refreshOutcomes } from './track.js'
import { sweepSandboxes } from './sandbox.js'

console.log(
  `Callout backend · size $${config.sizeUsd} (cap $${config.maxSizeUsd}) · ${config.allowedChatIds.size} chat(s), ` +
    `${config.allowedSenderIds.size} sender(s) allowlisted · Bybit DEMO`,
)
if (!config.allowedChatIds.size || !config.allowedSenderIds.size) {
  console.warn('WARNING: allowlist is empty. No message will ever become a card.')
}

onReceipt(sendReceipt)
setInterval(() => sweepExpired(), 5000).unref()
setInterval(() => sweepSandboxes(), 10 * 60_000).unref()
const refresh = () => refreshOutcomes().catch(e => console.warn('[track] refresh failed:', (e as Error).message))
void refresh()
setInterval(refresh, 5 * 60_000).unref()
await startServer()
// Free hosting restarts lose the judge auto-close timer: start from a clean demo account.
if (process.env.CALLOUT_CLOSE_POSITIONS_ON_BOOT === '1') {
  const { bybit } = await import('./bybit/demo.js')
  const { closePosition, listPositions } = await import('./positions.js')
  const { audit } = await import('./store.js')
  for (const p of await listPositions(bybit).catch(() => [])) {
    const r = await closePosition(bybit, p.symbol, `boot:${Date.now()}:${p.symbol}`).catch(e => ({ retCode: -1, retMsg: String(e) }))
    audit('boot_close', { symbol: p.symbol, side: p.side, size: p.size, retCode: r.retCode })
    console.log(`[boot] closed leftover demo position ${p.symbol} ${p.side} ${p.size} → ${r.retCode}`)
  }
}
if (process.env.CALLOUT_NO_TELEGRAM !== '1') await startTelegram()
