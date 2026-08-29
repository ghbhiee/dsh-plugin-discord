/**
 * Discord bridge for DeepSeek Harness.
 *
 * Connects one Discord bot to the web profile's session store: messages from
 * allowlisted users drive ordinary dsh sessions — the same sessions the web
 * UI lists, opens, and continues — and `/new` starts a fresh one named with a
 * date-stamped `[Discord]` title so its origin is visible in the sidebar.
 *
 * @module dsh-plugin-discord
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import { DiscordGateway, INTENTS } from './gateway.ts'
import type { GatewayInteraction, GatewayMessage } from './gateway.ts'
import { DiscordRest } from './rest.ts'
import { APPLICATION_COMMANDS, commandFromInteraction, parseCommand } from './commands.ts'
import { SessionBridge } from './bridge.ts'
import { createNotifyHandler, DiscordNotifier } from './notify.ts'
import { QuestionRelay } from './questions.ts'
import { BindingStore } from './state.ts'
import { loadHostModules } from './host-modules.ts'

/** Cordis plugin name. */
export const name = 'discord-bridge'

/** Core services required before the bridge can start. webServer carries the notify/MCP surface. */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'webServer']

/** Deployment-varying knobs. */
export interface Config {
  /** Bot token; empty falls back to `tokenEnv`, then `tokenFile`. */
  token: string
  /** Environment variable consulted when `token` is empty. */
  tokenEnv: string
  /** File to read the token from (keeps the secret out of profile YAML). Raw token, or an env-style file. */
  tokenFile: string
  /** Key looked up when `tokenFile` is env-style (`KEY=value` lines). */
  tokenFileKey: string
  /** Discord user ids allowed to talk to the bridge. Required for DMs. */
  allowedUsers: string[]
  /** Guild channel ids the bridge listens in; empty means DM-only. */
  allowedChannels: string[]
  /** Working directory new sessions are created in. */
  cwd: string
  /** Agent preset for new sessions; empty composes the deployment default. */
  preset: string
  /** Title prefix marking a session as Discord-originated. */
  titlePrefix: string
  /** Cap on Discord messages sent per reply. */
  maxChunksPerReply: number
  /** Cap on one outgoing attachment the agent sends via [discord-file: …]. */
  maxUploadBytes: number
  /** Directories (besides the session cwd) the agent may upload files from. */
  uploadRoots: string[]
  /** Cap on one incoming Discord attachment saved to disk. */
  maxIncomingBytes: number
  /** Channel→session binding file; empty derives one under the profile directory. */
  stateFile: string
  /** Typing-indicator refresh cadence while a turn runs. */
  typingIntervalMs: number
  /** Gateway URL override; empty uses Discord. A test seam for a local fake gateway. */
  gatewayUrl: string
  /** REST origin override; empty uses Discord. A test seam for a local fake API. */
  restBaseUrl: string
  /** Enable the proactive-notify HTTP API + MCP endpoint under /plugins/discord. */
  notifyEnabled: boolean
  /** Bearer secret for the notify surface; empty falls back to `notifySecretEnv`, then an auto-generated persisted secret. */
  notifySecret: string
  /** Environment variable consulted when `notifySecret` is empty. */
  notifySecretEnv: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  token: z.string().default(''),
  tokenEnv: z.string().default('DSH_DISCORD_TOKEN'),
  tokenFile: z.string().default(''),
  tokenFileKey: z.string().default('DISCORD_BOT_TOKEN'),
  allowedUsers: z.array(z.string()).default([]),
  allowedChannels: z.array(z.string()).default([]),
  cwd: z.string().default(homedir()),
  preset: z.string().default(''),
  titlePrefix: z.string().default('[Discord] '),
  maxChunksPerReply: z.number().default(6),
  maxUploadBytes: z.number().default(8_000_000),
  uploadRoots: z.array(z.string()).default([]),
  maxIncomingBytes: z.number().default(25_000_000),
  stateFile: z.string().default(''),
  typingIntervalMs: z.number().default(8000),
  gatewayUrl: z.string().default(''),
  restBaseUrl: z.string().default(''),
  notifyEnabled: z.boolean().default(true),
  notifySecret: z.string().default(''),
  notifySecretEnv: z.string().default('DSH_DISCORD_NOTIFY_SECRET'),
})

interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

function loggerOf(ctx: Context): LoggerLike {
  // ctx.logger routes into the harness diagnostics sink, which the default
  // launchd deployment does not surface anywhere; stdio does reach the service
  // log, so operational lines go to the console ON TOP of the harness logger.
  const candidate = (ctx as { logger?: LoggerLike }).logger
  return {
    info: (...args: unknown[]) => {
      console.log('[discord-bridge]', ...args)
      candidate?.info(...args)
    },
    warn: (...args: unknown[]) => {
      console.warn('[discord-bridge]', ...args)
      candidate?.warn(...args)
    },
  }
}

