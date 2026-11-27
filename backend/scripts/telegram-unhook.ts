// Remove the Telegram webhook so a local backend can use polling again (only one consumer at a time).
import { Bot } from 'grammy'
import { requireEnv } from '../src/env.js'
const bot = new Bot(requireEnv('TELEGRAM_BOT_TOKEN'))
console.log('webhook was:', (await bot.api.getWebhookInfo()).url || '(none)')
await bot.api.deleteWebhook({ drop_pending_updates: false })
console.log('webhook removed; polling can be used locally now')
