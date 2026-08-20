#!/usr/bin/env node
/**
 * A scripted fake Discord: one gateway WebSocket server plus one REST HTTP
 * server, driving a real dsh-plugin-discord deployment end to end without
 * touching discord.com. Point the plugin at it with:
 *
 *   - id: discord-bridge
 *     config:
 *       token: test-token
 *       allowedUsers: ["<your discord user id>"]
 *       gatewayUrl: ws://127.0.0.1:8931
 *       restBaseUrl: http://127.0.0.1:8932
 *
 * It sends each line of SCRIPT as a user DM once the previous reply arrives,
 * prints every message the bridge posts back, and exits when the script is
 * exhausted (or on timeout).
 */

import { createServer } from 'node:http'
import process from 'node:process'
import { WebSocketServer } from 'ws'

const GATEWAY_PORT = 8931
const REST_PORT = 8932
// Must match an entry in the plugin's allowedUsers config.
const USER_ID = process.env.FAKE_DISCORD_USER ?? '000000000000000001'
const CHANNEL = 'e2e-channel-1'
const SCRIPT = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [
      '用一句话回答:1+1等于几?',
      '/current',
      '/new e2e验证',
      '刚才我问过你什么问题?',
      '/sessions',
    ]

let messageCounter = 0
let scriptIndex = 0
let socket
const pendingTyping = new Set()

const log = (...args) => { console.log(new Date().toISOString().slice(11, 19), ...args) }

function sendNextPrompt() {
  if (socket === undefined || scriptIndex >= SCRIPT.length) return
  const content = SCRIPT[scriptIndex]
  scriptIndex += 1
  messageCounter += 1
  const id = `e2e-msg-${String(messageCounter)}`
  log(`>> user sends (${id}): ${content}`)
  socket.send(JSON.stringify({
    op: 0,
    s: 100 + messageCounter,
    t: 'MESSAGE_CREATE',
    d: { id, channel_id: CHANNEL, content, author: { id: USER_ID, username: 'hongbo' } },
  }))
}

const gateway = new WebSocketServer({ port: GATEWAY_PORT })
gateway.on('connection', (connection) => {
  log('gateway: connection')
  socket = connection
  connection.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }))
  connection.on('message', (raw) => {
    const payload = JSON.parse(String(raw))
    if (payload.op === 2) {
      log(`gateway: identify (intents=${String(payload.d.intents)})`)
      connection.send(JSON.stringify({
        op: 0,
        s: 1,
        t: 'READY',
        d: {
          user: { id: 'bot-fake' },
          session_id: 'fake-session',
          resume_gateway_url: `ws://127.0.0.1:${String(GATEWAY_PORT)}`,
        },
      }))
      setTimeout(sendNextPrompt, 500)
    } else if (payload.op === 1) {
      connection.send(JSON.stringify({ op: 11 }))
    } else if (payload.op === 6) {
      log('gateway: resume')
      connection.send(JSON.stringify({ op: 0, s: 2, t: 'RESUMED', d: {} }))
      setTimeout(sendNextPrompt, 500)
    }
  })
})

const rest = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const url = request.url ?? ''
    if (url === '/users/@me') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'bot-fake', username: 'fake-discord-bot' }))
      return
    }
    if (url.endsWith('/typing')) {
      if (!pendingTyping.has(url)) { pendingTyping.add(url); log('rest: typing…') }
      response.writeHead(204)
      response.end()
      return
    }
    if (url.includes('/interactions/') && request.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      log(`rest: interaction callback (type ${String(body.type)})${body.data?.content ? `: ${String(body.data.content).split('\n').pop()}` : ''}`)
      response.writeHead(204)
      response.end()
      return
    }
    if (url.includes('/messages/') && request.method === 'PATCH') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      log(`rest: message edited: ${String(body.content ?? '').split('\n').pop()}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    if (url.includes('/messages') && request.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const messageId = `fake-reply-${String(Date.now())}`
      if (Array.isArray(body.components) && body.components.length > 0) {
        // A question card: log it, then auto-click the first select option.
        log(`<< QUESTION card:\n---\n${body.content}\n---`)
        const select = body.components.flatMap(row => row.components ?? []).find(c => c.type === 3)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: messageId }))
        if (select !== undefined && socket !== undefined) {
          const pick = select.options?.[0]
          log(`>> auto-clicking select "${select.custom_id}" → option "${pick?.label ?? '?'}"`)
          setTimeout(() => {
            socket.send(JSON.stringify({
              op: 0,
              s: 900,
              t: 'INTERACTION_CREATE',
              d: {
                id: `fake-itx-${String(Date.now())}`,
                token: 'fake-itx-token',
                type: 3,
                channel_id: CHANNEL,
                user: { id: USER_ID },
                message: { id: messageId },
                data: { custom_id: select.custom_id, component_type: 3, values: [pick?.value ?? '0'] },
              },
            }))
          }, 800)
        }
        return
      }
      log(`<< bridge replies:\n---\n${body.content}\n---`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: messageId }))
      // A short debounce lets multi-chunk replies land before the next prompt.
      clearTimeout(globalThis.nextTimer)
      globalThis.nextTimer = setTimeout(() => {
        pendingTyping.clear()
        if (scriptIndex < SCRIPT.length) sendNextPrompt()
        else {
          log('script exhausted; exiting in 3s')
          setTimeout(() => process.exit(0), 3000)
        }
      }, 2500)
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
})
rest.listen(REST_PORT)

log(`fake discord up: gateway ws://127.0.0.1:${String(GATEWAY_PORT)} rest http://127.0.0.1:${String(REST_PORT)}`)
setTimeout(() => {
  log('timeout; exiting')
  process.exit(1)
}, 10 * 60 * 1000)
