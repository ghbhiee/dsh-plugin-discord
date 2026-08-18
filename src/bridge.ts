/**
 * The session side of the bridge: bind Discord channels to dsh sessions,
 * create/resume agents exactly the way the web host does, drive turns, and
 * fold replies.
 *
 * Sessions created here are ordinary web sessions: they are composed from the
 * same agent-preset roster the web UI uses (`agentPresets.mount`), persisted by
 * the same persistence, and listed by the same `session.list` — so the web UI
 * can open, continue, and rename them, and this bridge can adopt sessions the
 * web created. The Discord provenance is carried in the pinned title prefix.
 *
 * @module dsh-plugin-discord/bridge
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { HostModules } from './host-modules.ts'
import type { BridgeCommand } from './commands.ts'
import { HELP_TEXT } from './commands.ts'
import { chunkReply } from './chunk.ts'
import { extractReply, findPromptSeq } from './reply.ts'
import type { BindingStore } from './state.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A prompt relayed from Discord. `kind` stays `'user'` — the model face
     * carries no transport vocabulary; the Discord ids are durable JSON fields
     * the bridge uses to find its own prompt in the log (the same pattern the
     * web client uses with rpcId).
     */
    'user-discord': { kind: 'user'; discordMessageId: string; discordChannelId: string }
  }
}

/** Deployment knobs the bridge reads. */
export interface BridgeConfig {
  /** Working directory new sessions are created in. */
  cwd: string
  /** Agent preset for new sessions; empty string composes the deployment default. */
  preset: string
  /** Title prefix marking a session as Discord-originated. */
  titlePrefix: string
  /** Cap on Discord messages per reply. */
  maxChunksPerReply: number
}

/** Session-header facts the bridge reads from persistence listings. */
interface HeaderLike {
  id: string
  cwd?: string
  createdAt: number
  agentPreset?: string
}

/** Bridges parsed Discord commands onto dsh agents. One instance per plugin. */
export class SessionBridge {
  private readonly ctx: Context
  private readonly host: HostModules
  private readonly store: BindingStore
  private readonly config: BridgeConfig
  private readonly log: (level: 'info' | 'warn', text: string) => void
  /** Per-channel promise chain: one channel's prompts run strictly in order. */
  private readonly channelChains = new Map<string, Promise<void>>()
  /** Deduplicates concurrent create/resume of one session id. */
  private readonly acquisitions = new Map<string, Promise<Agent>>()

  constructor(options: {
    ctx: Context
    host: HostModules
    store: BindingStore
    config: BridgeConfig
    log: (level: 'info' | 'warn', text: string) => void
  }) {
    this.ctx = options.ctx
    this.host = options.host
    this.store = options.store
    this.config = options.config
    this.log = options.log
  }

  /**
   * Handle one parsed command; replies are returned as sendable chunks.
   * Prompts serialize per channel; management commands answer immediately.
   * @param command - the parsed instruction.
   * @param channelId - Discord channel the message arrived in.
   * @param messageId - Discord message id (stamped onto the prompt's source).
   * @param beginTyping - starts a typing indicator; returns its stopper.
   * @returns reply chunks, each within Discord's message limit.
   */
  async handle(
    command: BridgeCommand,
    channelId: string,
    messageId: string,
    beginTyping: () => () => void,
  ): Promise<string[]> {
    switch (command.kind) {
      case 'help':
        return [HELP_TEXT]
      case 'new':
        return await this.commandNew(channelId, command.label)
      case 'sessions':
        return await this.commandSessions(channelId)
      case 'use':
        return await this.commandUse(channelId, command.sessionId)
      case 'current':
        return await this.commandCurrent(channelId)
      case 'stop':
        return this.commandStop(channelId)
      case 'prompt':
        return await this.enqueuePrompt(channelId, messageId, command.text, beginTyping)
    }
  }

  private sessionId(id: string): SessionIdType {
    return this.host.SessionId(id.startsWith('session-') ? id : `session-${id}`)
  }

  private defaultSelection(): ModelSelection {
    const service = this.ctx.get('agentDefaultModel')
    if (service === undefined) throw new Error('agentDefaultModel service is unavailable')
    return service.currentSelection()
  }

