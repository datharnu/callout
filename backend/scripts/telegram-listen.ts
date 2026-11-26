// Nov 26 check: does the bot see ORDINARY group messages (not just /commands)?
//
// Prints every group message / edit / channel post with the IDs the allowlist needs:
//   chat.id, from.id (user), sender_chat.id (anonymous admins + channel posts).
// Logs to stdout only. Nothing is stored. The bot never replies.
//
// Usage: npm run tg:listen   (Ctrl+C to stop)
import { Bot, type Context } from 'grammy'
import { requireEnv } from '../src/env.js'

const bot = new Bot(requireEnv('TELEGRAM_BOT_TOKEN'))

function describe(kind: string, ctx: Context) {
  const m = ctx.msg
  if (!m) return
  const who = m.sender_chat
    ? `sender_chat ${m.sender_chat.id} (${'title' in m.sender_chat ? m.sender_chat.title : ''})`
    : m.from
      ? `from ${m.from.id} @${m.from.username ?? '-'}${m.from.is_bot ? ' [bot]' : ''}`
      : 'unknown sender'
  const text = (m.text ?? m.caption ?? `<${Object.keys(m).find(k => !['message_id', 'from', 'chat', 'date', 'sender_chat', 'edit_date'].includes(k))}>`)
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  const isCommand = !!m.text?.startsWith('/')
  console.log(
    `[${new Date().toISOString()}] ${kind.padEnd(14)} chat ${m.chat.id} (${m.chat.type}${'title' in m.chat ? `: ${m.chat.title}` : ''}) · ${who} · msg ${m.message_id}${isCommand ? ' · COMMAND' : ''}\n    ${text}`,
  )
}

bot.on('message', ctx => describe('message', ctx))
bot.on('edited_message', ctx => describe('edited_message', ctx))
bot.on('channel_post', ctx => describe('channel_post', ctx))
bot.on('edited_channel_post', ctx => describe('edited_channel', ctx))
bot.on('my_chat_member', ctx => {
  const u = ctx.myChatMember
  console.log(`[${new Date().toISOString()}] membership    chat ${u.chat.id} · ${u.old_chat_member.status} → ${u.new_chat_member.status}`)
})
bot.catch(err => console.error('handler error:', err.error))

const me = await bot.api.getMe()
console.log(`Bot @${me.username} (id ${me.id})`)
console.log(
  me.can_read_all_group_messages
    ? 'Privacy mode: OFF. The bot can read ordinary group messages.'
    : 'Privacy mode: ON. In groups where it is NOT an admin, the bot sees only /commands and replies to it.\n' +
      '  Fix: @BotFather → /setprivacy → Disable (or make it a group admin), then REMOVE the bot from the group and ADD it back.',
)
console.log('Listening… post an ordinary message (not a /command) in the group.\n')

await bot.start({
  drop_pending_updates: true,
  allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'],
})
