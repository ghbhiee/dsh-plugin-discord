/**
 * Relay dsh `ask_user_question` prompts to Discord inline components.
 *
 * The bridge cannot register a second user-questions provider (the slot is
 * exclusive and the web host owns it), so it joins as a PEER of the web
 * client instead: it consumes the host's own mux stream over a loopback
 * WebSocket (`/api/events.mux`, the same upgrade the browser performs),
 * renders `question/requested` frames for Discord-bound sessions as select
 * menus / modals, and settles answers through the same `POST /api/respond`
 * the browser uses. Whichever surface answers first wins;
 * `question/resolved` frames keep the other surface in sync — the stream
 * replays still-pending questions on (re)connect, so a bridge restart loses
 * nothing.
 *
 * @module dsh-plugin-discord/questions
 */

import type { DiscordRest } from './rest.ts'
import type { GatewayInteraction } from './gateway.ts'

/** One selectable option, as the wire carries it. */
interface QuestionOption {
  label: string
  description?: string
}

/** One question item from a `question/requested` frame. */
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** One answered item, as `POST /api/respond` expects it. */
interface AnswerItem {
  id: string
  selected: string[]
  custom?: string
}

interface PendingRelay {
  rpcId: string
  sessionId: string
  channelId: string
  questions: QuestionItem[]
  answers: Map<number, AnswerItem>
  /** Discord message ids posted for this request, index-aligned with questions. */
  messageIds: (string | undefined)[]
}

/** Discord component/interaction wire constants (numbers per Discord API v10). */
export const DISCORD = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  BUTTON_SECONDARY: 2,
  BUTTON_DANGER: 4,
  INTERACTION_COMPONENT: 3,
  INTERACTION_MODAL_SUBMIT: 5,
  CALLBACK_UPDATE_MESSAGE: 7,
  CALLBACK_MODAL: 9,
  TEXT_INPUT_PARAGRAPH: 2,
} as const

