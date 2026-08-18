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
