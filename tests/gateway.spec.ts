import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type WsSocket from 'ws'
import { DiscordGateway, INTENTS } from '../src/gateway.ts'
import type { GatewayInteraction, GatewayMessage, GatewayReady } from '../src/gateway.ts'

interface Received {
  op: number
  d?: unknown
  t?: string | null
}

/** One scripted fake Discord gateway over a real local WebSocket server. */
class FakeGateway {
  server!: WebSocketServer
  sockets: WsSocket[] = []
  received: Received[][] = []
  port = 0

  async start(): Promise<void> {
    this.server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => { this.server.once('listening', resolve) })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    this.port = address.port
    this.server.on('connection', (socket) => {
      const inbox: Received[] = []
      this.received.push(inbox)
      this.sockets.push(socket)
      socket.on('message', (raw) => {
        inbox.push(JSON.parse(String(raw)) as Received)
      })
      // Discord sends HELLO immediately. A long interval keeps the periodic
      // heartbeat out of these deterministic scripts.
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}`
  }

  async waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}

let fake: FakeGateway
let client: DiscordGateway | undefined

beforeEach(async () => {
  fake = new FakeGateway()
  await fake.start()
})

afterEach(async () => {
  client?.stop()
  client = undefined
  await fake.close()
})

const baseIntents = INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT

describe('DiscordGateway', () => {
  it('identifies with token and intents after HELLO', async () => {
    client = new DiscordGateway({
      token: 'token-x',
      intents: baseIntents,
      url: fake.url,
      hooks: { onMessage: () => {} },
    })
    client.start()
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 2) ?? false))
    const identify = fake.received[0]?.find(payload => payload.op === 2)
    const data = identify?.d as { token: string; intents: number }
    expect(data.token).toBe('token-x')
    expect(data.intents).toBe(baseIntents)
  })

  it('dispatches MESSAGE_CREATE / INTERACTION_CREATE and reports READY facts', async () => {
    const messages: GatewayMessage[] = []
    const interactions: GatewayInteraction[] = []
    let ready: GatewayReady | undefined
    client = new DiscordGateway({
      token: 't',
      intents: baseIntents,
      url: fake.url,
      hooks: {
        onMessage: (message) => { messages.push(message) },
        onInteraction: (interaction) => { interactions.push(interaction) },
        onReady: (info) => { ready = info },
      },
    })
    client.start()
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 2) ?? false))
    const socket = fake.sockets[0]
    if (socket === undefined) throw new Error('no socket')
    socket.send(JSON.stringify({
      op: 0, s: 1, t: 'READY',
      d: { user: { id: 'bot-1' }, application: { id: 'app-1' }, session_id: 'sess-1', resume_gateway_url: 'ws://127.0.0.1:1' },
    }))
    socket.send(JSON.stringify({
      op: 0, s: 2, t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: 'c1', content: 'hello', author: { id: 'u1' } },
    }))
    socket.send(JSON.stringify({
      op: 0, s: 3, t: 'INTERACTION_CREATE',
      d: { id: 'i1', token: 'tok', channel_id: 'c1', user: { id: 'u1' }, data: { name: 'new', options: [] } },
    }))
    await fake.waitFor(() => messages.length === 1 && interactions.length === 1)
    expect(ready?.botUserId).toBe('bot-1')
    expect(ready?.applicationId).toBe('app-1')
    expect(messages[0]?.content).toBe('hello')
    expect(interactions[0]?.data?.name).toBe('new')
  })

  it('answers a server heartbeat request with the last seq', async () => {
    client = new DiscordGateway({
      token: 't',
      intents: baseIntents,
      url: fake.url,
      hooks: { onMessage: () => {} },
    })
    client.start()
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 2) ?? false))
    const socket = fake.sockets[0]
    if (socket === undefined) throw new Error('no socket')
    socket.send(JSON.stringify({ op: 0, s: 7, t: 'RESUMED', d: {} }))
    socket.send(JSON.stringify({ op: 1 }))
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 1) ?? false))
    const beat = fake.received[0]?.find(payload => payload.op === 1)
    expect(beat?.d).toBe(7)
  })

  it('resumes with session id and seq after an abnormal close', async () => {
    client = new DiscordGateway({
      token: 't',
      intents: baseIntents,
      url: fake.url,
      hooks: { onMessage: () => {} },
      maxBackoffMs: 50,
    })
    client.start()
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 2) ?? false))
    const first = fake.sockets[0]
    if (first === undefined) throw new Error('no socket')
    first.send(JSON.stringify({
      op: 0, s: 3, t: 'READY',
      // Point the resume url back at the fake so the reconnect lands here.
      d: { user: { id: 'bot-1' }, session_id: 'sess-9', resume_gateway_url: fake.url },
    }))
    await new Promise(resolve => setTimeout(resolve, 50))
    first.terminate()
    await fake.waitFor(() => fake.received.length >= 2 && (fake.received[1]?.some(payload => payload.op === 6) ?? false), 5000)
    const resume = fake.received[1]?.find(payload => payload.op === 6)
    const data = resume?.d as { session_id: string; seq: number }
    expect(data.session_id).toBe('sess-9')
    expect(data.seq).toBe(3)
  })

  it('drops MESSAGE_CONTENT and re-identifies after a 4014 close', async () => {
    const warnings: string[] = []
    client = new DiscordGateway({
      token: 't',
      intents: baseIntents,
      url: fake.url,
      hooks: {
        onMessage: () => {},
        log: (level, text) => { if (level === 'warn') warnings.push(text) },
      },
      maxBackoffMs: 50,
    })
    client.start()
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 2) ?? false))
    fake.sockets[0]?.close(4014, 'Disallowed intent(s).')
    await fake.waitFor(() => fake.received.length >= 2 && (fake.received[1]?.some(payload => payload.op === 2) ?? false), 5000)
    const identify = fake.received[1]?.find(payload => payload.op === 2)
    const data = identify?.d as { intents: number }
    expect(data.intents & INTENTS.MESSAGE_CONTENT).toBe(0)
    expect(data.intents & INTENTS.DIRECT_MESSAGES).toBe(INTENTS.DIRECT_MESSAGES)
    expect(warnings.some(text => text.includes('MESSAGE_CONTENT'))).toBe(true)
  })

  it('gives up permanently on an auth failure', async () => {
    let fatal: string | undefined
    client = new DiscordGateway({
      token: 'bad',
      intents: baseIntents,
      url: fake.url,
      hooks: {
        onMessage: () => {},
        onFatal: (reason) => { fatal = reason },
      },
      maxBackoffMs: 50,
    })
    client.start()
    await fake.waitFor(() => (fake.received[0]?.some(payload => payload.op === 2) ?? false))
    fake.sockets[0]?.close(4004, 'Authentication failed.')
    await fake.waitFor(() => fatal !== undefined)
    expect(fatal).toContain('4004')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(fake.received.length).toBe(1)
  })

  it('stop() closes the socket and stops reconnecting', async () => {
    client = new DiscordGateway({
      token: 't',
      intents: baseIntents,
      url: fake.url,
      hooks: { onMessage: () => {} },
      maxBackoffMs: 50,
    })
    client.start()
    await fake.waitFor(() => fake.sockets.length === 1)
    client.stop()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(fake.sockets.length).toBe(1)
    expect(client.connected).toBe(false)
  })
})
