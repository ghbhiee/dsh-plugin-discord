/**
 * Local HTTP surface that lets an external iMessage relay drive dsh sessions
 * through the same {@link SessionBridge} the Discord side uses — so iMessage
 * conversations are ordinary web-visible sessions, titled `[iMessage] …`.
 *
 * The relay (~/ccc/imessage-agent) owns chat.db and AppleScript; this module
 * only turns "channel + text" into a session turn. Turns can run for many
 * minutes, longer than an HTTP request should stay open, so a prompt is
 * accepted as a job and the relay polls for the result:
 *
 *   - `POST /plugins/imessage/api/chat`  `{ channel, text }` → `202 { job }`
 *   - `GET  /plugins/imessage/api/job?id=<job>` → `{ done: false }` or
 *     `{ done: true, chunks: string[], files: string[] }` (files are absolute
 *     paths of attachments written to a temp directory for the relay to send)
 *
 * Bridge commands (`/new`, `/sessions`, `/use`, `/current`, `/stop`, `/help`)
 * travel the same route and come back as an ordinary job.
 *
 * @module dsh-plugin-discord/imessage
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCommand } from './commands.ts'
import type { SessionBridge } from './bridge.ts'
import { sanitizeFilename } from './attachments.ts'

/** Finished jobs are kept this long for the relay to collect. */
const JOB_TTL_MS = 60 * 60 * 1000

interface Job {
  done: boolean
  chunks: string[]
  files: string[]
  finishedAt?: number
}

/**
 * The capability notice for sessions driven from iMessage.
 * @param uploadRoots - extra directories uploads may come from.
 * @returns the notice text.
 */
export function imessageNotice(uploadRoots: readonly string[] = []): string {
  const roots = uploadRoots.length === 0
    ? '仅限会话工作目录内的文件'
    : `仅限会话工作目录及这些目录内的文件: ${uploadRoots.join('、')}`
  return [
    '<system-reminder>',
    '本会话正通过 iMessage 桥接与用户对话;用户此刻在 iPhone 的「信息」App 上。你和用户共用同一个 Apple ID 和这台 Mac。',
    '- iMessage 不渲染 Markdown:用纯文本、短段落,别用表格、# 标题和 ** 加粗。',
    `- 发送文件/图片给用户:在回复中单独一行写 [discord-file: /绝对路径](标记名沿用 Discord 桥接),桥接会把该文件作为 iMessage 附件发出并移除这一行。${roots}。`,
    '- 不要自己用 osascript 或「信息」App 发消息;回复由桥接负责发回。',
    '- 以用户身份对外发消息、付款、删除数据等不可逆的事,先在回复里说清楚并等用户确认。',
    '</system-reminder>',
  ].join('\n')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Build the prefix-route handler for `/plugins/imessage`.
 * @param bridge - the iMessage-flavoured session bridge.
 * @param secret - required bearer token; every request is checked first.
 * @param log - operational logging.
 */
export function createImessageHandler(
  bridge: SessionBridge,
  secret: string,
  log: (level: 'info' | 'warn', text: string) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const jobs = new Map<string, Job>()

  const sweep = (): void => {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id)
    }
  }

  const run = async (id: string, channel: string, text: string): Promise<void> => {
    const job = jobs.get(id)
    if (job === undefined) return
    try {
      const reply = await bridge.handle(parseCommand(text), channel, `imessage-${id}`, () => () => {})
      const files: string[] = []
      if (reply.files.length > 0) {
        const dir = join(tmpdir(), 'dsh-imessage', id)
        await mkdir(dir, { recursive: true })
        for (const file of reply.files) {
          const path = join(dir, sanitizeFilename(file.filename))
          await writeFile(path, file.data)
          files.push(path)
        }
      }
      job.chunks = reply.chunks
      job.files = files
    } catch (error) {
      log('warn', `imessage job ${id} failed: ${String(error)}`)
      job.chunks = [`⚠️ 出错了: ${error instanceof Error ? error.message : String(error)}`]
    } finally {
      job.done = true
      job.finishedAt = Date.now()
    }
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.headers.authorization !== `Bearer ${secret}`) {
        sendJson(res, 401, { error: 'missing or wrong bearer token' })
        return
      }
      if (url.pathname === '/plugins/imessage/api/chat' && req.method === 'POST') {
        let body: { channel?: unknown; text?: unknown }
        try {
          body = JSON.parse(await readBody(req)) as typeof body
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        if (typeof body.channel !== 'string' || body.channel === '' || typeof body.text !== 'string') {
          sendJson(res, 400, { error: 'channel and text are required strings' })
          return
        }
        sweep()
        const id = randomUUID()
        jobs.set(id, { done: false, chunks: [], files: [] })
        void run(id, `imessage:${body.channel}`, body.text)
        sendJson(res, 202, { job: id })
        return
      }
      if (url.pathname === '/plugins/imessage/api/job' && req.method === 'GET') {
        const job = jobs.get(url.searchParams.get('id') ?? '')
        if (job === undefined) {
          sendJson(res, 404, { error: 'unknown job' })
          return
        }
        sendJson(res, 200, job.done ? { done: true, chunks: job.chunks, files: job.files } : { done: false })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      log('warn', `imessage handler failed: ${String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    }
  }
}
