import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotifyHandler, DiscordNotifier, handleMcpMessage } from '../src/notify.ts'
import type { DiscordRest } from '../src/rest.ts'

/** Recording fake of the two DiscordRest calls the notifier makes. */
function fakeRest(): { rest: Pick<DiscordRest, 'createDM' | 'createMessage'>; calls: string[] } {
  const calls: string[] = []
  let dmCounter = 0
  return {
    calls,
    rest: {
      async createDM(userId: string) {
        dmCounter += 1
        calls.push(`dm:${userId}`)
        return { id: `dm-channel-${String(dmCounter)}` }
      },
      async createMessage(channelId: string, content: string) {
        calls.push(`msg:${channelId}:${content.slice(0, 20)}`)
        return { id: `m-${String(calls.length)}` }
      },
    },
  }
}

describe('DiscordNotifier', () => {
  it('opens the owner DM once and caches the channel', async () => {
    const { rest, calls } = fakeRest()
    const notifier = new DiscordNotifier(rest as DiscordRest, 'owner-1', 6)
    await notifier.send({}, '第一条')
    await notifier.send({}, '第二条')
    expect(calls.filter(call => call.startsWith('dm:'))).toEqual(['dm:owner-1'])
    expect(calls.filter(call => call.startsWith('msg:'))).toHaveLength(2)
  })

  it('targets an explicit channel without a DM lookup', async () => {
    const { rest, calls } = fakeRest()
    const notifier = new DiscordNotifier(rest as DiscordRest, 'owner-1', 6)
    const sent = await notifier.send({ channelId: 'chan-9' }, '进频道')
    expect(sent.channelId).toBe('chan-9')
    expect(calls.some(call => call.startsWith('dm:'))).toBe(false)
  })

  it('splits long content into several messages', async () => {
    const { rest, calls } = fakeRest()
    const notifier = new DiscordNotifier(rest as DiscordRest, 'owner-1', 6)
    const sent = await notifier.send({}, 'x'.repeat(4200))
    expect(sent.messageIds.length).toBeGreaterThan(1)
    expect(calls.filter(call => call.startsWith('msg:')).length).toBe(sent.messageIds.length)
  })

  it('rejects empty content and missing targets', async () => {
    const { rest } = fakeRest()
    const unowned = new DiscordNotifier(rest as DiscordRest, undefined, 6)
    await expect(new DiscordNotifier(rest as DiscordRest, 'u', 6).send({}, '  ')).rejects.toThrow('empty')
    await expect(unowned.send({}, 'hi')).rejects.toThrow('no target')
  })
})

const deps = (notifierSend: (target: unknown, content: string) => Promise<{ channelId: string; messageIds: string[] }>) => ({
  notifier: { send: notifierSend } as unknown as DiscordNotifier,
  botLabel: () => 'test-bot',
  version: '0.5.1',
  httpEndpoint: 'http://127.0.0.1:3080/plugins/discord/api/notify',
  secretPath: '/tmp/notify.secret',
})

describe('handleMcpMessage', () => {
  it('answers initialize with echoed protocol version and server info', async () => {
    const response = await handleMcpMessage(
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      deps(async () => ({ channelId: 'c', messageIds: [] })),
    ) as { result: { protocolVersion: string; serverInfo: { title: string } } }
    expect(response.result.protocolVersion).toBe('2025-11-25')
    expect(response.result.serverInfo.title).toContain('test-bot')
  })

  it('lists the discord_notify tool with the scheduled-reminder recipe', async () => {
    const response = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      deps(async () => ({ channelId: 'c', messageIds: [] })),
    ) as { result: { tools: { name: string; description: string }[] } }
    expect(response.result.tools.map(tool => tool.name)).toEqual(['discord_notify'])
    const description = response.result.tools[0]?.description ?? ''
    // Agents must learn the out-of-band HTTP recipe for reminders from the
    // description itself — cron/launchd jobs cannot speak MCP.
    expect(description).toContain('http://127.0.0.1:3080/plugins/discord/api/notify')
    expect(description).toContain('$(cat /tmp/notify.secret)')
    expect(description).toContain('SCHEDULED')
  })

  it('calls the tool and reports the delivery', async () => {
    const sent: unknown[] = []
    const response = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'discord_notify', arguments: { content: '警报' } } },
      deps(async (target, content) => { sent.push([target, content]); return { channelId: 'dm-1', messageIds: ['m1'] } }),
    ) as { result: { content: { text: string }[]; isError?: boolean } }
    expect(sent).toHaveLength(1)
    expect(response.result.isError).toBeUndefined()
    expect(response.result.content[0]?.text).toContain('dm-1')
  })

  it('reports tool failure inside the result, not as protocol error', async () => {
    const response = await handleMcpMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'discord_notify', arguments: { content: 'x' } } },
      deps(async () => { throw new Error('discord down') }),
    ) as { result: { isError?: boolean; content: { text: string }[] } }
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0]?.text).toContain('discord down')
  })

  it('swallows notifications and rejects unknown methods', async () => {
    const dependencies = deps(async () => ({ channelId: 'c', messageIds: [] }))
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, dependencies)).toBeUndefined()
    const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, dependencies) as { error: { code: number } }
    expect(unknown.error.code).toBe(-32601)
  })
})

describe('createNotifyHandler over HTTP', () => {
  let server: Server
  let origin: string
  const sent: { target: unknown; content: string }[] = []

  beforeEach(async () => {
    sent.length = 0
    const handler = createNotifyHandler(
      'secret-1',
      deps(async (target, content) => { sent.push({ target, content }); return { channelId: 'dm-1', messageIds: ['m1'] } }),
      () => {},
    )
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    origin = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })

  it('rejects a wrong or missing bearer token', async () => {
    const bare = await fetch(`${origin}/plugins/discord/api/notify`, { method: 'POST', body: '{}' })
    expect(bare.status).toBe(401)
    const wrong = await fetch(`${origin}/plugins/discord/api/notify`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: '{}',
    })
    expect(wrong.status).toBe(401)
    expect(sent).toHaveLength(0)
  })

  it('delivers a plain API notification', async () => {
    const response = await fetch(`${origin}/plugins/discord/api/notify`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer secret-1', 'content-type': 'application/json' },
      body: JSON.stringify({ content: '构建完成 ✅' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; channelId: string }
    expect(body.ok).toBe(true)
    expect(body.channelId).toBe('dm-1')
    expect(sent[0]?.content).toBe('构建完成 ✅')
  })

  it('serves the MCP handshake and tool call', async () => {
    const post = async (message: unknown): Promise<Response> => await fetch(`${origin}/plugins/discord/mcp`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer secret-1', 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
    const initialize = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(initialize.status).toBe(200)
    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(initialized.status).toBe(202)
    const call = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discord_notify', arguments: { content: '磁盘 90%' } } })
    const body = await call.json() as { result: { content: { text: string }[] } }
    expect(body.result.content[0]?.text).toContain('dm-1')
    expect(sent.map(entry => entry.content)).toEqual(['磁盘 90%'])
  })

  it('404s unknown paths and 405s GET on the MCP endpoint', async () => {
    const missing = await fetch(`${origin}/plugins/discord/nope`, { headers: { authorization: 'Bearer secret-1' } })
    expect(missing.status).toBe(404)
    const get = await fetch(`${origin}/plugins/discord/mcp`, { headers: { authorization: 'Bearer secret-1' } })
    expect(get.status).toBe(405)
  })
})
