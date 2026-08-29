# dsh-plugin-discord

Discord bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): chat with your dsh sessions from Discord — **the very same sessions the web UI shows**, so a conversation started at your desk continues on your phone through Discord, and vice versa.

- Messages from allowlisted Discord users/channels are relayed into a dsh session; the reply comes back as Discord messages (long replies are split, code fences survive the split).
- `/new` starts a fresh session named like `[Discord] 08-18 15:04` — the pinned title marks its origin in the web sidebar.
- Sessions are created through the same agent-preset composition the web host uses, so they carry the full toolchain and can be opened, continued, and renamed in the web UI at any time. A session created on the web can be adopted from Discord with `/use <id>`.
- Zero runtime dependencies: the gateway runs on Node's built-in WebSocket, REST on built-in fetch.

## Commands

On startup the bridge registers these as real Discord slash commands (they
appear in the `/` picker). Plain-text forms keep working as a fallback — typing
`/new` and hitting Enter works even before registration propagates.

| Command | Effect |
|---|---|
| *(any text)* | Prompt the channel's current session (auto-creates one) |
| `/new [标题]` | New session, date-stamped `[Discord]` title |
| `/sessions` (`/list`) | Recent Discord-bridged sessions |
| `/use <id>` (`/switch`, `/resume`) | Bind this channel to a session — web-created ids work too |
| `/current` (`/session`) | Show the bound session and its status |
| `/stop` (`/cancel`) | Cancel the running turn |
| `/help` | Help |

Any other `/`-prefixed text passes through as a prompt.

## Proactive notify: HTTP API + MCP (monitoring / reminders / alerts)

Every deployment's bridge also serves its own bot as a **push channel**, so
agents and daemons can message the user proactively instead of only replying.
Because each dsh serves its own bot, sender identity follows the deployment:
your local dsh notifies as its bot, your server's dsh as its bot.

**What is automatic vs manual:**

| Piece | Automatic? |
|---|---|
| MCP **server** endpoint (`POST /plugins/discord/mcp`) | ✅ served on plugin boot, nothing to do |
| HTTP API (`POST /plugins/discord/api/notify`) | ✅ served on plugin boot |
| Bearer secret | ✅ auto-generated on first boot → `<profile dir>/discord-notify.secret` (0600); override via config `notifySecret` or env `DSH_DISCORD_NOTIFY_SECRET` |
| MCP **client** registration (making an agent see the tool) | ❌ one-time manual step per client, recipes below |

Disable the whole surface with `notifyEnabled: false`.

### HTTP API reference (for any application)

`POST http://127.0.0.1:<dsh port>/plugins/discord/api/notify`

| | |
|---|---|
| Auth | `Authorization: Bearer <secret>` — read the secret from `<profile dir>/discord-notify.secret` (e.g. `~/.dsh/profiles/web/discord-notify.secret`) |
| Body | `{"content": "text", "userId"?: "...", "channelId"?: "..."}` — JSON, `content` required |
| Target | default = DM of the first `allowedUsers` entry; `userId` = another user's DM; `channelId` = a guild channel the bot can post in |
| Content | Discord markdown; text over 2000 chars is split into several messages automatically |
| 200 | `{"ok": true, "channelId": "...", "messageIds": ["..."]}` |
| 400 | bad JSON / empty content |
| 401 | missing or wrong bearer token |
| 502 | Discord-side delivery failure (`{"ok": false, "error": "..."}`) |

```sh
curl -s -X POST http://127.0.0.1:3080/plugins/discord/api/notify \
  -H "authorization: Bearer $(cat ~/.dsh/profiles/web/discord-notify.secret)" \
  -H 'content-type: application/json' \
  -d '{"content": "⚠️ 磁盘使用率 92%"}'
```

The endpoint is loopback by default (dsh binds 127.0.0.1): callers on the same
machine hit it directly; remote callers tunnel (`ssh -L 3080:127.0.0.1:3080 host`)
or go through whatever reverse proxy already fronts your dsh.

### Registering the MCP client (one-time, per agent)

The MCP server side (Streamable HTTP, tool **`discord_notify`**) is already
running — these recipes just point a client at it.