/** Where channel bindings persist: explicit config, else the profile directory. */
export function resolveStateFile(configured: string, baseUrl: string | undefined): string {
  if (configured !== '') return configured
  if (baseUrl !== undefined && baseUrl.startsWith('file:')) {
    try {
      return join(fileURLToPath(baseUrl), 'discord-bridge-state.json')
    } catch {
      // Fall through to the home-directory default.
    }
  }
  return join(homedir(), '.dsh', 'discord-bridge-state.json')
}

/**
 * Resolve the bot token: explicit config, then environment, then token file.
 * The file form keeps the secret out of profile YAML: it may hold the raw
 * token, or `KEY=value` lines (an env file) looked up by `tokenFileKey`.
 * @returns the token, or empty when nothing is configured.
 */
export async function resolveToken(config: Pick<Config, 'token' | 'tokenEnv' | 'tokenFile' | 'tokenFileKey'>): Promise<string> {
  if (config.token.trim() !== '') return config.token.trim()
  const fromEnv = (process.env[config.tokenEnv] ?? '').trim()
  if (fromEnv !== '') return fromEnv
  if (config.tokenFile === '') return ''
  const raw = (await readFile(config.tokenFile, 'utf8')).trim()
  if (!raw.includes('=')) return raw
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${config.tokenFileKey}=`)) continue
    return trimmed.slice(config.tokenFileKey.length + 1).trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/**
 * Resolve the notify bearer secret: config, then environment, then a
 * generated secret persisted next to the binding state (0600), so the
 * surface is usable out of the box and local callers can read the file.
 * @returns the secret and where it came from.
 */
export async function resolveNotifySecret(
  config: Pick<Config, 'notifySecret' | 'notifySecretEnv'>,
  stateFile: string,
): Promise<{ secret: string; source: string }> {
  if (config.notifySecret.trim() !== '') return { secret: config.notifySecret.trim(), source: 'config' }
  const fromEnv = (process.env[config.notifySecretEnv] ?? '').trim()
  if (fromEnv !== '') return { secret: fromEnv, source: `env ${config.notifySecretEnv}` }
  const file = join(dirname(stateFile), 'discord-notify.secret')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return { secret: existing, source: file }
  } catch {
    // Absent: generate below.
  }
  const generated = randomBytes(24).toString('hex')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${generated}\n`, { mode: 0o600 })
  return { secret: generated, source: `${file} (generated)` }
}

/** Message admission: bots never, DMs by user allowlist, guilds by channel (and user when listed). */
export function isAllowed(
  message: Pick<GatewayMessage, 'guild_id' | 'channel_id'> & { author: { id: string; bot?: boolean } },
  botUserId: string | undefined,
  allowedUsers: readonly string[],
  allowedChannels: readonly string[],
): boolean {
  if (message.author.bot === true) return false
  if (botUserId !== undefined && message.author.id === botUserId) return false
  const isDm = message.guild_id === undefined
  if (isDm) return allowedUsers.includes(message.author.id)
  if (!allowedChannels.includes(message.channel_id)) return false
  return allowedUsers.length === 0 || allowedUsers.includes(message.author.id)
}

