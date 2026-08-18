/**
 * File-transfer helpers for both directions of the bridge.
 *
 * Outgoing: the agent asks for an upload by writing a marker line in its
 * reply — `[discord-file: /absolute/path]` — which the bridge strips from the
 * text and turns into a Discord attachment. Incoming: files the user attaches
 * on Discord are saved under the session's working directory and announced to
 * the agent as paths.
 *
 * @module dsh-plugin-discord/attachments
 */

import { basename, resolve, sep } from 'node:path'

/** One marker line the agent wrote; the path is taken verbatim. */
const FILE_MARKER = /^[ \t]*\[discord-file:[ \t]*([^\]\n]+?)[ \t]*\][ \t]*$/gm

/**
 * Pull `[discord-file: …]` markers out of a reply.
 * @param text - the assistant's reply text.
 * @returns the text with marker lines removed, and the marked paths in order.
 */
export function extractFileMarkers(text: string): { text: string; paths: string[] } {
  const paths: string[] = []
  const cleaned = text.replace(FILE_MARKER, (_line, path: string) => {
    paths.push(path)
    return ''
  })
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), paths }
}

/**
 * Whether `child` lies at or under `root` (lexical, after resolution).
 * Callers pass realpath-ed inputs when symlink escape matters.
 */
export function isPathUnder(child: string, root: string): boolean {
  const childPath = resolve(child)
  const rootPath = resolve(root)
  return childPath === rootPath || childPath.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)
}

/** A filesystem-safe name for one incoming Discord attachment. */
export function sanitizeFilename(name: string): string {
  const cleaned = basename(name).replace(/[^\w.\-一-鿿]+/g, '_')
  const bounded = cleaned.length > 80 ? cleaned.slice(cleaned.length - 80) : cleaned
  return bounded === '' || /^\.+$/.test(bounded) ? 'file' : bounded
}

/**
 * The capability notice injected once per live agent, so a model driven from
 * Discord knows the bridge's transport abilities instead of hunting for other
 * Discord tooling on the host.
 * @param maxUploadBytes - the deployment's outgoing attachment cap.
 * @returns the notice text.
 */
export function capabilityNotice(maxUploadBytes: number): string {
  const megabytes = Math.floor(maxUploadBytes / 1_000_000)
  return [
    '<system-reminder>',
    '本会话正通过 Discord 桥接(dsh-plugin-discord)与用户对话;用户此刻在 Discord 客户端上。',
    `- 发送文件/图片给用户:在回复中单独一行写 [discord-file: /绝对路径],桥接会把该文件作为 Discord 附件上传,并把这行从文本中移除。限会话工作目录(及部署配置的额外目录)内、单个不超过 ${String(megabytes)}MB;图片会在 Discord 内联显示。`,
    '- 用户在 Discord 发的文件/图片会自动保存到工作目录的 .discord-uploads/ 里,消息里会附上路径,直接读取即可。',
    '- 文本回复按 2000 字符分片发送,过长会被截断;保持精炼。',
    '- 不要寻找或使用主机上其它 Discord 工具/凭据来发消息;所有 Discord 通信都由桥接负责。',
    '</system-reminder>',
  ].join('\n')
}
