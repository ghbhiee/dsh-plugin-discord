/**
 * Discord REST calls the bridge needs, over global fetch. Retries once per
 * 429 with the server-instructed delay; other failures surface to the caller.
 *
 * @module dsh-plugin-discord/rest
 */

const API_BASE = 'https://discord.com/api/v10'

export interface RestClientOptions {
  token: string
  /** Test seam: overrides the API origin. */
  baseUrl?: string
  /** Cap on 429 retries per call. */
  maxRateLimitRetries?: number
}

/** Thin Discord REST client scoped to what the bridge uses. */
export class DiscordRest {
  private readonly token: string
  private readonly base: string
  private readonly maxRetries: number

  constructor(options: RestClientOptions) {
    this.token = options.token
    this.base = options.baseUrl ?? API_BASE
    this.maxRetries = options.maxRateLimitRetries ?? 3
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'authorization': `Bot ${this.token}`,
          // Discord (behind Cloudflare) rejects requests without a proper
          // bot-style User-Agent with an opaque 403.
          'user-agent': 'DiscordBot (https://github.com/ghbhiee/dsh-plugin-discord, 0.1.0)',
          ...body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      if (response.status === 429 && attempt < this.maxRetries) {
        const data = await response.json().catch(() => ({})) as { retry_after?: number }
        const waitMs = Math.ceil(((data.retry_after ?? 1) + 0.05) * 1000)
        await new Promise(resolve => setTimeout(resolve, waitMs))
        continue
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`discord REST ${method} ${path} failed: ${String(response.status)} ${text.slice(0, 300)}`)
      }
      if (response.status === 204) return undefined
      return await response.json()
    }
  }

  /** Identity check; throws on a bad token. */
  async getMe(): Promise<{ id: string; username: string }> {
    return await this.request('GET', '/users/@me') as { id: string; username: string }
  }

  /** Send one message (caller has already chunked to <= 2000 chars). */
  async createMessage(channelId: string, content: string, replyToMessageId?: string): Promise<{ id: string }> {
    return await this.request('POST', `/channels/${channelId}/messages`, {
      content,
      // Never ping roles/everyone from a bridge; replies still highlight the author.
      allowed_mentions: { parse: [] },
      ...replyToMessageId === undefined
        ? {}
        : { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } },
    }) as { id: string }
  }

  /** Typing indicator; Discord shows it ~10s, callers re-trigger while busy. */
  async triggerTyping(channelId: string): Promise<void> {
    await this.request('POST', `/channels/${channelId}/typing`)
  }
}