/** Wire the gateway, REST, and session bridge together for one deployment. */
export function apply(ctx: Context, config: Config): void {
  const logger = loggerOf(ctx)
  if (config.allowedUsers.length === 0 && config.allowedChannels.length === 0) {
    logger.warn('discord-bridge: allowedUsers and allowedChannels are both empty; refusing to expose the agent to arbitrary Discord users — bridge disabled')
    return
  }

  ctx.effect(() => {
    let disposed = false
    let gateway: DiscordGateway | undefined
    let relay: QuestionRelay | undefined
    let disposeQuestions: (() => void) | undefined
    let disposeNotify: (() => void) | undefined
    let rest: DiscordRest
    const store = new BindingStore(resolveStateFile(config.stateFile, ctx.baseUrl))
    let botUserId: string | undefined
    let applicationId: string | undefined
    let commandsRegistered = false
    const emptyContentWarned = new Set<string>()

    const beginTypingFor = (channelId: string): (() => void) => {
      let timer: ReturnType<typeof setInterval> | undefined
      const fire = (): void => {
        rest.triggerTyping(channelId).catch(() => { /* cosmetic */ })
      }
      fire()
      timer = setInterval(fire, Math.max(config.typingIntervalMs, 3000))
      return () => {
        if (timer !== undefined) clearInterval(timer)
        timer = undefined
      }
    }

    const boot = (async () => {
      // The whole plugin tree must finish mounting before the bridge serves:
      // a message arriving seconds after process start would otherwise drive
      // agents.create/presets against a half-mounted composition.
      await (ctx.get('loader') as { await?: () => Promise<unknown> } | undefined)?.await?.()
      const token = await resolveToken(config)
      if (token === '') {
        logger.warn(`discord-bridge: no bot token (set config.token, the ${config.tokenEnv} environment variable, or config.tokenFile); bridge disabled`)
        return
      }
      rest = new DiscordRest({
        token,
        ...config.restBaseUrl === '' ? {} : { baseUrl: config.restBaseUrl },
      })
      await store.load()
      const host = await loadHostModules(ctx.baseUrl, (text) => { logger.warn(`discord-bridge: ${text}`) })
      const bridge = new SessionBridge({
        ctx,
        host,
        store,
        config: {
          cwd: config.cwd,
          preset: config.preset,
          titlePrefix: config.titlePrefix,
          maxChunksPerReply: config.maxChunksPerReply,
          maxUploadBytes: config.maxUploadBytes,
          uploadRoots: config.uploadRoots,
          maxIncomingBytes: config.maxIncomingBytes,
        },
        log: (level, text) => { logger[level](`discord-bridge: ${text}`) },
      })

      // The notify surface only needs the REST client and the secret — it is
      // registered BEFORE any Discord round-trip so a Discord outage cannot
      // take the local API down with it.
      let botLabel = 'bot'
      const webServer = ctx.get('webServer') as
        | { register: (route: { kind: 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }) => () => void; port?: number }
        | undefined
      if (config.notifyEnabled && webServer !== undefined) {
        const { secret, source } = await resolveNotifySecret(config, resolveStateFile(config.stateFile, ctx.baseUrl))
        const notifier = new DiscordNotifier(rest, config.allowedUsers[0], config.maxChunksPerReply)
        const port = webServer.port ?? 3080
        const secretFile = join(dirname(resolveStateFile(config.stateFile, ctx.baseUrl)), 'discord-notify.secret')
        const handler = createNotifyHandler(
          secret,
          {
            notifier,
            botLabel: () => botLabel,
            version: '0.5.1',
            httpEndpoint: `http://127.0.0.1:${String(port)}/plugins/discord/api/notify`,
            // The description points at the file only when the secret really lives there.
            secretPath: source.startsWith('/') || source.includes('generated') ? secretFile : '',
          },
          (level, text) => { logger[level](`discord-bridge: ${text}`) },
        )
        disposeNotify = webServer.register({ kind: 'prefix', path: '/plugins/discord', handler })
        logger.info(`discord-bridge: notify API + MCP at /plugins/discord (secret: ${source})`)
      }

      // Identity check with retry: discord.com is flaky from some networks,
      // and a transient failure here must not kill the whole bridge for the
      // process lifetime (it did, once, in production).
      let me: { id: string; username: string } | undefined
      for (let delay = 5000; !disposed; delay = Math.min(delay * 2, 60_000)) {
        try {
          me = await rest.getMe()
          break
        } catch (error) {
          logger.warn(`discord-bridge: identity check failed (${String(error)}); retrying in ${String(delay / 1000)}s`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      if (me === undefined || disposed) {
        if (!disposed) logger.info('discord-bridge: boot abandoned (effect disposed mid-boot)')
        return
      }
      botUserId = me.id
      botLabel = me.username
      logger.info(`discord-bridge: authenticated as ${me.username} (${me.id})`)

      const onMessage = (message: GatewayMessage): void => {
        if (!isAllowed(message, botUserId, config.allowedUsers, config.allowedChannels)) return
        const content = message.content ?? ''
        if (content.trim() === '') {
          if (message.guild_id !== undefined && !emptyContentWarned.has(message.channel_id)) {
            emptyContentWarned.add(message.channel_id)
            void rest.createMessage(
              message.channel_id,
              '⚠️ 收到了空消息内容。如果你发的是文字,机器人缺少 MESSAGE_CONTENT intent(在 Discord developer portal 打开),或改用私聊。',
            ).catch(() => { /* best effort */ })
          }
          return
        }
        const command = parseCommand(content)
        void (async () => {
          const reply = await bridge.handle(
            command,
            message.channel_id,
            message.id,
            () => beginTypingFor(message.channel_id),
            message.attachments ?? [],
          )
          for (const [index, chunk] of reply.chunks.entries()) {
            try {
              await rest.createMessage(message.channel_id, chunk, index === 0 ? message.id : undefined)
            } catch (error) {
              logger.warn(`discord-bridge: send failed: ${String(error)}`)
              break
            }
          }
          if (reply.files.length > 0) {
            try {
              await rest.createMessageWithFiles(message.channel_id, '', reply.files)
            } catch (error) {
              logger.warn(`discord-bridge: file upload failed: ${String(error)}`)
              await rest.createMessage(message.channel_id, '⚠️ 附件上传失败,文件仍在服务器上。').catch(() => { /* best effort */ })
            }
          }
        })().catch((error: unknown) => {
          logger.warn(`discord-bridge: message handling failed: ${String(error)}`)
        })
      }

      relay = new QuestionRelay({
        rest,
        channelForSession: (sessionId) => {
          for (const [channel, session] of store.entries()) {
            if (session === sessionId) return channel
          }
          return undefined
        },
        log: (level, text) => { logger[level](`discord-bridge: ${text}`) },
      })
      // One seat on the harness question waterfall: questions for
      // Discord-bound sessions get cards, everything else is delegated.
      const questionSeat = relay
      // Prepended: the waterfall runs listeners in registration order, and the
      // browser's answerer CLAIMS a question (it never delegates while a
      // client is connected). Seating behind it would starve Discord of every
      // question; seating in front lets this bridge post the card and hand the
      // same question on with next(), so both surfaces stay live.
      disposeQuestions = ctx.on(
        'user-questions/request',
        async (request, next) => await questionSeat.handleAsk(request, next),
        { prepend: true },
      )
      logger.info('discord-bridge: question relay seated on user-questions/request')

      const questionRelay = relay
      const onInteraction = (interaction: GatewayInteraction): void => {
        const author = interaction.member?.user ?? interaction.user
        if (author === undefined) return
        const channelId = interaction.channel_id ?? ''
        const admission = {
          ...interaction.guild_id === undefined ? {} : { guild_id: interaction.guild_id },
          channel_id: channelId,
          author,
        }
        // Component clicks and modal submits route to the question relay.
        if (interaction.type === 3 || interaction.type === 5) {
          if (!isAllowed(admission, botUserId, config.allowedUsers, config.allowedChannels)) return
          questionRelay.handleInteraction(interaction).catch((error: unknown) => {
            logger.warn(`discord-bridge: component interaction failed: ${String(error)}`)
          })
          return
        }
        const commandName = interaction.data?.name
        if (commandName === undefined) return
        void (async () => {
          if (!isAllowed(admission, botUserId, config.allowedUsers, config.allowedChannels)) {
            await rest.ackEphemeral(interaction.id, interaction.token, '未授权使用这个桥接。')
            return
          }
          const command = commandFromInteraction(commandName, interaction.data?.options ?? [])
          if (command === undefined) {
            await rest.ackEphemeral(interaction.id, interaction.token, `未知命令 /${commandName}`)
            return
          }
          // Deferred ack buys 15 minutes and shows "thinking…" in the client.
          await rest.ackDeferred(interaction.id, interaction.token)
          const reply = await bridge.handle(command, channelId, interaction.id, () => () => {})
          const appId = applicationId
          if (appId === undefined) return
          const [first, ...others] = reply.chunks
          await rest.editOriginalResponse(appId, interaction.token, first ?? '(无输出)')
          for (const chunk of others) await rest.followupResponse(appId, interaction.token, chunk)
        })().catch((error: unknown) => {
          logger.warn(`discord-bridge: interaction handling failed: ${String(error)}`)
        })
      }

      gateway = new DiscordGateway({
        token,
        intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT,
        ...config.gatewayUrl === '' ? {} : { url: config.gatewayUrl },
        hooks: {
          onMessage,
          onInteraction,
          onReady: (ready) => {
            botUserId = ready.botUserId
            applicationId = ready.applicationId
            logger.info(`discord-bridge: gateway ready (bot ${ready.botUserId})`)
            if (!commandsRegistered && applicationId !== undefined) {
              commandsRegistered = true
              rest.bulkOverwriteCommands(applicationId, APPLICATION_COMMANDS).then(() => {
                logger.info('discord-bridge: slash commands registered')
              }, (error: unknown) => {
                commandsRegistered = false
                logger.warn(`discord-bridge: slash command registration failed (text commands still work): ${String(error)}`)
              })
            }
          },
          onFatal: (reason) => {
            logger.warn(`discord-bridge: gateway gave up: ${reason}`)
          },
          log: (level, text) => { logger[level](`discord-bridge: ${text}`) },
        },
      })
      if (!disposed) gateway.start()
    })()
    boot.catch((error: unknown) => {
      logger.warn(`discord-bridge: boot failed: ${String(error)}`)
    })

    return () => {
      disposed = true
      gateway?.stop()
      relay?.stop()
      disposeQuestions?.()
      disposeNotify?.()
      void store.flush()
    }
  }, 'discord bridge lifecycle')
}
