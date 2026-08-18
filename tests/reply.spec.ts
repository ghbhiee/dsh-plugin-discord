import { describe, expect, it } from 'vitest'
import { extractReply, findPromptSeq } from '../src/reply.ts'
import type { LogEventLike } from '../src/reply.ts'

// Shapes mirror a real session log: the user/message event's data IS the
// message ({ content, source, ... }), and turn/start precedes it.
function userMessage(seq: number, discordMessageId?: string): LogEventLike {
  return {
    seq,
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user', ...discordMessageId === undefined ? {} : { discordMessageId } },
      role: 'user',
      id: `uuid-${String(seq)}`,
    },
  }
}

function assistant(seq: number, text: string): LogEventLike {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

describe('findPromptSeq', () => {
  it('finds the event stamped with the Discord message id', () => {
    const events = [userMessage(1), userMessage(5, 'msg-a'), userMessage(9, 'msg-b')]
    expect(findPromptSeq(events, 'msg-a')).toBe(5)
    expect(findPromptSeq(events, 'msg-b')).toBe(9)
  })

  it('returns undefined when the id is absent', () => {
    expect(findPromptSeq([userMessage(1)], 'nope')).toBeUndefined()
  })
})

describe('extractReply', () => {
  it('folds a completed turn into its last assistant text', () => {
    const events: LogEventLike[] = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      userMessage(2, 'm1'),
      assistant(3, '想一下'),
      assistant(4, '最终答案'),
      { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const reply = extractReply(events, 2)
    expect(reply).toEqual({ text: '最终答案', reasonKind: 'completed', errorMessage: undefined })
  })

  it('ignores an earlier concurrent turn that belongs to the web user', () => {
    const events: LogEventLike[] = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      userMessage(2),
      assistant(3, 'web 的答案'),
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      userMessage(6, 'm2'),
      assistant(7, 'discord 的答案'),
      { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const reply = extractReply(events, 6)
    expect(reply.text).toBe('discord 的答案')
  })

  it('stops at the first turn end after the prompt', () => {
    const events: LogEventLike[] = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      userMessage(2, 'm1'),
      assistant(3, '第一轮'),
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      assistant(6, '之后别人的轮次'),
      { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    expect(extractReply(events, 2).text).toBe('第一轮')
  })

  it('carries the error out of a failed turn', () => {
    const events: LogEventLike[] = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      userMessage(2, 'm1'),
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'provider exploded' } } } },
    ]
    const reply = extractReply(events, 2)
    expect(reply.reasonKind).toBe('error')
    expect(reply.errorMessage).toBe('provider exploded')
  })

  it('reports an unfinished turn as undefined reason', () => {
    const events: LogEventLike[] = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      userMessage(2, 'm1'),
      assistant(3, '进行中'),
    ]
    const reply = extractReply(events, 2)
    expect(reply.reasonKind).toBeUndefined()
    expect(reply.text).toBe('进行中')
  })
})
