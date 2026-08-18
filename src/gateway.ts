/**
 * Minimal Discord gateway client over the platform WebSocket (Node >= 22).
 *
 * Implements just enough of gateway v10 for a chat bridge: identify, heartbeat,
 * resume, and MESSAGE_CREATE dispatch. Sharding, voice, and transport
 * compression are deliberately out of scope. Zero runtime dependencies — the
 * global `WebSocket` (undici) carries the connection.
 *
 * @module dsh-plugin-discord/gateway
 */

/** Gateway intent bits this bridge cares about. */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const

/** The author of one incoming message. */
export interface GatewayMessageAuthor {
  id: string
  username?: string
  bot?: boolean
}

/** One file the user attached to a Discord message. */
export interface GatewayAttachment {
  url: string
  filename: string
  size: number
  content_type?: string
}

/** One MESSAGE_CREATE dispatch, narrowed to the fields the bridge reads. */
export interface GatewayMessage {
  id: string
  channel_id: string
  guild_id?: string
  content: string
  author: GatewayMessageAuthor
  attachments?: GatewayAttachment[]
}

/** Ready facts the bridge needs: who the bot is, and how to resume. */
export interface GatewayReady {
  botUserId: string
  /** Application id used for command registration and interaction webhooks. */
  applicationId: string | undefined
  sessionId: string
  resumeGatewayUrl: string
}

/** One INTERACTION_CREATE dispatch, narrowed to the fields the bridge reads. */
export interface GatewayInteraction {
  id: string
  token: string
  channel_id?: string
  guild_id?: string
  /** Present for guild invocations; the user rides inside. */
  member?: { user?: GatewayMessageAuthor }
  /** Present for DM invocations. */
  user?: GatewayMessageAuthor
  data?: { name?: string; options?: { name: string; value?: unknown }[] }
}

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
}

/** Injected effects, so tests can drive the client without Discord. */
export interface GatewayHooks {
  onMessage: (message: GatewayMessage) => void
  onInteraction?: (interaction: GatewayInteraction) => void
  onReady?: (ready: GatewayReady) => void
  /** Terminal failure: the client stopped retrying (bad token, intent refusal). */
  onFatal?: (reason: string) => void
  log?: (level: 'info' | 'warn', text: string) => void
}

export interface GatewayOptions {
  token: string
  intents: number
  url?: string
  hooks: GatewayHooks
  /** Reconnect backoff cap in ms. */
  maxBackoffMs?: number
}

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/** Close codes after which retrying cannot help. 4014 is handled separately. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013])

/**
 * One long-lived gateway connection with identify/heartbeat/resume handling.
 * `start()` connects and keeps reconnecting until `stop()`.
 */
export class DiscordGateway {
  private readonly options: GatewayOptions
  private ws: WebSocket | undefined
  private stopped = true
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private lastSeq: number | null = null
  private sessionId: string | undefined
  private resumeUrl: string | undefined
  private backoffMs = 1000
  private ackReceived = true
  private intents: number

  constructor(options: GatewayOptions) {
    this.options = options
    this.intents = options.intents
  }

