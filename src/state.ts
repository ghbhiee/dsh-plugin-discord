/**
 * Channel-to-session binding, persisted as one small JSON file.
 *
 * The binding is bridge-local state, not session truth: the sessions
 * themselves live in dsh's persistence and survive without this file. Losing
 * it only forgets which conversation each Discord channel was pointed at.
 *
 * @module dsh-plugin-discord/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface StateShape {
  version: 1
  /** channelId → sessionId */
  channels: Record<string, string>
}

/** Persistent channel→session map with atomic-rename writes. */
export class BindingStore {
  private readonly file: string
  private state: StateShape = { version: 1, channels: {} }
  private writeChain: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StateShape>
      if (parsed !== null && typeof parsed === 'object' && parsed.channels !== null && typeof parsed.channels === 'object') {
        const channels: Record<string, string> = {}
        for (const [channel, session] of Object.entries(parsed.channels ?? {})) {
          if (typeof session === 'string') channels[channel] = session
        }
        this.state = { version: 1, channels }
      }
    } catch {
      // Missing or corrupt file: start empty; the next save rewrites it.
    }
  }

  get(channelId: string): string | undefined {
    return this.state.channels[channelId]
  }

  set(channelId: string, sessionId: string): void {
    this.state.channels[channelId] = sessionId
    this.scheduleSave()
  }

  delete(channelId: string): void {
    if (this.state.channels[channelId] === undefined) return
    const { [channelId]: _removed, ...rest } = this.state.channels
    this.state.channels = rest
    this.scheduleSave()
  }

  /** All bindings, newest-write-order not guaranteed. */
  entries(): [string, string][] {
    return Object.entries(this.state.channels)
  }

  private scheduleSave(): void {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const temp = `${this.file}.tmp`
        await writeFile(temp, snapshot, 'utf8')
        await rename(temp, this.file)
      } catch {
        // Best-effort persistence; bindings also live in memory.
      }
    })
  }

  /** Settle pending writes (tests and orderly shutdown). */
  async flush(): Promise<void> {
    await this.writeChain
  }
}