  /**
   * Install the log-following model selection the web host installs, so a
   * session driven from both surfaces converges on the same route. Reading
   * the logged request header (not a creation-time snapshot) means a model
   * switched in the web UI carries over to later Discord turns.
   */
  private installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('discord-bridge: agent setup has no scoped agent')
    let picked: ModelSelection | undefined
    const bridge = this
    this.host.installModelSelection(agentCtx, {
      get current(): ModelSelection {
        if (picked !== undefined) return picked
        const logged = agent.session.requestHeader()?.config
        if (logged === undefined) return bridge.defaultSelection()
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
        }
      },
      set current(next: ModelSelection | undefined) {
        picked = next
      },
      assembled: undefined,
    })
  }

  /** Compose the preset-mounting setup the web host uses for the same session. */
  private async composeSetup(presetId: string | undefined): Promise<{
    agentPreset?: string
    setup: (agentCtx: Context) => Promise<void>
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return {
        setup: (agentCtx: Context) => {
          this.installSelection(agentCtx)
          return Promise.resolve()
        },
      }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx: Context) => {
        this.installSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  /** Create a fresh session the web UI can open, and bind the channel to it. */
  private async createSession(channelId: string, label: string): Promise<{ agent: Agent; title: string }> {
    // Parity with the web host's ensureSession: the configured cwd may not
    // exist yet, and an absent working directory breaks the session's tools.
    try {
      await mkdir(this.config.cwd, { recursive: true })
    } catch (error) {
      throw new Error(`failed to ensure session cwd "${this.config.cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeSetup(this.config.preset === '' ? undefined : this.config.preset)
    const id = `session-${randomUUID()}`
    const handle = await this.ctx.agents.create({
      sessionId: this.host.SessionId(id),
      meta: {
        cwd: this.config.cwd,
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })
    const title = this.composeTitle(label)
    this.applyTitle(handle.agent, title)
    this.store.set(channelId, id)
    return { agent: handle.agent, title }
  }

  private agentOptions(): { provider: string; model: string } {
    const { provider, model } = this.defaultSelection()
    return { provider, model }
  }

  private composeTitle(label: string): string {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const body = label === '' ? stamp : `${label} · ${stamp}`
    return `${this.config.titlePrefix}${body}`
  }

  /** Pin the Discord marker title; a deployment without the service keeps the fallback title. */
  private applyTitle(agent: Agent, title: string): void {
    const titles = this.ctx.get('sessionTitle') as
      | { rename: (session: Agent['session'], title: string) => unknown }
      | undefined
    if (titles === undefined) return
    try {
      titles.rename(agent.session, title)
    } catch (error) {
      this.log('warn', `session title rename failed: ${String(error)}`)
    }
  }

  /**
   * Resolve one session id to a live agent, resuming it the way the web host
   * does: composed from the preset the log records.
   */
  private async acquire(rawId: string): Promise<Agent> {
    const id = this.sessionId(rawId)
    const live = this.ctx.agents.get(id)
    if (live !== undefined) return live
    let acquisition = this.acquisitions.get(id)
    if (acquisition === undefined) {
      acquisition = (async () => {
        const again = this.ctx.agents.get(id)
        if (again !== undefined) return again
        const persistence = this.ctx.get('sessionPersistence')
        if (persistence === undefined) throw new Error('session persistence is unavailable')
        const inspected = await persistence.inspect(id)
        const storedPreset = this.host.resolveSessionPreset({ header: inspected.meta, events: inspected.events })
        const composition = await this.composeSetup(storedPreset)
        return (await this.ctx.agents.resume({
          resumeSessionId: id,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        })).agent
      })().finally(() => { this.acquisitions.delete(id) })
      this.acquisitions.set(id, acquisition)
    }
    return await acquisition
  }

  /** The channel's agent: bound session when it still exists, else a new one. */
  private async ensureChannelAgent(channelId: string): Promise<{ agent: Agent; created: boolean; title?: string }> {
    const bound = this.store.get(channelId)
    if (bound !== undefined) {
      try {
        return { agent: await this.acquire(bound), created: false }
      } catch (error) {
        this.log('warn', `bound session ${bound} could not be resumed (${String(error)}); creating a new one`)
      }
    }
    const created = await this.createSession(channelId, '')
    return { agent: created.agent, created: true, title: created.title }
  }

  private async enqueuePrompt(
    channelId: string,
    messageId: string,
    text: string,
    beginTyping: () => () => void,
  ): Promise<string[]> {
    const previous = this.channelChains.get(channelId) ?? Promise.resolve()
    const run = previous.then(async () => await this.runPrompt(channelId, messageId, text, beginTyping))
    this.channelChains.set(channelId, run.then(() => undefined, () => undefined))
    return await run
  }

  private async runPrompt(
    channelId: string,
    messageId: string,
    text: string,
    beginTyping: () => () => void,
  ): Promise<string[]> {
    const stopTyping = beginTyping()
    try {
      const { agent, created, title } = await this.ensureChannelAgent(channelId)
      const preamble = created && title !== undefined
        ? [`(已自动新建会话 **${title}** · \`${agent.id}\`)`]
        : []
      agent.followup(this.host.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user', discordMessageId: messageId, discordChannelId: channelId },
      }))
      await agent.whenIdle()
      const flushable = this.ctx.get('sessions')
      if (flushable !== undefined) await flushable.flush(agent.session)

      const events = agent.session.events as readonly { seq: number; type: string; data?: unknown }[]
      const promptSeq = findPromptSeq(events, messageId)
      if (promptSeq === undefined) {
        return [...preamble, '⚠️ 消息没有进入会话(可能被取消),请重试。']
      }
      const reply = extractReply(events, promptSeq)
      if (reply.reasonKind === 'completed' || (reply.reasonKind === undefined && reply.text !== '')) {
        const chunks = chunkReply(reply.text, this.config.maxChunksPerReply)
        return chunks.length === 0 ? [...preamble, '(本回合没有文本回复)'] : [...preamble, ...chunks]
      }
      if (reply.reasonKind === 'cancelled') return [...preamble, '⏹️ 回合被取消。']
      const detail = reply.errorMessage ?? reply.reasonKind ?? 'unknown'
      return [...preamble, `⚠️ 回合失败: ${detail}`]
    } catch (error) {
      this.log('warn', `prompt failed: ${String(error)}`)
      return [`⚠️ 出错了: ${error instanceof Error ? error.message : String(error)}`]
    } finally {
      stopTyping()
    }
  }

  private async commandNew(channelId: string, label: string): Promise<string[]> {
    try {
      const { agent, title } = await this.createSession(channelId, label)
      return [`✅ 已新建会话 **${title}**\nid: \`${agent.id}\`\n这个会话和 web 界面完全共享,直接发消息即可对话。`]
    } catch (error) {
      return [`⚠️ 新建会话失败: ${error instanceof Error ? error.message : String(error)}`]
    }
  }

  private async commandSessions(channelId: string): Promise<string[]> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return ['⚠️ 会话持久化服务不可用。']
    const bound = this.store.get(channelId)
    const headers = (await persistence.list()) as readonly HeaderLike[]
    const boundIds = new Set(this.store.entries().map(([, session]) => session))
    const mine = headers
      .filter(header => boundIds.has(header.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
    const lines = mine.map((header) => {
      const marker = header.id === bound ? '👉 ' : ''
      const created = new Date(header.createdAt)
      const pad = (value: number): string => String(value).padStart(2, '0')
      const stamp = `${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`
      return `${marker}\`${header.id}\` · ${stamp}`
    })
    if (lines.length === 0) return ['还没有 Discord 桥接过的会话。发 `/new` 或直接发消息开始。']
    return [[`**Discord 桥接过的会话**(👉 = 本频道当前绑定)`, ...lines, '用 `/use <id>` 切换;web 上任意会话的 id 也可以。'].join('\n')]
  }

  private async commandUse(channelId: string, rawId: string): Promise<string[]> {
    if (rawId === '') return ['用法: `/use <会话id>`']
    try {
      const agent = await this.acquire(rawId)
      this.store.set(channelId, agent.id)
      return [`✅ 本频道已绑定会话 \`${agent.id}\`,直接发消息继续对话。`]
    } catch (error) {
      return [`⚠️ 绑定失败: ${error instanceof Error ? error.message : String(error)}`]
    }
  }

  private async commandCurrent(channelId: string): Promise<string[]> {
    const bound = this.store.get(channelId)
    if (bound === undefined) return ['本频道还没有绑定会话;发消息会自动新建,或用 `/new`、`/use <id>`。']
    const live = this.ctx.agents.get(this.sessionId(bound))
    const status = live === undefined ? '未加载(冷会话)' : live.status
    return [`当前会话: \`${bound}\`\n状态: ${String(status)}`]
  }

  private commandStop(channelId: string): string[] {
    const bound = this.store.get(channelId)
    if (bound === undefined) return ['本频道还没有绑定会话。']
    const live = this.ctx.agents.get(this.sessionId(bound))
    if (live === undefined) return ['会话未在运行,无需取消。']
    live.cancel({ kind: 'user' })
    return ['⏹️ 已请求取消当前回合。']
  }
}