**dsh itself** (gives every dsh agent the tool) — machine-wide
`~/.dsh/cordis.patch.yml`, then restart dsh:

```yaml
- insert:
    - id: mcp-discord-notify
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: discord
        transport: streamable-http
        url: http://127.0.0.1:3080/plugins/discord/mcp
        headers:
          authorization: Bearer <contents of discord-notify.secret>
```

**Claude Code:**

```sh
claude mcp add --transport http discord \
  http://127.0.0.1:3080/plugins/discord/mcp \
  --header "Authorization: Bearer $(cat ~/.dsh/profiles/web/discord-notify.secret)"
```

**Stdio-only MCP clients** (via mcp-remote):

```json
{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:3080/plugins/discord/mcp", "--header", "Authorization: Bearer <secret>"] }
```

### Copy-paste prompts for other agents

Give an agent this to make it **register the MCP itself** (fill in your paths):

> 帮我接入本机 dsh 的 Discord 通知能力:MCP 端点是
> `http://127.0.0.1:3080/plugins/discord/mcp`(transport: streamable-http),
> 鉴权头 `Authorization: Bearer <密钥>`,密钥内容读文件
> `~/.dsh/profiles/web/discord-notify.secret`。请把它注册进你的 MCP 配置,
> 然后调用 `discord_notify` 工具发一条测试消息「MCP 接入成功」验证。

Give an agent this to make it **use the HTTP API in code/scripts** (no MCP needed):

> 本机有一个 Discord 推送接口,写监控/定时脚本需要通知我时调用它:
> `POST http://127.0.0.1:3080/plugins/discord/api/notify`,
> 请求头 `Authorization: Bearer $(cat ~/.dsh/profiles/web/discord-notify.secret)`
> 和 `Content-Type: application/json`,请求体 `{"content": "通知文本"}`。
> 返回 `{"ok": true}` 即送达;非 200 时把状态码和响应体记入日志,不要重试超过 3 次。

Or drop this one-liner into an agent's standing instructions (CLAUDE.md 等),
so it always knows the channel exists:

> 需要主动通知用户时(任务完成、告警、提醒),POST
> `http://127.0.0.1:3080/plugins/discord/api/notify`,Bearer 密钥在
> `~/.dsh/profiles/web/discord-notify.secret`,body `{"content": "..."}`。

## Inline questions (ask_user_question → Discord components)

When the agent asks the user a question (dsh's `ask_user_question` tool — option
picks, confirmations, plan reviews), the bridge renders it as **Discord inline
components** in the bound channel: a select menu for the options (multi-select
supported), an ✏️ button that opens a modal for a free-text answer, and a
cancel button. Picking an option updates the message in place and the agent's
turn continues with the answer.

How it works: the harness dispatches questions on the Cordis waterfall
`user-questions/request`, and the bridge takes a **prepended seat** on it — the
browser's answerer claims a question outright, so a seat behind it would never
see one. From the front, the bridge posts the Discord card and hands the same
question on with `next()`, so both surfaces stay live and the first answer wins.
A web answer visibly closes the Discord card.

Requires dsh >= 0.1.1 (the waterfall). On older hosts the seat simply never
fires and questions stay web-only.

## File transfer

Both directions work, and the agent is told about them (a capability notice is
injected once per session when it is first driven from Discord):

- **Agent → Discord**: the agent writes a line `[discord-file: /absolute/path]`
  in its reply; the bridge strips the line, and uploads the file as a Discord
  attachment (images render inline). Only files under the session's working
  directory (plus configured `uploadRoots`) and within `maxUploadBytes` are
  sent — a refusal is reported in the reply.
- **Discord → agent**: files/images the user attaches are saved under the
  session cwd's `.discord-uploads/` and their paths are appended to the
  prompt, so the agent can read them directly.

## Install

```sh
dsh plugin --profile web add github:ghbhiee/dsh-plugin-discord
```

Provide the bot token via the `DSH_DISCORD_TOKEN` environment variable of the
dsh process (recommended — nothing secret touches the profile YAML). Under a
launchd deployment that means the service plist's `EnvironmentVariables` dict;
under systemd, an `Environment=` line; in a shell, plain `export`.

Then configure the row in the profile's `cordis.patch.yml`:

