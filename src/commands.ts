/**
 * Text-command parsing for the Discord side of the bridge.
 *
 * These are plain text messages, not registered Discord application commands:
 * an unregistered `/new` still arrives as ordinary message content, which
 * keeps the bridge free of command-registration state.
 *
 * @module dsh-plugin-discord/commands
 */

/** One parsed instruction from a Discord message. */
export type BridgeCommand =
  | { kind: 'new'; label: string }
  | { kind: 'sessions' }
  | { kind: 'use'; sessionId: string }
  | { kind: 'current' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'prompt'; text: string }

/**
 * Parse one message into a bridge command.
 *
 * Only the exact names below are intercepted; any other `/`-prefixed text
 * passes through as a prompt so dsh slash commands and ordinary text that
 * merely starts with a slash keep working.
 * @param content - raw Discord message content.
 * @returns the parsed command; empty content parses to a help request.
 */
export function parseCommand(content: string): BridgeCommand {
  const text = content.trim()
  if (text === '') return { kind: 'help' }
  if (!text.startsWith('/')) return { kind: 'prompt', text }
  const spaceIndex = text.search(/\s/)
  const word = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).toLowerCase()
  const rest = spaceIndex === -1 ? '' : text.slice(spaceIndex).trim()
  switch (word) {
    case '/new':
      return { kind: 'new', label: rest }
    case '/sessions':
    case '/list':
      return { kind: 'sessions' }
    case '/use':
    case '/switch':
    case '/resume':
      return { kind: 'use', sessionId: rest }
    case '/current':
    case '/session':
      return { kind: 'current' }
    case '/stop':
    case '/cancel':
      return { kind: 'stop' }
    case '/help':
      return { kind: 'help' }
    default:
      return { kind: 'prompt', text }
  }
}

/** The `/help` reply, kept next to the parser it documents. */
export const HELP_TEXT = [
  '**dsh Discord 桥接**',
  '直接发消息 → 发给当前 dsh 会话(没有就自动新建)',
  '`/new [标题]` — 新开一个会话(和 web 界面共享)',
  '`/sessions` — 列出最近的 Discord 会话',
  '`/use <会话id>` — 切换到某个会话(也可以是 web 上建的)',
  '`/current` — 显示当前绑定的会话',
  '`/stop` — 取消当前会话正在跑的回合',
  '`/help` — 本帮助',
].join('\n')
