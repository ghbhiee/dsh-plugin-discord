import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
//#region src/gateway.ts
/**
* Minimal Discord gateway client over the platform WebSocket (Node >= 22).
*
* Implements just enough of gateway v10 for a chat bridge: identify, heartbeat,
* resume, and MESSAGE_CREATE dispatch. Sharding, voice, and transport
* compression are deliberately out of scope. Zero runtime dependencies — the
* global `WebSocket` (undici) carries the connection.
*
* @module dsh-plugin-discord/gateway
*/
/** Gateway intent bits this bridge cares about. */
const INTENTS = {
	GUILDS: 1,
	GUILD_MESSAGES: 512,
	DIRECT_MESSAGES: 4096,
	MESSAGE_CONTENT: 32768
};
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** Close codes after which retrying cannot help. 4014 is handled separately. */
const FATAL_CLOSE_CODES = /* @__PURE__ */ new Set([
	4004,
	4010,
	4011,
	4012,
	4013
]);
/**
* One long-lived gateway connection with identify/heartbeat/resume handling.
* `start()` connects and keeps reconnecting until `stop()`.
*/
var DiscordGateway = class {
	options;
	ws;
	stopped = true;
	heartbeatTimer;
	reconnectTimer;
	lastSeq = null;
	sessionId;
	resumeUrl;
	backoffMs = 1e3;
	ackReceived = true;
	intents;
	constructor(options) {
		this.options = options;
		this.intents = options.intents;
	}
	/** Whether the client currently holds an open socket. */
	get connected() {
		return this.ws !== void 0 && this.ws.readyState === WebSocket.OPEN;
	}
	start() {
		this.stopped = false;
		this.connect();
	}
	stop() {
		this.stopped = true;
		this.clearTimers();
		if (this.ws !== void 0) {
			try {
				this.ws.close(1e3);
			} catch {}
			this.ws = void 0;
		}
	}
	log(level, text) {
		this.options.hooks.log?.(level, text);
	}
	clearTimers() {
		if (this.heartbeatTimer !== void 0) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = void 0;
		if (this.reconnectTimer !== void 0) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = void 0;
	}
	connect() {
		if (this.stopped) return;
		const url = this.resumeUrl ?? this.options.url ?? DEFAULT_GATEWAY_URL;
		let ws;
		try {
			ws = new WebSocket(url);
		} catch (error) {
			this.log("warn", `gateway connect failed: ${String(error)}`);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			let payload;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			this.handle(ws, payload);
		});
		ws.addEventListener("close", (event) => {
			if (this.ws !== ws) return;
			this.ws = void 0;
			this.clearTimers();
			if (this.stopped) return;
			if (FATAL_CLOSE_CODES.has(event.code)) {
				this.stopped = true;
				this.options.hooks.onFatal?.(`gateway closed with terminal code ${String(event.code)}: ${event.reason}`);
				return;
			}
			if (event.code === 4014) {
				if ((this.intents & INTENTS.MESSAGE_CONTENT) !== 0) {
					this.intents &= ~INTENTS.MESSAGE_CONTENT;
					this.sessionId = void 0;
					this.resumeUrl = void 0;
					this.log("warn", "MESSAGE_CONTENT intent refused (enable it in the Discord developer portal); retrying without it — guild-channel message text will be empty, DMs still work");
					this.scheduleReconnect();
					return;
				}
				this.stopped = true;
				this.options.hooks.onFatal?.("gateway refused the requested intents");
				return;
			}
			if (event.code === 4007 || event.code === 4009) {
				this.sessionId = void 0;
				this.resumeUrl = void 0;
			}
			this.log("warn", `gateway closed (${String(event.code)}); reconnecting`);
			this.scheduleReconnect();
		});
		ws.addEventListener("error", () => {});
	}
	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer !== void 0) return;
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 6e4);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.connect();
		}, delay);
	}
	send(ws, payload) {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify(payload));
	}
	handle(ws, payload) {
		if (payload.s !== void 0 && payload.s !== null) this.lastSeq = payload.s;
		switch (payload.op) {
			case 10: {
				const data = payload.d;
				this.startHeartbeat(ws, data.heartbeat_interval);
				if (this.sessionId !== void 0) this.send(ws, {
					op: 6,
					d: {
						token: this.options.token,
						session_id: this.sessionId,
						seq: this.lastSeq
					}
				});
				else this.identify(ws);
				return;
			}
			case 11:
				this.ackReceived = true;
				return;
			case 1:
				this.send(ws, {
					op: 1,
					d: this.lastSeq
				});
				return;
			case 7:
				try {
					ws.close(4900);
				} catch {}
				return;
			case 9:
				if (!(payload.d === true)) {
					this.sessionId = void 0;
					this.resumeUrl = void 0;
					this.lastSeq = null;
				}
				setTimeout(() => {
					if (ws.readyState === WebSocket.OPEN) this.identify(ws);
				}, 1e3 + Math.floor(Math.random() * 4e3));
				return;
			case 0:
				this.dispatch(payload);
				return;
		}
	}
	identify(ws) {
		if (this.sessionId !== void 0) return;
		this.send(ws, {
			op: 2,
			d: {
				token: this.options.token,
				intents: this.intents,
				properties: {
					os: process.platform,
					browser: "dsh-plugin-discord",
					device: "dsh-plugin-discord"
				}
			}
		});
	}
	startHeartbeat(ws, intervalMs) {
		if (this.heartbeatTimer !== void 0) clearInterval(this.heartbeatTimer);
		this.ackReceived = true;
		setTimeout(() => {
			this.send(ws, {
				op: 1,
				d: this.lastSeq
			});
		}, Math.floor(intervalMs * Math.random()));
		this.heartbeatTimer = setInterval(() => {
			if (!this.ackReceived) {
				try {
					ws.close(4901);
				} catch {}
				return;
			}
			this.ackReceived = false;
			this.send(ws, {
				op: 1,
				d: this.lastSeq
			});
		}, intervalMs);
	}
	dispatch(payload) {
		switch (payload.t) {
			case "READY": {
				const data = payload.d;
				this.sessionId = data.session_id;
				this.resumeUrl = `${data.resume_gateway_url}/?v=10&encoding=json`;
				this.backoffMs = 1e3;
				this.options.hooks.onReady?.({
					botUserId: data.user.id,
					applicationId: data.application?.id,
					sessionId: data.session_id,
					resumeGatewayUrl: data.resume_gateway_url
				});
				return;
			}
			case "RESUMED":
				this.backoffMs = 1e3;
				this.log("info", "gateway resumed");
				return;
			case "MESSAGE_CREATE": {
				const data = payload.d;
				if (typeof data.id !== "string" || typeof data.channel_id !== "string") return;
				this.options.hooks.onMessage(data);
				return;
			}
			case "INTERACTION_CREATE": {
				const data = payload.d;
				if (typeof data.id !== "string" || typeof data.token !== "string") return;
				this.options.hooks.onInteraction?.(data);
				return;
			}
		}
	}
};
//#endregion
//#region src/rest.ts
/**
* Discord REST calls the bridge needs, over global fetch. Retries once per
* 429 with the server-instructed delay; other failures surface to the caller.
*
* @module dsh-plugin-discord/rest
*/
const API_BASE = "https://discord.com/api/v10";
/** Thin Discord REST client scoped to what the bridge uses. */
var DiscordRest = class {
	token;
	base;
	maxRetries;
	constructor(options) {
		this.token = options.token;
		this.base = options.baseUrl ?? API_BASE;
		this.maxRetries = options.maxRateLimitRetries ?? 3;
	}
	async request(method, path, body) {
		for (let attempt = 0;; attempt++) {
			const response = await fetch(`${this.base}${path}`, {
				method,
				headers: {
					"authorization": `Bot ${this.token}`,
					"user-agent": "DiscordBot (https://github.com/ghbhiee/dsh-plugin-discord, 0.1.0)",
					...body === void 0 ? {} : { "content-type": "application/json" }
				},
				...body === void 0 ? {} : { body: JSON.stringify(body) }
			});
			if (response.status === 429 && attempt < this.maxRetries) {
				const data = await response.json().catch(() => ({}));
				const waitMs = Math.ceil(((data.retry_after ?? 1) + .05) * 1e3);
				await new Promise((resolve) => setTimeout(resolve, waitMs));
				continue;
			}
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`discord REST ${method} ${path} failed: ${String(response.status)} ${text.slice(0, 300)}`);
			}
			if (response.status === 204) return void 0;
			return await response.json();
		}
	}
	/** Identity check; throws on a bad token. */
	async getMe() {
		return await this.request("GET", "/users/@me");
	}
	/** Send one message (caller has already chunked to <= 2000 chars). */
	async createMessage(channelId, content, replyToMessageId) {
		return await this.request("POST", `/channels/${channelId}/messages`, {
			content,
			allowed_mentions: { parse: [] },
			...replyToMessageId === void 0 ? {} : { message_reference: {
				message_id: replyToMessageId,
				fail_if_not_exists: false
			} }
		});
	}
	/** Typing indicator; Discord shows it ~10s, callers re-trigger while busy. */
	async triggerTyping(channelId) {
		await this.request("POST", `/channels/${channelId}/typing`);
	}
	/** Replace the application's global slash commands (idempotent bulk overwrite). */
	async bulkOverwriteCommands(applicationId, commands) {
		await this.request("PUT", `/applications/${applicationId}/commands`, commands);
	}
	/** Acknowledge an interaction with a deferred reply ("thinking…", 15-minute window). */
	async ackDeferred(interactionId, interactionToken) {
		await this.request("POST", `/interactions/${interactionId}/${interactionToken}/callback`, { type: 5 });
	}
	/** Immediately answer an interaction with an ephemeral message (only the invoker sees it). */
	async ackEphemeral(interactionId, interactionToken, content) {
		await this.request("POST", `/interactions/${interactionId}/${interactionToken}/callback`, {
			type: 4,
			data: {
				content,
				flags: 64,
				allowed_mentions: { parse: [] }
			}
		});
	}
	/** Fill in the deferred reply. */
	async editOriginalResponse(applicationId, interactionToken, content) {
		await this.request("PATCH", `/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
			content,
			allowed_mentions: { parse: [] }
		});
	}
	/** Additional chunks after the deferred reply. */
	async followupResponse(applicationId, interactionToken, content) {
		await this.request("POST", `/webhooks/${applicationId}/${interactionToken}`, {
			content,
			allowed_mentions: { parse: [] }
		});
	}
};
//#endregion
//#region src/commands.ts
/**
* Parse one message into a bridge command.
*
* Only the exact names below are intercepted; any other `/`-prefixed text
* passes through as a prompt so dsh slash commands and ordinary text that
* merely starts with a slash keep working.
* @param content - raw Discord message content.
* @returns the parsed command; empty content parses to a help request.
*/
function parseCommand(content) {
	const text = content.trim();
	if (text === "") return { kind: "help" };
	if (!text.startsWith("/")) return {
		kind: "prompt",
		text
	};
	const spaceIndex = text.search(/\s/);
	const word = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).toLowerCase();
	const rest = spaceIndex === -1 ? "" : text.slice(spaceIndex).trim();
	switch (word) {
		case "/new": return {
			kind: "new",
			label: rest
		};
		case "/sessions":
		case "/list": return { kind: "sessions" };
		case "/use":
		case "/switch":
		case "/resume": return {
			kind: "use",
			sessionId: rest
		};
		case "/current":
		case "/session": return { kind: "current" };
		case "/stop":
		case "/cancel": return { kind: "stop" };
		case "/help": return { kind: "help" };
		default: return {
			kind: "prompt",
			text
		};
	}
}
/**
* Map one registered application command invocation to a bridge command.
* @param name - the interaction's command name.
* @param options - the interaction's options.
* @returns the parsed command, or undefined for a name we never registered.
*/
function commandFromInteraction(name, options) {
	const text = (key) => {
		const found = options.find((option) => option.name === key);
		return typeof found?.value === "string" ? found.value.trim() : "";
	};
	switch (name) {
		case "new": return {
			kind: "new",
			label: text("title")
		};
		case "sessions": return { kind: "sessions" };
		case "use": return {
			kind: "use",
			sessionId: text("session")
		};
		case "current": return { kind: "current" };
		case "stop": return { kind: "stop" };
		case "help": return { kind: "help" };
		default: return;
	}
}
/**
* The application commands the bridge registers on ready (bulk overwrite,
* idempotent). Type 3 = string option. Text-command parsing stays as a
* fallback, so the bridge works even before registration propagates.
*/
const APPLICATION_COMMANDS = [
	{
		name: "new",
		description: "新开一个 dsh 会话(与 web 界面共享)",
		options: [{
			type: 3,
			name: "title",
			description: "会话标题(可选)",
			required: false
		}]
	},
	{
		name: "sessions",
		description: "列出最近的 Discord 会话"
	},
	{
		name: "use",
		description: "把本频道绑定到指定会话(web 上的会话 id 也可以)",
		options: [{
			type: 3,
			name: "session",
			description: "会话 id",
			required: true
		}]
	},
	{
		name: "current",
		description: "显示当前绑定的会话"
	},
	{
		name: "stop",
		description: "取消当前会话正在跑的回合"
	},
	{
		name: "help",
		description: "桥接使用帮助"
	}
];
/** The `/help` reply, kept next to the parser it documents. */
const HELP_TEXT = [
	"**dsh Discord 桥接**",
	"直接发消息 → 发给当前 dsh 会话(没有就自动新建)",
	"`/new [标题]` — 新开一个会话(和 web 界面共享)",
	"`/sessions` — 列出最近的 Discord 会话",
	"`/use <会话id>` — 切换到某个会话(也可以是 web 上建的)",
	"`/current` — 显示当前绑定的会话",
	"`/stop` — 取消当前会话正在跑的回合",
	"`/help` — 本帮助"
].join("\n");
const CHUNK_BUDGET = 1950;
/** Language hint of the currently open fence at the end of `text`, or undefined when balanced. */
function openFence(text) {
	let open;
	for (const line of text.split("\n")) {
		const match = /^\s*```(\S*)/.exec(line);
		if (match === null) continue;
		open = open === void 0 ? match[1] ?? "" : void 0;
	}
	return open;
}
/** Cut index at the best boundary within the budget: paragraph > line > hard cut. */
function cutIndex(text, budget) {
	if (text.length <= budget) return text.length;
	const window = text.slice(0, budget);
	const paragraph = window.lastIndexOf("\n\n");
	if (paragraph > budget / 2) return paragraph + 1;
	const line = window.lastIndexOf("\n");
	if (line > budget / 2) return line + 1;
	return budget;
}
/**
* Split `text` into sendable chunks.
* @param text - the full reply.
* @param maxChunks - cap on messages; overflow is truncated with a notice.
* @returns non-empty chunks, each within Discord's limit.
*/
function chunkReply(text, maxChunks = 6) {
	const trimmed = text.trim();
	if (trimmed === "") return [];
	const chunks = [];
	let rest = trimmed;
	let carryFence;
	while (rest !== "" && chunks.length < maxChunks) {
		let piece = carryFence === void 0 ? "" : `\`\`\`${carryFence}\n`;
		const budget = CHUNK_BUDGET - piece.length;
		const cut = cutIndex(rest, budget);
		piece += rest.slice(0, cut);
		rest = rest.slice(cut);
		const fence = openFence(piece);
		if (fence !== void 0 && rest !== "") piece += "\n```";
		carryFence = fence;
		chunks.push(piece.trim());
	}
	if (rest !== "") {
		const last = chunks[chunks.length - 1];
		const notice = "\n\n…(回复过长已截断,完整内容请在 web 界面查看)";
		if (last !== void 0 && last.length + 28 <= 2e3) chunks[chunks.length - 1] = last + notice;
	}
	return chunks.filter((chunk) => chunk !== "");
}
//#endregion
//#region src/reply.ts
/** Find the seq of the user/message event carrying this Discord message id. */
function findPromptSeq(events, discordMessageId) {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event === void 0 || event.type !== "user/message") continue;
		if (event.data.source?.discordMessageId === discordMessageId) return event.seq;
	}
}
/**
* Fold the events between the bridged prompt and its turn's end into a reply.
*
* The prompt's own `turn/start` precedes the `user/message` event in the log
* (the driver opens the turn, then appends the claimed message), so the fold
* simply starts AT the prompt and stops at the first `turn/end` after it —
* everything between belongs to the turn this prompt opened.
* @param events - the session's full in-memory event log.
* @param promptSeq - seq of the bridged user/message event.
* @returns the folded reply; `reasonKind` is undefined when the turn has not ended.
*/
function extractReply(events, promptSeq) {
	let text = "";
	let reasonKind;
	let errorMessage;
	for (const event of events) {
		if (event.seq < promptSeq) continue;
		if (event.type === "assistant/message") {
			const joined = (event.data.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
			if (joined !== "") text = joined;
			continue;
		}
		if (event.type === "turn/end") {
			const reason = event.data.reason;
			reasonKind = reason?.kind;
			errorMessage = reason?.error?.message;
			break;
		}
	}
	return {
		text,
		reasonKind,
		errorMessage
	};
}
//#endregion
//#region src/bridge.ts
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
/** Bridges parsed Discord commands onto dsh agents. One instance per plugin. */
var SessionBridge = class {
	ctx;
	host;
	store;
	config;
	log;
	/** Per-channel promise chain: one channel's prompts run strictly in order. */
	channelChains = /* @__PURE__ */ new Map();
	/** Deduplicates concurrent create/resume of one session id. */
	acquisitions = /* @__PURE__ */ new Map();
	constructor(options) {
		this.ctx = options.ctx;
		this.host = options.host;
		this.store = options.store;
		this.config = options.config;
		this.log = options.log;
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
	async handle(command, channelId, messageId, beginTyping) {
		switch (command.kind) {
			case "help": return [HELP_TEXT];
			case "new": return await this.commandNew(channelId, command.label);
			case "sessions": return await this.commandSessions(channelId);
			case "use": return await this.commandUse(channelId, command.sessionId);
			case "current": return await this.commandCurrent(channelId);
			case "stop": return this.commandStop(channelId);
			case "prompt": return await this.enqueuePrompt(channelId, messageId, command.text, beginTyping);
		}
	}
	sessionId(id) {
		return this.host.SessionId(id.startsWith("session-") ? id : `session-${id}`);
	}
	defaultSelection() {
		const service = this.ctx.get("agentDefaultModel");
		if (service === void 0) throw new Error("agentDefaultModel service is unavailable");
		return service.currentSelection();
	}
	/**
	* Install the log-following model selection the web host installs, so a
	* session driven from both surfaces converges on the same route. Reading
	* the logged request header (not a creation-time snapshot) means a model
	* switched in the web UI carries over to later Discord turns.
	*/
	installSelection(agentCtx) {
		const agent = agentCtx.agent;
		if (agent === void 0) throw new Error("discord-bridge: agent setup has no scoped agent");
		let picked;
		const bridge = this;
		this.host.installModelSelection(agentCtx, {
			get current() {
				if (picked !== void 0) return picked;
				const logged = agent.session.requestHeader()?.config;
				if (logged === void 0) return bridge.defaultSelection();
				return {
					provider: logged.provider,
					model: logged.model,
					...logged.reasoningEffort === void 0 ? {} : { reasoningEffort: logged.reasoningEffort }
				};
			},
			set current(next) {
				picked = next;
			},
			assembled: void 0
		});
	}
	/** Compose the preset-mounting setup the web host uses for the same session. */
	async composeSetup(presetId) {
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return { setup: (agentCtx) => {
			this.installSelection(agentCtx);
			return Promise.resolve();
		} };
		const resolvedId = (await presets.resolve(presetId)).id;
		return {
			agentPreset: resolvedId,
			setup: async (agentCtx) => {
				this.installSelection(agentCtx);
				await presets.mount(agentCtx, resolvedId);
			}
		};
	}
	/** Create a fresh session the web UI can open, and bind the channel to it. */
	async createSession(channelId, label) {
		try {
			await mkdir(this.config.cwd, { recursive: true });
		} catch (error) {
			throw new Error(`failed to ensure session cwd "${this.config.cwd}": ${String(error)}`, { cause: error });
		}
		const composition = await this.composeSetup(this.config.preset === "" ? void 0 : this.config.preset);
		const id = `session-${randomUUID()}`;
		const handle = await this.ctx.agents.create({
			sessionId: this.host.SessionId(id),
			meta: {
				cwd: this.config.cwd,
				...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
			},
			agentOptions: this.agentOptions(),
			setup: composition.setup
		});
		const title = this.composeTitle(label);
		this.applyTitle(handle.agent, title);
		this.store.set(channelId, id);
		return {
			agent: handle.agent,
			title
		};
	}
	agentOptions() {
		const { provider, model } = this.defaultSelection();
		return {
			provider,
			model
		};
	}
	composeTitle(label) {
		const now = /* @__PURE__ */ new Date();
		const pad = (value) => String(value).padStart(2, "0");
		const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
		const body = label === "" ? stamp : `${label} · ${stamp}`;
		return `${this.config.titlePrefix}${body}`;
	}
	/** Pin the Discord marker title; a deployment without the service keeps the fallback title. */
	applyTitle(agent, title) {
		const titles = this.ctx.get("sessionTitle");
		if (titles === void 0) return;
		try {
			titles.rename(agent.session, title);
		} catch (error) {
			this.log("warn", `session title rename failed: ${String(error)}`);
		}
	}
	/**
	* Resolve one session id to a live agent, resuming it the way the web host
	* does: composed from the preset the log records.
	*/
	async acquire(rawId) {
		const id = this.sessionId(rawId);
		const live = this.ctx.agents.get(id);
		if (live !== void 0) return live;
		let acquisition = this.acquisitions.get(id);
		if (acquisition === void 0) {
			acquisition = (async () => {
				const again = this.ctx.agents.get(id);
				if (again !== void 0) return again;
				const persistence = this.ctx.get("sessionPersistence");
				if (persistence === void 0) throw new Error("session persistence is unavailable");
				const inspected = await persistence.inspect(id);
				const storedPreset = this.host.resolveSessionPreset({
					header: inspected.meta,
					events: inspected.events
				});
				const composition = await this.composeSetup(storedPreset);
				return (await this.ctx.agents.resume({
					resumeSessionId: id,
					agentOptions: this.agentOptions(),
					setup: composition.setup
				})).agent;
			})().finally(() => {
				this.acquisitions.delete(id);
			});
			this.acquisitions.set(id, acquisition);
		}
		return await acquisition;
	}
	/** The channel's agent: bound session when it still exists, else a new one. */
	async ensureChannelAgent(channelId) {
		const bound = this.store.get(channelId);
		if (bound !== void 0) try {
			return {
				agent: await this.acquire(bound),
				created: false
			};
		} catch (error) {
			this.log("warn", `bound session ${bound} could not be resumed (${String(error)}); creating a new one`);
		}
		const created = await this.createSession(channelId, "");
		return {
			agent: created.agent,
			created: true,
			title: created.title
		};
	}
	async enqueuePrompt(channelId, messageId, text, beginTyping) {
		const run = (this.channelChains.get(channelId) ?? Promise.resolve()).then(async () => await this.runPrompt(channelId, messageId, text, beginTyping));
		this.channelChains.set(channelId, run.then(() => void 0, () => void 0));
		return await run;
	}
	async runPrompt(channelId, messageId, text, beginTyping) {
		const stopTyping = beginTyping();
		try {
			const { agent, created, title } = await this.ensureChannelAgent(channelId);
			const preamble = created && title !== void 0 ? [`(已自动新建会话 **${title}** · \`${agent.id}\`)`] : [];
			agent.followup(this.host.createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "user",
					discordMessageId: messageId,
					discordChannelId: channelId
				}
			}));
			await agent.whenIdle();
			const flushable = this.ctx.get("sessions");
			if (flushable !== void 0) await flushable.flush(agent.session);
			const events = agent.session.events;
			const promptSeq = findPromptSeq(events, messageId);
			if (promptSeq === void 0) return [...preamble, "⚠️ 消息没有进入会话(可能被取消),请重试。"];
			const reply = extractReply(events, promptSeq);
			if (reply.reasonKind === "completed" || reply.reasonKind === void 0 && reply.text !== "") {
				const chunks = chunkReply(reply.text, this.config.maxChunksPerReply);
				return chunks.length === 0 ? [...preamble, "(本回合没有文本回复)"] : [...preamble, ...chunks];
			}
			if (reply.reasonKind === "cancelled") return [...preamble, "⏹️ 回合被取消。"];
			const detail = reply.errorMessage ?? reply.reasonKind ?? "unknown";
			return [...preamble, `⚠️ 回合失败: ${detail}`];
		} catch (error) {
			this.log("warn", `prompt failed: ${String(error)}`);
			return [`⚠️ 出错了: ${error instanceof Error ? error.message : String(error)}`];
		} finally {
			stopTyping();
		}
	}
	async commandNew(channelId, label) {
		try {
			const { agent, title } = await this.createSession(channelId, label);
			return [`✅ 已新建会话 **${title}**\nid: \`${agent.id}\`\n这个会话和 web 界面完全共享,直接发消息即可对话。`];
		} catch (error) {
			return [`⚠️ 新建会话失败: ${error instanceof Error ? error.message : String(error)}`];
		}
	}
	async commandSessions(channelId) {
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0) return ["⚠️ 会话持久化服务不可用。"];
		const bound = this.store.get(channelId);
		const headers = await persistence.list();
		const boundIds = new Set(this.store.entries().map(([, session]) => session));
		const lines = headers.filter((header) => boundIds.has(header.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map((header) => {
			const marker = header.id === bound ? "👉 " : "";
			const created = new Date(header.createdAt);
			const pad = (value) => String(value).padStart(2, "0");
			const stamp = `${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`;
			return `${marker}\`${header.id}\` · ${stamp}`;
		});
		if (lines.length === 0) return ["还没有 Discord 桥接过的会话。发 `/new` 或直接发消息开始。"];
		return [[
			`**Discord 桥接过的会话**(👉 = 本频道当前绑定)`,
			...lines,
			"用 `/use <id>` 切换;web 上任意会话的 id 也可以。"
		].join("\n")];
	}
	async commandUse(channelId, rawId) {
		if (rawId === "") return ["用法: `/use <会话id>`"];
		try {
			const agent = await this.acquire(rawId);
			this.store.set(channelId, agent.id);
			return [`✅ 本频道已绑定会话 \`${agent.id}\`,直接发消息继续对话。`];
		} catch (error) {
			return [`⚠️ 绑定失败: ${error instanceof Error ? error.message : String(error)}`];
		}
	}
	async commandCurrent(channelId) {
		const bound = this.store.get(channelId);
		if (bound === void 0) return ["本频道还没有绑定会话;发消息会自动新建,或用 `/new`、`/use <id>`。"];
		const live = this.ctx.agents.get(this.sessionId(bound));
		const status = live === void 0 ? "未加载(冷会话)" : live.status;
		return [`当前会话: \`${bound}\`\n状态: ${String(status)}`];
	}
	commandStop(channelId) {
		const bound = this.store.get(channelId);
		if (bound === void 0) return ["本频道还没有绑定会话。"];
		const live = this.ctx.agents.get(this.sessionId(bound));
		if (live === void 0) return ["会话未在运行,无需取消。"];
		live.cancel({ kind: "user" });
		return ["⏹️ 已请求取消当前回合。"];
	}
};
//#endregion
//#region src/state.ts
/**
* Channel-to-session binding, persisted as one small JSON file.
*
* The binding is bridge-local state, not session truth: the sessions
* themselves live in dsh's persistence and survive without this file. Losing
* it only forgets which conversation each Discord channel was pointed at.
*
* @module dsh-plugin-discord/state
*/
/** Persistent channel→session map with atomic-rename writes. */
var BindingStore = class {
	file;
	state = {
		version: 1,
		channels: {}
	};
	writeChain = Promise.resolve();
	constructor(file) {
		this.file = file;
	}
	async load() {
		try {
			const raw = await readFile(this.file, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && parsed.channels !== null && typeof parsed.channels === "object") {
				const channels = {};
				for (const [channel, session] of Object.entries(parsed.channels ?? {})) if (typeof session === "string") channels[channel] = session;
				this.state = {
					version: 1,
					channels
				};
			}
		} catch {}
	}
	get(channelId) {
		return this.state.channels[channelId];
	}
	set(channelId, sessionId) {
		this.state.channels[channelId] = sessionId;
		this.scheduleSave();
	}
	delete(channelId) {
		if (this.state.channels[channelId] === void 0) return;
		const { [channelId]: _removed, ...rest } = this.state.channels;
		this.state.channels = rest;
		this.scheduleSave();
	}
	/** All bindings, newest-write-order not guaranteed. */
	entries() {
		return Object.entries(this.state.channels);
	}
	scheduleSave() {
		const snapshot = JSON.stringify(this.state, null, 2);
		this.writeChain = this.writeChain.then(async () => {
			try {
				await mkdir(dirname(this.file), { recursive: true });
				const temp = `${this.file}.tmp`;
				await writeFile(temp, snapshot, "utf8");
				await rename(temp, this.file);
			} catch {}
		});
	}
	/** Settle pending writes (tests and orderly shutdown). */
	async flush() {
		await this.writeChain;
	}
};
//#endregion
//#region src/host-modules.ts
/**
* Late-bound access to the harness packages this bridge drives.
*
* These live in the profile's own tree, not in this plugin's. A plugin
* installed normally finds them by Node's parent walk, but one installed with
* `link:` (the usual dev loop) sits outside the profile directory and never
* reaches it. Resolving through `ctx.baseUrl` — the profile directory the
* loader booted from — covers both, and importing the resolved path keeps a
* single module instance shared with the host rather than a second copy.
*
* @module dsh-plugin-discord/host-modules
*/
/**
* Resolve one specifier against this module, then against the profile.
* @param specifier - bare package specifier.
* @param baseUrl - the loader's base URL, when the entry has one.
* @returns an absolute file URL for the module.
* @throws when no anchor resolves it, naming every path tried.
*/
function resolveHostModule(specifier, baseUrl) {
	const failures = [];
	for (const anchor of [import.meta.url, ...baseUrl === void 0 ? [] : [baseUrl]]) try {
		return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
	} catch (error) {
		failures.push(`${anchor}: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
	}
	throw new Error(`dsh-plugin-discord: cannot resolve "${specifier}" from the profile. Tried:\n` + failures.map((line) => `  - ${line}`).join("\n"));
}
/**
* Load the harness modules the bridge needs.
* @param baseUrl - `ctx.baseUrl` of the plugin entry.
* @returns the resolved harness entry points.
*/
async function loadHostModules(baseUrl) {
	const [agent, llm, session, presets] = await Promise.all([
		import(resolveHostModule("@deepseek-ai/dsh-agent", baseUrl)),
		import(resolveHostModule("@deepseek-ai/dsh-llm", baseUrl)),
		import(resolveHostModule("@deepseek-ai/dsh-session", baseUrl)),
		import(resolveHostModule("@deepseek-ai/dsh-agent-presets", baseUrl))
	]);
	return {
		installModelSelection: agent.installModelSelection,
		createUserMessage: llm.createUserMessage,
		SessionId: session.SessionId,
		resolveSessionPreset: presets.resolveSessionPreset
	};
}
//#endregion
//#region src/index.ts
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
/** Cordis plugin name. */
const name = "discord-bridge";
/** Core services required before the bridge can start. */
const inject = [
	"agents",
	"sessions",
	"agentDefaultModel"
];
/** Runtime schema for {@link Config}. */
const Config = z.object({
	token: z.string().default(""),
	tokenEnv: z.string().default("DSH_DISCORD_TOKEN"),
	tokenFile: z.string().default(""),
	tokenFileKey: z.string().default("DISCORD_BOT_TOKEN"),
	allowedUsers: z.array(z.string()).default([]),
	allowedChannels: z.array(z.string()).default([]),
	cwd: z.string().default(homedir()),
	preset: z.string().default(""),
	titlePrefix: z.string().default("[Discord] "),
	maxChunksPerReply: z.number().default(6),
	stateFile: z.string().default(""),
	typingIntervalMs: z.number().default(8e3),
	gatewayUrl: z.string().default(""),
	restBaseUrl: z.string().default("")
});
function loggerOf(ctx) {
	const candidate = ctx.logger;
	return {
		info: (...args) => {
			console.log("[discord-bridge]", ...args);
			candidate?.info(...args);
		},
		warn: (...args) => {
			console.warn("[discord-bridge]", ...args);
			candidate?.warn(...args);
		}
	};
}
/** Where channel bindings persist: explicit config, else the profile directory. */
function resolveStateFile(configured, baseUrl) {
	if (configured !== "") return configured;
	if (baseUrl !== void 0 && baseUrl.startsWith("file:")) try {
		return join(fileURLToPath(baseUrl), "discord-bridge-state.json");
	} catch {}
	return join(homedir(), ".dsh", "discord-bridge-state.json");
}
/**
* Resolve the bot token: explicit config, then environment, then token file.
* The file form keeps the secret out of profile YAML: it may hold the raw
* token, or `KEY=value` lines (an env file) looked up by `tokenFileKey`.
* @returns the token, or empty when nothing is configured.
*/
async function resolveToken(config) {
	if (config.token.trim() !== "") return config.token.trim();
	const fromEnv = (process.env[config.tokenEnv] ?? "").trim();
	if (fromEnv !== "") return fromEnv;
	if (config.tokenFile === "") return "";
	const raw = (await readFile(config.tokenFile, "utf8")).trim();
	if (!raw.includes("=")) return raw;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(`${config.tokenFileKey}=`)) continue;
		return trimmed.slice(config.tokenFileKey.length + 1).trim().replace(/^["']|["']$/g, "");
	}
	return "";
}
/** Message admission: bots never, DMs by user allowlist, guilds by channel (and user when listed). */
function isAllowed(message, botUserId, allowedUsers, allowedChannels) {
	if (message.author.bot === true) return false;
	if (botUserId !== void 0 && message.author.id === botUserId) return false;
	if (message.guild_id === void 0) return allowedUsers.includes(message.author.id);
	if (!allowedChannels.includes(message.channel_id)) return false;
	return allowedUsers.length === 0 || allowedUsers.includes(message.author.id);
}
/** Wire the gateway, REST, and session bridge together for one deployment. */
function apply(ctx, config) {
	const logger = loggerOf(ctx);
	if (config.allowedUsers.length === 0 && config.allowedChannels.length === 0) {
		logger.warn("discord-bridge: allowedUsers and allowedChannels are both empty; refusing to expose the agent to arbitrary Discord users — bridge disabled");
		return;
	}
	ctx.effect(() => {
		let disposed = false;
		let gateway;
		let rest;
		const store = new BindingStore(resolveStateFile(config.stateFile, ctx.baseUrl));
		let botUserId;
		let applicationId;
		let commandsRegistered = false;
		const emptyContentWarned = /* @__PURE__ */ new Set();
		const beginTypingFor = (channelId) => {
			let timer;
			const fire = () => {
				rest.triggerTyping(channelId).catch(() => {});
			};
			fire();
			timer = setInterval(fire, Math.max(config.typingIntervalMs, 3e3));
			return () => {
				if (timer !== void 0) clearInterval(timer);
				timer = void 0;
			};
		};
		(async () => {
			const token = await resolveToken(config);
			if (token === "") {
				logger.warn(`discord-bridge: no bot token (set config.token, the ${config.tokenEnv} environment variable, or config.tokenFile); bridge disabled`);
				return;
			}
			rest = new DiscordRest({
				token,
				...config.restBaseUrl === "" ? {} : { baseUrl: config.restBaseUrl }
			});
			await store.load();
			const bridge = new SessionBridge({
				ctx,
				host: await loadHostModules(ctx.baseUrl),
				store,
				config: {
					cwd: config.cwd,
					preset: config.preset,
					titlePrefix: config.titlePrefix,
					maxChunksPerReply: config.maxChunksPerReply
				},
				log: (level, text) => {
					logger[level](`discord-bridge: ${text}`);
				}
			});
			const me = await rest.getMe();
			botUserId = me.id;
			logger.info(`discord-bridge: authenticated as ${me.username} (${me.id})`);
			if (disposed) return;
			const onMessage = (message) => {
				if (!isAllowed(message, botUserId, config.allowedUsers, config.allowedChannels)) return;
				const content = message.content ?? "";
				if (content.trim() === "") {
					if (message.guild_id !== void 0 && !emptyContentWarned.has(message.channel_id)) {
						emptyContentWarned.add(message.channel_id);
						rest.createMessage(message.channel_id, "⚠️ 收到了空消息内容。如果你发的是文字,机器人缺少 MESSAGE_CONTENT intent(在 Discord developer portal 打开),或改用私聊。").catch(() => {});
					}
					return;
				}
				const command = parseCommand(content);
				(async () => {
					const chunks = await bridge.handle(command, message.channel_id, message.id, () => beginTypingFor(message.channel_id));
					for (const [index, chunk] of chunks.entries()) try {
						await rest.createMessage(message.channel_id, chunk, index === 0 ? message.id : void 0);
					} catch (error) {
						logger.warn(`discord-bridge: send failed: ${String(error)}`);
						break;
					}
				})().catch((error) => {
					logger.warn(`discord-bridge: message handling failed: ${String(error)}`);
				});
			};
			const onInteraction = (interaction) => {
				const commandName = interaction.data?.name;
				if (commandName === void 0) return;
				const author = interaction.member?.user ?? interaction.user;
				if (author === void 0) return;
				const channelId = interaction.channel_id ?? "";
				const admission = {
					...interaction.guild_id === void 0 ? {} : { guild_id: interaction.guild_id },
					channel_id: channelId,
					author
				};
				(async () => {
					if (!isAllowed(admission, botUserId, config.allowedUsers, config.allowedChannels)) {
						await rest.ackEphemeral(interaction.id, interaction.token, "未授权使用这个桥接。");
						return;
					}
					const command = commandFromInteraction(commandName, interaction.data?.options ?? []);
					if (command === void 0) {
						await rest.ackEphemeral(interaction.id, interaction.token, `未知命令 /${commandName}`);
						return;
					}
					await rest.ackDeferred(interaction.id, interaction.token);
					const chunks = await bridge.handle(command, channelId, interaction.id, () => () => {});
					const appId = applicationId;
					if (appId === void 0) return;
					const [first, ...others] = chunks;
					await rest.editOriginalResponse(appId, interaction.token, first ?? "(无输出)");
					for (const chunk of others) await rest.followupResponse(appId, interaction.token, chunk);
				})().catch((error) => {
					logger.warn(`discord-bridge: interaction handling failed: ${String(error)}`);
				});
			};
			gateway = new DiscordGateway({
				token,
				intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT,
				...config.gatewayUrl === "" ? {} : { url: config.gatewayUrl },
				hooks: {
					onMessage,
					onInteraction,
					onReady: (ready) => {
						botUserId = ready.botUserId;
						applicationId = ready.applicationId;
						logger.info(`discord-bridge: gateway ready (bot ${ready.botUserId})`);
						if (!commandsRegistered && applicationId !== void 0) {
							commandsRegistered = true;
							rest.bulkOverwriteCommands(applicationId, APPLICATION_COMMANDS).then(() => {
								logger.info("discord-bridge: slash commands registered");
							}, (error) => {
								commandsRegistered = false;
								logger.warn(`discord-bridge: slash command registration failed (text commands still work): ${String(error)}`);
							});
						}
					},
					onFatal: (reason) => {
						logger.warn(`discord-bridge: gateway gave up: ${reason}`);
					},
					log: (level, text) => {
						logger[level](`discord-bridge: ${text}`);
					}
				}
			});
			if (!disposed) gateway.start();
		})().catch((error) => {
			logger.warn(`discord-bridge: boot failed: ${String(error)}`);
		});
		return () => {
			disposed = true;
			gateway?.stop();
			store.flush();
		};
	}, "discord bridge lifecycle");
}
//#endregion
export { Config, apply, inject, isAllowed, name, resolveStateFile, resolveToken };

//# sourceMappingURL=index.js.map