```yaml
- id: discord-bridge
  config:
    allowedUsers: ["<your discord user id>"]
    # allowedChannels: ["<guild channel id>"]   # empty = DM-only
    cwd: /Users/you/projects         # where new sessions live
    # preset: ""                     # agent preset; empty = deployment default
    # titlePrefix: "[Discord] "
```

Token lookup order: `config.token` → `$DSH_DISCORD_TOKEN` (name configurable
via `tokenEnv`) → `tokenFile` (raw token or an env-style file).

The bridge **refuses to start** when both allowlists are empty — an unrestricted bridge would hand your agent (and its tools) to anyone who can DM the bot.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `token` | `""` | Bot token; empty falls back to `tokenEnv`, then `tokenFile` |
| `tokenEnv` | `DSH_DISCORD_TOKEN` | Environment variable consulted when `token` is empty |
| `tokenFile` | `""` | File holding the token — raw, or env-style `KEY=value` lines. Keeps the secret out of profile YAML |
| `tokenFileKey` | `DISCORD_BOT_TOKEN` | Key looked up when `tokenFile` is env-style |
| `allowedUsers` | `[]` | Discord user ids allowed to talk (required for DMs) |
| `allowedChannels` | `[]` | Guild channel ids the bridge listens in; empty = DM-only |
| `cwd` | home dir | Working directory of **newly created** sessions (created if missing). An already-bound session keeps the cwd it was created with — use `/new` after changing this |
| `preset` | `""` | Agent preset for new sessions; empty composes the default |
| `titlePrefix` | `"[Discord] "` | Title prefix marking Discord-originated sessions |
| `maxChunksPerReply` | `6` | Cap on Discord messages per reply (overflow truncated with a notice) |
| `maxUploadBytes` | `8000000` | Cap on one outgoing attachment (`[discord-file: …]`) |
| `uploadRoots` | `[]` | Extra directories the agent may upload from (session cwd is always allowed) |
| `maxIncomingBytes` | `25000000` | Cap on one incoming Discord attachment saved to disk |
| `stateFile` | `""` | Channel→session binding file; empty derives one in the profile dir |
| `typingIntervalMs` | `8000` | Typing-indicator refresh while a turn runs |
| `gatewayUrl` | `""` | Gateway URL override — a test seam for `scripts/fake-discord.mjs` |
| `restBaseUrl` | `""` | REST origin override — same test seam |

## Local end-to-end test without Discord

`scripts/fake-discord.mjs` runs a scripted fake Discord (gateway + REST) on
`ws://127.0.0.1:8931` / `http://127.0.0.1:8932`. Point the plugin at it via
`gatewayUrl`/`restBaseUrl` (any `token`), restart dsh, and the script drives a
whole conversation — session creation, `/new`, `/use`, context continuity —
against your real dsh deployment, printing every reply the bridge sends.

## Discord application setup

1. [Discord developer portal](https://discord.com/developers/applications) → your application → **Bot**.
2. Enable the **Message Content Intent** (needed for guild-channel text; DMs work without it — the bridge automatically retries without the intent if refused and warns in the log).
3. Invite the bot to your server, or just DM it.

## How the shared-session part works

- New sessions go through `agentPresets.resolve/mount` — the identical composition path `session.create` uses on the web wire — and are persisted by the host's session persistence, so `session.list` shows them like any other session.
- Resuming a cold session composes the preset recorded in its log, mirroring the web host's cold-resume path.
- The bridge stamps each relayed prompt's message source with the Discord message id (the same pattern the web client uses with `rpcId`), then folds exactly the turn that prompt opened — a concurrently running web prompt in the same session is never mistaken for the Discord answer.
- Model selection follows the session log (the web host's behavior), so switching models in the web UI carries over to later Discord turns.

## Known limits

- Replies arrive when the turn completes (typing indicator while it runs); no partial streaming edits yet.
- Attachments/images from Discord are ignored — text only for now.
- Approval prompts (tool permission questions) cannot be answered from Discord; sessions run with whatever approval policy the profile composes.
- One bot token drives one gateway connection: do not reuse a token that another running bot (e.g. Hermes) is using, or you will knock it offline.