const truncate = (text: string, max: number): string =>
  (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** Compose the Discord message text for one question. */
export function formatQuestionContent(item: QuestionItem, index: number, total: number): string {
  const parts: string[] = []
  const counter = total > 1 ? `(${String(index + 1)}/${String(total)}) ` : ''
  parts.push(`❓ ${counter}**${truncate(item.header ?? '请确认', 80)}**`)
  parts.push(truncate(item.question, 900))
  if (item.detail !== undefined && item.detail.trim() !== '') {
    parts.push(truncate(item.detail, 700).split('\n').map(line => `> ${line}`).join('\n'))
  }
  if ((item.options ?? []).length === 0) parts.push('_点击下面的按钮输入回答。_')
  return truncate(parts.join('\n'), 1900)
}

/**
 * Build the component rows for one question: a select for the options (when
 * present), plus buttons for a free-text answer and cancelling the ask.
 * Custom ids embed the rpcId and question index — both well under Discord's
 * 100-char id budget, unlike caller-supplied question ids.
 */
export function buildComponents(rpcId: string, index: number, item: QuestionItem): unknown[] {
  const rows: unknown[] = []
  const options = (item.options ?? []).slice(0, 25)
  if (options.length > 0) {
    rows.push({
      type: DISCORD.ACTION_ROW,
      components: [{
        type: DISCORD.STRING_SELECT,
        custom_id: `q:${rpcId}:${String(index)}`,
        placeholder: truncate(item.multiSelect === true ? '选择一项或多项…' : '选择一项…', 100),
        min_values: 1,
        max_values: item.multiSelect === true ? options.length : 1,
        options: options.map((option, optionIndex) => ({
          value: String(optionIndex),
          label: truncate(option.label, 100),
          ...option.description === undefined ? {} : { description: truncate(option.description, 100) },
        })),
      }],
    })
  }
  rows.push({
    type: DISCORD.ACTION_ROW,
    components: [
      {
        type: DISCORD.BUTTON,
        style: DISCORD.BUTTON_SECONDARY,
        custom_id: `qc:${rpcId}:${String(index)}`,
        label: '✏️ 自定义回答',
      },
      {
        type: DISCORD.BUTTON,
        style: DISCORD.BUTTON_DANGER,
        custom_id: `qx:${rpcId}:${String(index)}`,
        label: '取消提问',
      },
    ],
  })
  return rows
}

/** Parsed identity of one bridge-owned component/modal custom id. */
export interface ParsedCustomId {
  kind: 'select' | 'custom' | 'cancel' | 'modal'
  rpcId: string
  index: number
}

/** Parse a custom id minted by {@link buildComponents}; undefined for foreign ids. */
export function parseCustomId(customId: string): ParsedCustomId | undefined {
  const match = /^(q|qc|qx|qm):([^:]+):(\d+)$/.exec(customId)
  if (match === null) return undefined
  const kinds = { q: 'select', qc: 'custom', qx: 'cancel', qm: 'modal' } as const
  return {
    kind: kinds[match[1] as keyof typeof kinds],
    rpcId: match[2] ?? '',
    index: Number(match[3]),
  }
}

export interface QuestionRelayOptions {
  /** Loopback origin of the dsh host, e.g. `http://127.0.0.1:3080`. */
  apiOrigin: string
  rest: DiscordRest
  /** Reverse binding lookup: which Discord channel owns this session. */
  channelForSession: (sessionId: string) => string | undefined
  log: (level: 'info' | 'warn', text: string) => void
}

/** The live relay; one per plugin instance. */
export class QuestionRelay {
  private readonly options: QuestionRelayOptions
  private readonly pending = new Map<string, PendingRelay>()
  private stopped = true
  private ws: WebSocket | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private backoffMs = 1000

  constructor(options: QuestionRelayOptions) {
    this.options = options
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    try { this.ws?.close(1000) } catch { /* closing */ }
    this.ws = undefined
  }

  /**
   * Attach to the host's mux WebSocket (the same `/api/events.mux` upgrade the
   * browser performs); pending questions replay on every (re)connect.
   */
  private connect(): void {
    if (this.stopped) return
    const url = `${this.options.apiOrigin.replace(/^http/, 'ws')}/api/events.mux`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.options.log('warn', `mux socket open failed: ${String(error)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.backoffMs = 1000
      this.options.log('info', 'question relay attached to mux stream')
    })
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.handleFrame(event.data)
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = undefined
      if (this.stopped) return
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => { /* the paired close event reconnects */ })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private handleFrame(data: string): void {
    let envelope: { rpcId?: string; payload?: { type?: string } }
    try {
      envelope = JSON.parse(data) as typeof envelope
    } catch {
      return
    }
    const payload = envelope.payload
    if (payload?.type === 'question/requested' && envelope.rpcId !== undefined) {
      const frame = payload as { sessionId: string; questions: QuestionItem[] }
      void this.onRequested(envelope.rpcId, frame.sessionId, frame.questions)
    } else if (payload?.type === 'question/resolved') {
      const frame = payload as { sessionId: string; questionRpcId: string; outcome: string }
      void this.onResolved(frame.questionRpcId, frame.outcome)
    }
  }

  private async onRequested(rpcId: string, sessionId: string, questions: QuestionItem[]): Promise<void> {
    if (this.pending.has(rpcId)) return // reconnect replay of a question we already posted
    const channelId = this.options.channelForSession(sessionId)
    if (channelId === undefined) return // not a Discord-bound session
    const relay: PendingRelay = {
      rpcId, sessionId, channelId, questions,
      answers: new Map(),
      messageIds: questions.map(() => undefined),
    }
    this.pending.set(rpcId, relay)
    try {
      for (const [index, item] of questions.entries()) {
        const message = await this.options.rest.createComponentMessage(
          channelId,
          formatQuestionContent(item, index, questions.length),
          buildComponents(rpcId, index, item),
        )
        relay.messageIds[index] = message.id
      }
    } catch (error) {
      this.options.log('warn', `question relay post failed: ${String(error)}`)
    }
  }

  private async onResolved(rpcId: string, outcome: string): Promise<void> {
    const relay = this.pending.get(rpcId)
    if (relay === undefined) return
    this.pending.delete(rpcId)
    const note = outcome === 'answered' ? '✅ 已回答(可能来自 web 端)。' : '⏹️ 提问已取消。'
    for (const [index, messageId] of relay.messageIds.entries()) {
      if (messageId === undefined) continue
      const item = relay.questions[index]
      if (item === undefined) continue
      await this.options.rest.editMessage(
        relay.channelId,
        messageId,
        `${formatQuestionContent(item, index, relay.questions.length)}\n\n${note}`,
        [],
      ).catch(() => { /* cosmetic */ })
    }
  }

  /**
   * Handle one component/modal interaction. Returns false when the custom id
   * is not ours, so the caller can route it elsewhere.
   */
  async handleInteraction(interaction: GatewayInteraction): Promise<boolean> {
    const customId = interaction.data?.custom_id
    if (customId === undefined) return false
    const parsed = parseCustomId(customId)
    if (parsed === undefined) return false
    const relay = this.pending.get(parsed.rpcId)
    if (relay === undefined) {
      await this.options.rest.respondInteraction(interaction.id, interaction.token, {
        type: DISCORD.CALLBACK_UPDATE_MESSAGE,
        data: { content: '⌛ 这个提问已经结束(可能已在别处回答)。', components: [] },
      }).catch(() => { /* stale */ })
      return true
    }
    const item = relay.questions[parsed.index]
    if (item === undefined) return true

    if (parsed.kind === 'cancel') {
      await this.respondToHost(relay, undefined)
      await this.options.rest.respondInteraction(interaction.id, interaction.token, {
        type: DISCORD.CALLBACK_UPDATE_MESSAGE,
        data: { content: `~~${formatQuestionContent(item, parsed.index, relay.questions.length).split('\n')[0] ?? ''}~~\n⏹️ 已取消。`, components: [] },
      })
      return true
    }

    if (parsed.kind === 'custom') {
      await this.options.rest.respondInteraction(interaction.id, interaction.token, {
        type: DISCORD.CALLBACK_MODAL,
        data: {
          custom_id: `qm:${parsed.rpcId}:${String(parsed.index)}`,
          title: truncate(item.question, 45),
          components: [{
            type: DISCORD.ACTION_ROW,
            components: [{
              type: DISCORD.TEXT_INPUT,
              custom_id: 'answer',
              style: DISCORD.TEXT_INPUT_PARAGRAPH,
              label: truncate('你的回答', 45),
              required: true,
              max_length: 1500,
            }],
          }],
        },
      })
      return true
    }

    let answer: AnswerItem
    if (parsed.kind === 'modal') {
      const rows = (interaction.data?.components ?? []) as { components?: { custom_id?: string; value?: string }[] }[]
      const value = rows[0]?.components?.[0]?.value ?? ''
      answer = { id: item.id, selected: [], custom: value }
    } else {
      const values = interaction.data?.values ?? []
      const labels = values
        .map(value => (item.options ?? [])[Number(value)]?.label)
        .filter((label): label is string => label !== undefined)
      answer = { id: item.id, selected: labels }
    }
    relay.answers.set(parsed.index, answer)

    const chosen = answer.custom !== undefined ? `✏️ ${answer.custom}` : answer.selected.join('、')
    const remaining = relay.questions.length - relay.answers.size
    const status = remaining > 0 ? `\n(还有 ${String(remaining)} 个问题待回答)` : ''
    await this.options.rest.respondInteraction(interaction.id, interaction.token, {
      type: DISCORD.CALLBACK_UPDATE_MESSAGE,
      data: {
        content: `${formatQuestionContent(item, parsed.index, relay.questions.length)}\n\n✅ 已选择: **${truncate(chosen, 300)}**${status}`,
        components: [],
      },
    }).catch((error: unknown) => {
      this.options.log('warn', `interaction ack failed: ${String(error)}`)
    })

    if (relay.answers.size === relay.questions.length) {
      await this.respondToHost(relay, [...relay.answers.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value))
    }
    return true
  }

  /** Settle the ask at the host: answers, or `undefined` to cancel it. */
  private async respondToHost(relay: PendingRelay, answers: AnswerItem[] | undefined): Promise<void> {
    const body = {
      type: 'client-response',
      rpcId: relay.rpcId,
      result: answers === undefined
        ? { ok: false, error: { code: 'cancelled', message: 'cancelled from Discord', details: {} } }
        : { ok: true, value: { sessionId: relay.sessionId, answer: { answers } } },
    }
    try {
      const response = await fetch(`${this.options.apiOrigin}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const receipt = await response.json().catch(() => ({})) as { accepted?: boolean; reason?: string }
      if (receipt.accepted !== true) {
        this.options.log('warn', `host rejected the answer: ${receipt.reason ?? String(response.status)}`)
        await this.options.rest.createMessage(relay.channelId, `⚠️ 答案未被接受(${receipt.reason ?? 'unknown'}),可能已在 web 端处理。`).catch(() => { /* cosmetic */ })
      }
      // The question/resolved frame performs the cleanup on acceptance.
    } catch (error) {
      this.options.log('warn', `respond failed: ${String(error)}`)
    }
  }
}
