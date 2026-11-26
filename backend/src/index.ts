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
if (process.env.CALLOUT_NO_TELEGRAM !== '1') await startTelegram()