  /** Whether the client currently holds an open socket. */
  get connected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.ws !== undefined) {
      // 1000 tells Discord to invalidate the session; that is what we want on
      // an orderly plugin unload, so a later start() identifies fresh.
      try { this.ws.close(1000) } catch { /* already closing */ }
      this.ws = undefined
    }
  }

  private log(level: 'info' | 'warn', text: string): void {
    this.options.hooks.log?.(level, text)
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private connect(): void {
    if (this.stopped) return
    const url = this.resumeUrl ?? this.options.url ?? DEFAULT_GATEWAY_URL
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.log('warn', `gateway connect failed: ${String(error)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let payload: GatewayPayload
      try {
        payload = JSON.parse(event.data) as GatewayPayload
      } catch {
        return
      }
      this.handle(ws, payload)
    })
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.clearTimers()
      if (this.stopped) return
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.stopped = true
        this.options.hooks.onFatal?.(`gateway closed with terminal code ${String(event.code)}: ${event.reason}`)
        return
      }
      if (event.code === 4014) {
        // Disallowed intents: drop MESSAGE_CONTENT once and retry. DM content
        // arrives regardless of this intent, so the bridge stays useful.
        if ((this.intents & INTENTS.MESSAGE_CONTENT) !== 0) {
          this.intents &= ~INTENTS.MESSAGE_CONTENT
          this.sessionId = undefined
          this.resumeUrl = undefined
          this.log('warn', 'MESSAGE_CONTENT intent refused (enable it in the Discord developer portal); '
            + 'retrying without it — guild-channel message text will be empty, DMs still work')
          this.scheduleReconnect()
          return
        }
        this.stopped = true
        this.options.hooks.onFatal?.('gateway refused the requested intents')
        return
      }
      // 4007/4009 and any network close: prefer resume when Discord allows it.
      if (event.code === 4007 || event.code === 4009) {
        this.sessionId = undefined
        this.resumeUrl = undefined
      }
      this.log('warn', `gateway closed (${String(event.code)}); reconnecting`)
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // The paired close event carries the retry decision.
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 60_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private send(ws: WebSocket, payload: GatewayPayload): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }

  private handle(ws: WebSocket, payload: GatewayPayload): void {
    if (payload.s !== undefined && payload.s !== null) this.lastSeq = payload.s
    switch (payload.op) {
      case 10: {
        const data = payload.d as { heartbeat_interval: number }
        this.startHeartbeat(ws, data.heartbeat_interval)
        if (this.sessionId !== undefined) {
          this.send(ws, {
            op: 6,
            d: { token: this.options.token, session_id: this.sessionId, seq: this.lastSeq },
          })
        } else {
          this.identify(ws)
        }
        return
      }
      case 11:
        this.ackReceived = true
        return
      case 1:
        this.send(ws, { op: 1, d: this.lastSeq })
        return
      case 7:
        // Discord asks us to reconnect and resume.
        try { ws.close(4900) } catch { /* closing */ }
        return
      case 9: {
        const resumable = payload.d === true
        if (!resumable) {
          this.sessionId = undefined
          this.resumeUrl = undefined
          this.lastSeq = null
        }
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) this.identify(ws)
        }, 1000 + Math.floor(Math.random() * 4000))
        return
      }
      case 0:
        this.dispatch(payload)
        return
      default:
    }
  }

  private identify(ws: WebSocket): void {
    if (this.sessionId !== undefined) return
    this.send(ws, {
      op: 2,
      d: {
        token: this.options.token,
        intents: this.intents,
        properties: { os: process.platform, browser: 'dsh-plugin-discord', device: 'dsh-plugin-discord' },
      },
    })
  }

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.ackReceived = true
    // First beat after a jittered fraction of the interval, per gateway docs.
    setTimeout(() => { this.send(ws, { op: 1, d: this.lastSeq }) }, Math.floor(intervalMs * Math.random()))
    this.heartbeatTimer = setInterval(() => {
      if (!this.ackReceived) {
        // Zombied connection: close and resume.
        try { ws.close(4901) } catch { /* closing */ }
        return
      }
      this.ackReceived = false
      this.send(ws, { op: 1, d: this.lastSeq })
    }, intervalMs)
  }

  private dispatch(payload: GatewayPayload): void {
    switch (payload.t) {
      case 'READY': {
        const data = payload.d as {
          user: { id: string }
          application?: { id?: string }
          session_id: string
          resume_gateway_url: string
        }
        this.sessionId = data.session_id
        this.resumeUrl = `${data.resume_gateway_url}/?v=10&encoding=json`
        this.backoffMs = 1000
        this.options.hooks.onReady?.({
          botUserId: data.user.id,
          applicationId: data.application?.id,
          sessionId: data.session_id,
          resumeGatewayUrl: data.resume_gateway_url,
        })
        return
      }
      case 'RESUMED':
        this.backoffMs = 1000
        this.log('info', 'gateway resumed')
        return
      case 'MESSAGE_CREATE': {
        const data = payload.d as GatewayMessage
        if (typeof data.id !== 'string' || typeof data.channel_id !== 'string') return
        this.options.hooks.onMessage(data)
        return
      }
      case 'INTERACTION_CREATE': {
        const data = payload.d as GatewayInteraction
        if (typeof data.id !== 'string' || typeof data.token !== 'string') return
        this.options.hooks.onInteraction?.(data)
        return
      }
      default:
    }
  }
}
