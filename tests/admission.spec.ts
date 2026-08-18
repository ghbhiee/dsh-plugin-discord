import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isAllowed, resolveStateFile } from '../src/index.ts'

const dm = (author: string, bot = false) => ({
  channel_id: 'dm-1',
  author: { id: author, bot },
})

const guild = (author: string, channel: string) => ({
  guild_id: 'g1',
  channel_id: channel,
  author: { id: author },
})

describe('isAllowed', () => {
  it('never accepts bot authors', () => {
    expect(isAllowed(dm('u1', true), undefined, ['u1'], [])).toBe(false)
  })

  it('never accepts our own messages', () => {
    expect(isAllowed(dm('bot-self'), 'bot-self', ['bot-self'], [])).toBe(false)
  })

  it('accepts DMs only from allowlisted users', () => {
    expect(isAllowed(dm('u1'), 'bot', ['u1'], [])).toBe(true)
    expect(isAllowed(dm('u2'), 'bot', ['u1'], [])).toBe(false)
    expect(isAllowed(dm('u2'), 'bot', [], ['c1'])).toBe(false)
  })

  it('accepts guild messages only in allowlisted channels', () => {
    expect(isAllowed(guild('u1', 'c1'), 'bot', [], ['c1'])).toBe(true)
    expect(isAllowed(guild('u1', 'c2'), 'bot', [], ['c1'])).toBe(false)
  })

  it('applies the user allowlist inside guild channels when present', () => {
    expect(isAllowed(guild('u1', 'c1'), 'bot', ['u1'], ['c1'])).toBe(true)
    expect(isAllowed(guild('u2', 'c1'), 'bot', ['u1'], ['c1'])).toBe(false)
  })
})

describe('resolveStateFile', () => {
  it('prefers the configured path', () => {
    expect(resolveStateFile('/tmp/x.json', 'file:///profile/')).toBe('/tmp/x.json')
  })

  it('derives from the profile directory', () => {
    expect(resolveStateFile('', 'file:///profile/dir/')).toBe('/profile/dir/discord-bridge-state.json')
  })

  it('falls back to the home directory without a base url', () => {
    expect(resolveStateFile('', undefined)).toBe(`${homedir()}/.dsh/discord-bridge-state.json`)
  })
})
