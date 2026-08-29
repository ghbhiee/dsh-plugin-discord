/**
 * Relay dsh `ask_user_question` prompts to Discord inline components.
 *
 * The harness dispatches questions on the Agent-scoped Cordis waterfall
 * `user-questions/request`: a listener either returns an answer (claiming the
 * request) or calls `next()` to delegate to the surfaces behind it — the
 * browser among them. This bridge listens at the root, so it sees every
 * agent's question; for a session bound to a Discord channel it posts select
 * menus / modals AND delegates in parallel, so the same question is answerable
 * from Discord or from the web UI, whichever the user reaches first.
 *
 * (Before dsh 0.1.1 the slot was a single exclusive provider owned by the web
 * host, and this bridge had to join as a loopback peer of the browser over
 * `/api/events.mux`. That transport is gone — the API now requires browser
 * authentication — and the waterfall replaces it with an in-process seat.)
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

/**
 * The harness question waterfall, declared locally.
 *
 * The event exists on the running host (dsh >= 0.1.1) but not in the type
 * packages this plugin builds against, and the payload is structural — so the
 * seat is declared here rather than pinning a build to one harness release.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(
      request: AskRequest,
      next: () => Promise<AskAnswer>,
    ): Promise<AskAnswer>
  }
}

/** One pending question request as the waterfall carries it. */
export interface AskRequest {
  questions: QuestionItem[]
  agent?: { id: string }
  signal?: AbortSignal
}

/** The settled answer the waterfall returns. */
export interface AskAnswer {
  answers: AnswerItem[]
}

/** One question item from the request. */
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** One answered item, in the shape the harness answer carries. */
export interface AnswerItem {
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
  rest: DiscordRest
  /** Reverse binding lookup: which Discord channel owns this session. */
  channelForSession: (sessionId: string) => string | undefined
  log: (level: 'info' | 'warn', text: string) => void
}

/** One pending ask, keyed by the id minted for its components. */
interface AskWaiter {
  resolve: (answer: AskAnswer) => void
  reject: (error: Error) => void
}

/** The live relay; one per plugin instance. */
export class QuestionRelay {
  private readonly options: QuestionRelayOptions
  private readonly pending = new Map<string, PendingRelay>()
  private readonly waiters = new Map<string, AskWaiter>()
  private counter = 0

  constructor(options: QuestionRelayOptions) {
    this.options = options
  }

  /** Discard every pending ask; the plugin is unloading. */
  stop(): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id)
      this.pending.delete(id)
      waiter.reject(new Error('discord bridge unloaded'))
    }
  }

  /**
   * One seat on the `user-questions/request` waterfall.
   *
   * A question for a session no session-bound channel owns is delegated
   * untouched. Otherwise the cards go to Discord and the delegation runs
   * alongside them, so the browser keeps its copy: the first surface to
   * answer settles the ask, and a web answer visibly closes the Discord card.
   * @param request - the pending question request.
   * @param next - delegation to the surfaces behind this one.
   * @returns the answer from whichever surface responded first.
   */
  async handleAsk(request: AskRequest, next: () => Promise<AskAnswer>): Promise<AskAnswer> {
    const sessionId = request.agent?.id
    const channelId = sessionId === undefined ? undefined : this.options.channelForSession(sessionId)
    if (channelId === undefined || request.questions.length === 0) return await next()

    this.counter += 1
    const askId = `a${String(this.counter)}`
    const relay: PendingRelay = {
      rpcId: askId,
      sessionId: sessionId ?? '',
      channelId,
      questions: request.questions,
      answers: new Map(),
      messageIds: request.questions.map(() => undefined),
    }
    this.pending.set(askId, relay)

    const fromDiscord = new Promise<AskAnswer>((resolve, reject) => {
      this.waiters.set(askId, { resolve, reject })
    })
    const onAbort = (): void => {
      const waiter = this.waiters.get(askId)
      if (waiter === undefined) return
      this.waiters.delete(askId)
      waiter.reject(new Error('question aborted'))
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for (const [index, item] of request.questions.entries()) {
        const message = await this.options.rest.createComponentMessage(
          channelId,
          formatQuestionContent(item, index, request.questions.length),
          buildComponents(askId, index, item),
        )
        relay.messageIds[index] = message.id
      }
    } catch (error) {
      // Without a card there is nothing to answer from Discord: fall back to
      // the surfaces behind us rather than stalling the turn.
      this.options.log('warn', `question card post failed: ${String(error)}`)
      this.cleanup(askId)
      request.signal?.removeEventListener('abort', onAbort)
      return await next()
    }

    const elsewhere = next().then(async (answer) => {
      await this.closeCards(relay, '✅ 已回答(来自 web 界面)。')
      return answer
    })
    try {
      return await Promise.race([fromDiscord, elsewhere])
    } finally {
      this.cleanup(askId)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Strike through the posted cards once the ask is settled elsewhere. */
  private async closeCards(relay: PendingRelay, note: string): Promise<void> {
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

  private cleanup(askId: string): void {
    this.pending.delete(askId)
    this.waiters.delete(askId)
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
      this.settle(parsed.rpcId, undefined)
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
      this.settle(parsed.rpcId, [...relay.answers.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value))
    }
    return true
  }

  /**
   * Settle the waiting ask from Discord.
   * @param askId - the id minted for this ask.
   * @param answers - the collected answers, or undefined to cancel the ask.
   */
  private settle(askId: string, answers: AnswerItem[] | undefined): void {
    const waiter = this.waiters.get(askId)
    if (waiter === undefined) return
    this.waiters.delete(askId)
    this.pending.delete(askId)
    if (answers === undefined) {
      waiter.reject(new Error('the user cancelled the question from Discord'))
      return
    }
    waiter.resolve({ answers })
  }
}
