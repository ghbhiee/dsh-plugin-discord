/**
 * Proactive-notification surface: this deployment's bot as a service.
 *
 * Two faces over one capability ("send a Discord message from THIS dsh's
 * bot"), registered on the host web server under `/plugins/discord`:
 *
 *   - `POST /plugins/discord/api/notify` — plain JSON for daemons and shell
 *     one-liners: `{"content": "...", "userId"?, "channelId"?}`.
 *   - `POST /plugins/discord/mcp` — a minimal Streamable HTTP MCP server
 *     exposing the `discord_notify` tool, so agents (dsh's own
 *     `@deepseek-ai/dsh-mcp-client`, Claude Code, mcp-remote) get it as a
 *     first-class tool.
 *
 * Every request must carry `Authorization: Bearer <secret>`. Each dsh
 * deployment serves its own bot, so sender identity follows the deployment
 * (dsh 本地 → its bot, dsh 服务端 → its bot) with zero extra wiring.
 *
 * @module dsh-plugin-discord/notify
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DiscordRest } from './rest.ts'
import { chunkReply } from './chunk.ts'

/** Where a notification goes; empty falls back to the deployment owner's DM. */
export interface NotifyTarget {
  userId?: string
  channelId?: string
}

/** Sends bot messages, resolving and caching DM channels. */
export class DiscordNotifier {
  private readonly rest: DiscordRest
  private readonly defaultUserId: string | undefined
  private readonly maxChunks: number
  private readonly dmChannels = new Map<string, string>()

  constructor(rest: DiscordRest, defaultUserId: string | undefined, maxChunks: number) {
    this.rest = rest
    this.defaultUserId = defaultUserId
    this.maxChunks = maxChunks
  }

  /**
   * Deliver one notification.
   * @param target - explicit channel or user; both absent targets the owner's DM.
   * @param content - message text; chunked to Discord's limit.
   * @returns the channel written to and the created message ids.
   */
  async send(target: NotifyTarget, content: string): Promise<{ channelId: string; messageIds: string[] }> {
    if (content.trim() === '') throw new Error('content must not be empty')
    let channelId = target.channelId
    if (channelId === undefined) {
      const userId = target.userId ?? this.defaultUserId
      if (userId === undefined) throw new Error('no target: pass userId/channelId or configure allowedUsers')
      channelId = this.dmChannels.get(userId)
      if (channelId === undefined) {
        channelId = (await this.rest.createDM(userId)).id
        this.dmChannels.set(userId, channelId)
      }
    }
    const messageIds: string[] = []
    for (const chunk of chunkReply(content, this.maxChunks)) {
      messageIds.push((await this.rest.createMessage(channelId, chunk)).id)
    }
    return { channelId, messageIds }
  }
}

/** JSON-RPC 2.0 envelope, narrowed to what the MCP handshake uses. */
interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

const MCP_TOOL = {
  name: 'discord_notify',
  description: 'Send a proactive Discord message from this dsh deployment\'s bot. '
    + 'Defaults to a DM to the deployment owner; pass userId for another allowlisted user\'s DM, '
    + 'or channelId for a guild channel the bot can post in. Use for monitoring alerts, '
    + 'reminders, and task-completion notifications.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Message text (Discord markdown; long text is split automatically).' },
      userId: { type: 'string', description: 'Discord user id to DM. Optional; defaults to the deployment owner.' },
      channelId: { type: 'string', description: 'Guild channel id to post in instead of a DM. Optional.' },
    },
    required: ['content'],
  },
} as const

/** Dependencies of the MCP/HTTP handlers, injectable for tests. */
export interface NotifyServiceDeps {
  notifier: Pick<DiscordNotifier, 'send'>
  /** Human-readable sender identity, e.g. `dsh_mac`. */
  botLabel: () => string
  version: string
}

/**
 * Answer one MCP JSON-RPC message.
 * @returns the response object, or undefined for notifications (no `id`).
 */
export async function handleMcpMessage(message: JsonRpcMessage, deps: NotifyServiceDeps): Promise<Record<string, unknown> | undefined> {
  const { id, method, params } = message
  const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result })
  const fail = (code: number, text: string): Record<string, unknown> =>
    ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } })
  if (method === undefined) return fail(-32600, 'not a request')
  const isNotification = id === undefined
  switch (method) {
    case 'initialize':
      return respond({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'dsh-plugin-discord',
          title: `Discord notify (${deps.botLabel()})`,
          version: deps.version,
        },
      })
    case 'ping':
      return respond({})
    case 'tools/list':
      return respond({ tools: [MCP_TOOL] })
    case 'tools/call': {
      const name = params?.name
      if (name !== MCP_TOOL.name) return fail(-32602, `unknown tool ${String(name)}`)
      const args = (params?.arguments ?? {}) as { content?: string; userId?: string; channelId?: string }
      if (typeof args.content !== 'string' || args.content.trim() === '') {
        return fail(-32602, 'arguments.content must be a non-empty string')
      }
      try {
        const sent = await deps.notifier.send(
          {
            ...typeof args.userId === 'string' && args.userId !== '' ? { userId: args.userId } : {},
            ...typeof args.channelId === 'string' && args.channelId !== '' ? { channelId: args.channelId } : {},
          },
          args.content,
        )
        return respond({
          content: [{
            type: 'text',
            text: `sent via ${deps.botLabel()}: channel ${sent.channelId}, ${String(sent.messageIds.length)} message(s)`,
          }],
        })
      } catch (error) {
        return respond({
          content: [{ type: 'text', text: `send failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        })
      }
    }
    default:
      if (isNotification) return undefined
      return fail(-32601, `method not found: ${method}`)
  }
}

const MAX_BODY_BYTES = 256 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Build the prefix-route handler for `/plugins/discord`.
 * @param secret - required bearer token; every request is checked first.
 * @param deps - capability implementations.
 * @param log - operational logging.
 */
export function createNotifyHandler(
  secret: string,
  deps: NotifyServiceDeps,
  log: (level: 'info' | 'warn', text: string) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const authorized = req.headers.authorization === `Bearer ${secret}`
      if (!authorized) {
        sendJson(res, 401, { error: 'missing or wrong bearer token' })
        return
      }
      if (path === '/plugins/discord/api/notify' && req.method === 'POST') {
        let body: { content?: string; userId?: string; channelId?: string }
        try {
          body = JSON.parse(await readBody(req)) as typeof body
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        if (typeof body.content !== 'string' || body.content.trim() === '') {
          sendJson(res, 400, { error: 'content must be a non-empty string' })
          return
        }
        try {
          const sent = await deps.notifier.send(
            {
              ...typeof body.userId === 'string' && body.userId !== '' ? { userId: body.userId } : {},
              ...typeof body.channelId === 'string' && body.channelId !== '' ? { channelId: body.channelId } : {},
            },
            body.content,
          )
          sendJson(res, 200, { ok: true, ...sent })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (path === '/plugins/discord/mcp') {
        if (req.method !== 'POST') {
          // No server-initiated stream: stateless request/response only.
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
          return
        }
        const messages = Array.isArray(parsed) ? parsed as JsonRpcMessage[] : [parsed as JsonRpcMessage]
        const responses: Record<string, unknown>[] = []
        for (const message of messages) {
          const response = await handleMcpMessage(message, deps)
          if (response !== undefined) responses.push(response)
        }
        if (responses.length === 0) {
          res.writeHead(202)
          res.end()
          return
        }
        sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0])
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      log('warn', `notify handler failed: ${String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    }
  }
}
