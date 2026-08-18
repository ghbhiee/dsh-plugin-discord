import { describe, expect, it } from 'vitest'
import { APPLICATION_COMMANDS, commandFromInteraction, parseCommand } from '../src/commands.ts'

describe('parseCommand', () => {
  it('treats plain text as a prompt', () => {
    expect(parseCommand('你好,帮我看看这个函数')).toEqual({ kind: 'prompt', text: '你好,帮我看看这个函数' })
  })

  it('parses /new without a label', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'new', label: '' })
  })

  it('parses /new with a label', () => {
    expect(parseCommand('/new 重构计划')).toEqual({ kind: 'new', label: '重构计划' })
  })

  it('is case-insensitive on the command word', () => {
    expect(parseCommand('/NEW abc')).toEqual({ kind: 'new', label: 'abc' })
  })

  it('parses /sessions and its /list alias', () => {
    expect(parseCommand('/sessions')).toEqual({ kind: 'sessions' })
    expect(parseCommand('/list')).toEqual({ kind: 'sessions' })
  })

  it('parses /use with an id and aliases', () => {
    expect(parseCommand('/use session-abc')).toEqual({ kind: 'use', sessionId: 'session-abc' })
    expect(parseCommand('/switch abc')).toEqual({ kind: 'use', sessionId: 'abc' })
    expect(parseCommand('/resume abc')).toEqual({ kind: 'use', sessionId: 'abc' })
  })

  it('parses /current, /stop, /help', () => {
    expect(parseCommand('/current')).toEqual({ kind: 'current' })
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
  })

  it('passes unknown slash text through as a prompt', () => {
    expect(parseCommand('/compact')).toEqual({ kind: 'prompt', text: '/compact' })
    expect(parseCommand('/etc/hosts 是什么')).toEqual({ kind: 'prompt', text: '/etc/hosts 是什么' })
  })

  it('answers help for empty content', () => {
    expect(parseCommand('   ')).toEqual({ kind: 'help' })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(parseCommand('  /new  x  ')).toEqual({ kind: 'new', label: 'x' })
  })
})

describe('commandFromInteraction', () => {
  it('maps /new with and without a title option', () => {
    expect(commandFromInteraction('new', [])).toEqual({ kind: 'new', label: '' })
    expect(commandFromInteraction('new', [{ name: 'title', value: ' 计划 ' }])).toEqual({ kind: 'new', label: '计划' })
  })

  it('maps /use with its session option', () => {
    expect(commandFromInteraction('use', [{ name: 'session', value: 'session-abc' }]))
      .toEqual({ kind: 'use', sessionId: 'session-abc' })
  })

  it('maps the parameterless commands', () => {
    expect(commandFromInteraction('sessions', [])).toEqual({ kind: 'sessions' })
    expect(commandFromInteraction('current', [])).toEqual({ kind: 'current' })
    expect(commandFromInteraction('stop', [])).toEqual({ kind: 'stop' })
    expect(commandFromInteraction('help', [])).toEqual({ kind: 'help' })
  })

  it('rejects unknown names and non-string option values', () => {
    expect(commandFromInteraction('nuke', [])).toBeUndefined()
    expect(commandFromInteraction('use', [{ name: 'session', value: 42 }])).toEqual({ kind: 'use', sessionId: '' })
  })

  it('every registered command maps to a bridge command', () => {
    for (const command of APPLICATION_COMMANDS) {
      expect(commandFromInteraction(command.name, []), command.name).toBeDefined()
    }
  })
})
