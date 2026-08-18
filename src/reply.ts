/**
 * Extract the reply for one Discord-submitted prompt from a session log.
 *
 * The bridge stamps its user message with the Discord message id (a durable
 * JSON field on the message source, the same pattern the web client uses with
 * rpcId), finds that event in the log, and reads the turn it opened. This
 * keeps a concurrently running web prompt from being mistaken for our answer.
 *
 * @module dsh-plugin-discord/reply
 */

/** The event-log shape this module folds; structurally matches SessionEvent. */
export interface LogEventLike {
  seq: number
  type: string
  data?: unknown
}

/** Outcome of one bridged turn. */
export interface BridgedReply {
  /** Concatenated text of the turn's last non-empty assistant message. */
  text: string
  /** `completed`, `cancelled`, an error kind, or undefined while unfinished. */
  reasonKind: string | undefined
  /** Error message when the turn failed. */
  errorMessage: string | undefined
}

/** Find the seq of the user/message event carrying this Discord message id. */
export function findPromptSeq(events: readonly LogEventLike[], discordMessageId: string): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    // The event's data IS the message: { content, source, role, id }.
    const source = (event.data as { source?: { discordMessageId?: string } }).source
    if (source?.discordMessageId === discordMessageId) return event.seq
  }
  return undefined
}

/**
 * Fold the events between the bridged prompt and its turn's end into a reply.
 *
 * The prompt's own `turn/start` precedes the `user/message` event in the log
 * (the driver opens the turn, then appends the claimed message), so the fold
 * simply starts AT the prompt and stops at the first `turn/end` after it —
 * everything between belongs to the turn this prompt opened.
 * @param events - the session's full in-memory event log.
 * @param promptSeq - seq of the bridged user/message event.
 * @returns the folded reply; `reasonKind` is undefined when the turn has not ended.
 */
export function extractReply(events: readonly LogEventLike[], promptSeq: number): BridgedReply {
  let text = ''
  let reasonKind: string | undefined
  let errorMessage: string | undefined
  for (const event of events) {
    if (event.seq < promptSeq) continue
    if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: { type: string; text?: string }[] } }
      const joined = (data.message?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
      continue
    }
    if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
      reasonKind = reason?.kind
      errorMessage = reason?.error?.message
      break
    }
  }
  return { text, reasonKind, errorMessage }
}
