/**
 * Split one reply into Discord-sized messages.
 *
 * Discord caps message content at 2000 characters (as UTF-16 code units, which
 * `String.length` measures). Splitting prefers paragraph, then line, then hard
 * boundaries, and re-opens an unterminated code fence on the next chunk so
 * multi-message code blocks stay rendered as code.
 *
 * @module dsh-plugin-discord/chunk
 */

/** Discord's hard limit; chunks stay a little under it for fence re-opening. */
export const DISCORD_MESSAGE_LIMIT = 2000
const CHUNK_BUDGET = 1950

/** Language hint of the currently open fence at the end of `text`, or undefined when balanced. */
function openFence(text: string): string | undefined {
  let open: string | undefined
  for (const line of text.split('\n')) {
    const match = /^\s*```(\S*)/.exec(line)
    if (match === null) continue
    open = open === undefined ? (match[1] ?? '') : undefined
  }
  return open
}

/** Cut index at the best boundary within the budget: paragraph > line > hard cut. */
function cutIndex(text: string, budget: number): number {
  if (text.length <= budget) return text.length
  const window = text.slice(0, budget)
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph > budget / 2) return paragraph + 1
  const line = window.lastIndexOf('\n')
  if (line > budget / 2) return line + 1
  return budget
}

/**
 * Split `text` into sendable chunks.
 * @param text - the full reply.
 * @param maxChunks - cap on messages; overflow is truncated with a notice.
 * @returns non-empty chunks, each within Discord's limit.
 */
export function chunkReply(text: string, maxChunks = 6): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const chunks: string[] = []
  let rest = trimmed
  let carryFence: string | undefined
  while (rest !== '' && chunks.length < maxChunks) {
    let piece = carryFence === undefined ? '' : `\`\`\`${carryFence}\n`
    const budget = CHUNK_BUDGET - piece.length
    const cut = cutIndex(rest, budget)
    piece += rest.slice(0, cut)
    rest = rest.slice(cut)
    const fence = openFence(piece)
    if (fence !== undefined && rest !== '') piece += '\n```'
    carryFence = fence
    chunks.push(piece.trim())
  }
  if (rest !== '') {
    const last = chunks[chunks.length - 1]
    const notice = '\n\n…(回复过长已截断,完整内容请在 web 界面查看)'
    if (last !== undefined && last.length + notice.length <= DISCORD_MESSAGE_LIMIT) {
      chunks[chunks.length - 1] = last + notice
    }
  }
  return chunks.filter(chunk => chunk !== '')
}
