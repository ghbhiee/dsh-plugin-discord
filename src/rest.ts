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

  private async request(method: string, path: string, body?: unknown, form?: FormData): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'authorization': `Bot ${this.token}`,
          // Discord (behind Cloudflare) rejects requests without a proper
          // bot-style User-Agent with an opaque 403.
          'user-agent': 'DiscordBot (https://github.com/ghbhiee/dsh-plugin-discord, 0.1.0)',
          // FormData carries its own multipart content-type (with boundary).
          ...body === undefined || form !== undefined ? {} : { 'content-type': 'application/json' },
        },
        ...form !== undefined ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) },
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

  /** Send one message carrying file attachments (multipart upload). */
  async createMessageWithFiles(
    channelId: string,
    content: string,
    files: readonly { filename: string; data: Uint8Array }[],
  ): Promise<{ id: string }> {
    const form = new FormData()
    form.append('payload_json', JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
      attachments: files.map((file, index) => ({ id: index, filename: file.filename })),
    }))
    files.forEach((file, index) => {
      form.append(`files[${String(index)}]`, new Blob([file.data]), file.filename)
    })
    return await this.request('POST', `/channels/${channelId}/messages`, {}, form) as { id: string }
  }

  /** Replace the application's global slash commands (idempotent bulk overwrite). */
  async bulkOverwriteCommands(applicationId: string, commands: readonly unknown[]): Promise<void> {
    await this.request('PUT', `/applications/${applicationId}/commands`, commands)
  }

  /** Acknowledge an interaction with a deferred reply ("thinking…", 15-minute window). */
  async ackDeferred(interactionId: string, interactionToken: string): Promise<void> {
    await this.request('POST', `/interactions/${interactionId}/${interactionToken}/callback`, { type: 5 })
  }

  /** Immediately answer an interaction with an ephemeral message (only the invoker sees it). */
  async ackEphemeral(interactionId: string, interactionToken: string, content: string): Promise<void> {
    await this.request('POST', `/interactions/${interactionId}/${interactionToken}/callback`, {
      type: 4,
      data: { content, flags: 64, allowed_mentions: { parse: [] } },
    })
  }

  /** Fill in the deferred reply. */
  async editOriginalResponse(applicationId: string, interactionToken: string, content: string): Promise<void> {
    await this.request('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
      content,
      allowed_mentions: { parse: [] },
    })
  }

  /** Additional chunks after the deferred reply. */
  async followupResponse(applicationId: string, interactionToken: string, content: string): Promise<void> {
    await this.request('POST', `/webhooks/${applicationId}/${interactionToken}`, {
      content,
      allowed_mentions: { parse: [] },
    })
  }
}
