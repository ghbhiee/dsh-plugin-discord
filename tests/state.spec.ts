import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../src/state.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-bridge-state-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('BindingStore', () => {
  it('starts empty when the file is missing', async () => {
    const store = new BindingStore(join(dir, 'state.json'))
    await store.load()
    expect(store.get('c1')).toBeUndefined()
  })

  it('persists bindings across instances', async () => {
    const file = join(dir, 'state.json')
    const store = new BindingStore(file)
    await store.load()
    store.set('c1', 'session-a')
    store.set('c2', 'session-b')
    await store.flush()

    const second = new BindingStore(file)
    await second.load()
    expect(second.get('c1')).toBe('session-a')
    expect(second.get('c2')).toBe('session-b')
    expect(second.entries()).toHaveLength(2)
  })

  it('deletes bindings and persists the removal', async () => {
    const file = join(dir, 'state.json')
    const store = new BindingStore(file)
    await store.load()
    store.set('c1', 'session-a')
    store.delete('c1')
    await store.flush()

    const second = new BindingStore(file)
    await second.load()
    expect(second.get('c1')).toBeUndefined()
  })

  it('survives a corrupt state file', async () => {
    const file = join(dir, 'state.json')
    await writeFile(file, '{not json', 'utf8')
    const store = new BindingStore(file)
    await store.load()
    expect(store.get('c1')).toBeUndefined()
    store.set('c1', 'session-a')
    await store.flush()
    const raw = JSON.parse(await readFile(file, 'utf8')) as { channels: Record<string, string> }
    expect(raw.channels.c1).toBe('session-a')
  })

  it('drops non-string values on load', async () => {
    const file = join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ version: 1, channels: { good: 'session-a', bad: 42 } }), 'utf8')
    const store = new BindingStore(file)
    await store.load()
    expect(store.get('good')).toBe('session-a')
    expect(store.get('bad')).toBeUndefined()
  })
})
