import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
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
	async request(method, path, body, form) {
		for (let attempt = 0;; attempt++) {
			const response = await fetch(`${this.base}${path}`, {
				method,
				headers: {
					"authorization": `Bot ${this.token}`,
					"user-agent": "DiscordBot (https://github.com/ghbhiee/dsh-plugin-discord, 0.1.0)",
					...body === void 0 || form !== void 0 ? {} : { "content-type": "application/json" }
				},
				...form !== void 0 ? { body: form } : body === void 0 ? {} : { body: JSON.stringify(body) }
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
	/** Send one message carrying interactive components (selects/buttons). */
	async createComponentMessage(channelId, content, components) {
		return await this.request("POST", `/channels/${channelId}/messages`, {
			content,
			components,
			allowed_mentions: { parse: [] }
		});
	}
	/** Edit one of the bot's own messages (content and/or components). */
	async editMessage(channelId, messageId, content, components) {
		await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, {
			content,
			...components === void 0 ? {} : { components },
			allowed_mentions: { parse: [] }
		});
	}
	/** Raw interaction callback (update-message, modal, …). */
	async respondInteraction(interactionId, interactionToken, payload) {
		await this.request("POST", `/interactions/${interactionId}/${interactionToken}/callback`, payload);
	}
	/** Send one message carrying file attachments (multipart upload). */
	async createMessageWithFiles(channelId, content, files) {
		const form = new FormData();
		form.append("payload_json", JSON.stringify({
			content,
			allowed_mentions: { parse: [] },
			attachments: files.map((file, index) => ({
				id: index,
				filename: file.filename
			}))
		}));
		files.forEach((file, index) => {
			form.append(`files[${String(index)}]`, new Blob([file.data]), file.filename);
		});
		return await this.request("POST", `/channels/${channelId}/messages`, {}, form);
	}
	/** Open (or fetch) the bot's DM channel with one user. */
	async createDM(userId) {
		return await this.request("POST", "/users/@me/channels", { recipient_id: userId });
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
//#region src/attachments.ts
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
/** One marker line the agent wrote; the path is taken verbatim. */
const FILE_MARKER = /^[ \t]*\[discord-file:[ \t]*([^\]\n]+?)[ \t]*\][ \t]*$/gm;
/**
* Pull `[discord-file: …]` markers out of a reply.
* @param text - the assistant's reply text.
* @returns the text with marker lines removed, and the marked paths in order.
*/
function extractFileMarkers(text) {
	const paths = [];
	return {
		text: text.replace(FILE_MARKER, (_line, path) => {
			paths.push(path);
			return "";
		}).replace(/\n{3,}/g, "\n\n").trim(),
		paths
	};
}
/**
* Whether `child` lies at or under `root` (lexical, after resolution).
* Callers pass realpath-ed inputs when symlink escape matters.
*/
function isPathUnder(child, root) {
	const childPath = resolve(child);
	const rootPath = resolve(root);
	return childPath === rootPath || childPath.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep);
}
/** A filesystem-safe name for one incoming Discord attachment. */
function sanitizeFilename(name) {
	const cleaned = basename(name).replace(/[^\w.\-一-鿿]+/g, "_");
	const bounded = cleaned.length > 80 ? cleaned.slice(cleaned.length - 80) : cleaned;
	return bounded === "" || /^\.+$/.test(bounded) ? "file" : bounded;
}
/**
* The capability notice injected once per live agent, so a model driven from
* Discord knows the bridge's transport abilities instead of hunting for other
* Discord tooling on the host.
* @param maxUploadBytes - the deployment's outgoing attachment cap.
* @param uploadRoots - extra directories uploads may come from.
* @returns the notice text.
*/
function capabilityNotice(maxUploadBytes, uploadRoots = []) {
	const megabytes = Math.floor(maxUploadBytes / 1e6);
	return [
		"<system-reminder>",
		"本会话正通过 Discord 桥接(dsh-plugin-discord)与用户对话;用户此刻在 Discord 客户端上。",
		`- 发送文件/图片给用户:在回复中单独一行写 [discord-file: /绝对路径],桥接会把该文件作为 Discord 附件上传,并把这行从文本中移除。${uploadRoots.length === 0 ? "仅限会话工作目录内的文件" : `仅限会话工作目录及这些目录内的文件: ${uploadRoots.join("、")}`},单个不超过 ${String(megabytes)}MB;图片会在 Discord 内联显示。`,
		"- 重要:文件在允许目录之外时(工具/skill 常把产物写到别处),先把它复制进会话工作目录,再对复制后的路径写标记——否则会被安全围栏拒绝。",
		"- 用户在 Discord 发的文件/图片会自动保存到工作目录的 .discord-uploads/ 里,消息里会附上路径,直接读取即可。",
		"- 文本回复按 2000 字符分片发送,过长会被截断;保持精炼。",
		"- 不要寻找或使用主机上其它 Discord 工具/凭据来发消息;所有 Discord 通信都由桥接负责。",
		"</system-reminder>"
	].join("\n");
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
	/** Live agents that already received the capability notice. */
	noticed = /* @__PURE__ */ new WeakSet();
	constructor(options) {
		this.ctx = options.ctx;
		this.host = options.host;
		this.store = options.store;
		this.config = options.config;
		this.log = options.log;
	}
	/**
	* Handle one parsed command; replies carry text chunks and any attachments.
	* Prompts serialize per channel; management commands answer immediately.
	* @param command - the parsed instruction.
	* @param channelId - Discord channel the message arrived in.
	* @param messageId - Discord message id (stamped onto the prompt's source).
	* @param beginTyping - starts a typing indicator; returns its stopper.
	* @param attachments - files the user attached to the Discord message.
	* @returns the reply; each chunk is within Discord's message limit.
	*/
	async handle(command, channelId, messageId, beginTyping, attachments = []) {
		const text = async (chunks) => ({
			chunks: await chunks,
			files: []
		});
		switch (command.kind) {
			case "help": return await text([HELP_TEXT]);
			case "new": return await text(this.commandNew(channelId, command.label));
			case "sessions": return await text(this.commandSessions(channelId));
			case "use": return await text(this.commandUse(channelId, command.sessionId));
			case "current": return await text(this.commandCurrent(channelId));
			case "stop": return await text(this.commandStop(channelId));
			case "prompt": return await this.enqueuePrompt(channelId, messageId, command.text, beginTyping, attachments);
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
	async enqueuePrompt(channelId, messageId, text, beginTyping, attachments) {
		const run = (this.channelChains.get(channelId) ?? Promise.resolve()).then(async () => await this.runPrompt(channelId, messageId, text, beginTyping, attachments));
		this.channelChains.set(channelId, run.then(() => void 0, () => void 0));
		return await run;
	}
	/** Tell a freshly acquired agent about the bridge's transport abilities, once. */
	injectNoticeOnce(agent) {
		if (this.noticed.has(agent)) return;
		this.noticed.add(agent);
		agent.inject(this.host.createUserMessage({
			content: [{
				type: "text",
				text: capabilityNotice(this.config.maxUploadBytes, this.config.uploadRoots)
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-plugin-discord",
				form: "instructions"
			}
		}));
	}
	/** Save the user's Discord attachments under the session cwd; describe them for the prompt. */
	async saveIncoming(agentCwd, messageId, attachments) {
		const notes = [];
		const directory = join(agentCwd, ".discord-uploads");
		for (const attachment of attachments.slice(0, 5)) try {
			if (attachment.size > this.config.maxIncomingBytes) {
				notes.push(`[Discord 附件 ${attachment.filename} 超过 ${String(Math.floor(this.config.maxIncomingBytes / 1e6))}MB,未保存]`);
				continue;
			}
			const response = await fetch(attachment.url);
			if (!response.ok) throw new Error(`download failed: ${String(response.status)}`);
			const data = new Uint8Array(await response.arrayBuffer());
			await mkdir(directory, { recursive: true });
			const target = join(directory, `${messageId}-${sanitizeFilename(attachment.filename)}`);
			await writeFile(target, data);
			notes.push(`[用户通过 Discord 发来文件,已保存: ${target}${attachment.content_type === void 0 ? "" : ` (${attachment.content_type})`}]`);
		} catch (error) {
			this.log("warn", `incoming attachment failed: ${String(error)}`);
			notes.push(`[Discord 附件 ${attachment.filename} 保存失败]`);
		}
		return notes;
	}
	/** Read the agent's marked files, enforcing containment and the size cap. */
	async collectUploads(agentCwd, paths) {
		const files = [];
		const problems = [];
		const roots = [];
		for (const root of [agentCwd, ...this.config.uploadRoots]) try {
			roots.push(await realpath(root));
		} catch {}
		for (const path of paths.slice(0, 10)) try {
			const resolved = await realpath(path);
			if (!roots.some((root) => isPathUnder(resolved, root))) {
				problems.push(`⚠️ 未发送 ${path}:不在允许目录内(会话工作目录${this.config.uploadRoots.length > 0 ? " + uploadRoots" : ""})。`);
				continue;
			}
			const info = await stat(resolved);
			if (!info.isFile()) {
				problems.push(`⚠️ 未发送 ${path}:不是普通文件。`);
				continue;
			}
			if (info.size > this.config.maxUploadBytes) {
				problems.push(`⚠️ 未发送 ${path}:${String(Math.ceil(info.size / 1e6))}MB 超过上限 ${String(Math.floor(this.config.maxUploadBytes / 1e6))}MB。`);
				continue;
			}
			files.push({
				filename: basename(resolved),
				data: new Uint8Array(await readFile(resolved))
			});
		} catch (error) {
			problems.push(`⚠️ 未发送 ${path}:${error instanceof Error ? error.message : String(error)}`);
		}
		return {
			files,
			problems
		};
	}
	async runPrompt(channelId, messageId, text, beginTyping, attachments) {
		const stopTyping = beginTyping();
		try {
			const { agent, created, title } = await this.ensureChannelAgent(channelId);
			const preamble = created && title !== void 0 ? [`(已自动新建会话 **${title}** · \`${agent.id}\`)`] : [];
			this.injectNoticeOnce(agent);
			const agentCwd = agent.session.header.cwd ?? this.config.cwd;
			let promptText = text;
			if (attachments.length > 0) {
				const notes = await this.saveIncoming(agentCwd, messageId, attachments);
				if (notes.length > 0) promptText = `${promptText}\n\n${notes.join("\n")}`.trim();
			}
			agent.followup(this.host.createUserMessage({
				content: [{
					type: "text",
					text: promptText
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
			if (promptSeq === void 0) return {
				chunks: [...preamble, "⚠️ 消息没有进入会话(可能被取消),请重试。"],
				files: []
			};
			const reply = extractReply(events, promptSeq);
			if (reply.reasonKind === "completed" || reply.reasonKind === void 0 && reply.text !== "") {
				const { text: cleaned, paths } = extractFileMarkers(reply.text);
				const uploads = await this.collectUploads(agentCwd, paths);
				const chunks = chunkReply(cleaned, this.config.maxChunksPerReply);
				return {
					chunks: chunks.length === 0 && uploads.files.length === 0 ? [...preamble, "(本回合没有文本回复)"] : [
						...preamble,
						...chunks,
						...uploads.problems
					],
					files: uploads.files
				};
			}
			if (reply.reasonKind === "cancelled") return {
				chunks: [...preamble, "⏹️ 回合被取消。"],
				files: []
			};
			const detail = reply.errorMessage ?? reply.reasonKind ?? "unknown";
			return {
				chunks: [...preamble, `⚠️ 回合失败: ${detail}`],
				files: []
			};
		} catch (error) {
			this.log("warn", `prompt failed: ${String(error)}`);
			return {
				chunks: [`⚠️ 出错了: ${error instanceof Error ? error.message : String(error)}`],
				files: []
			};
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
//#region src/notify.ts
/** Sends bot messages, resolving and caching DM channels. */
var DiscordNotifier = class {
	rest;
	defaultUserId;
	maxChunks;
	dmChannels = /* @__PURE__ */ new Map();
	constructor(rest, defaultUserId, maxChunks) {
		this.rest = rest;
		this.defaultUserId = defaultUserId;
		this.maxChunks = maxChunks;
	}
	/**
	* Deliver one notification.
	* @param target - explicit channel or user; both absent targets the owner's DM.
	* @param content - message text; chunked to Discord's limit.
	* @returns the channel written to and the created message ids.
	*/
	async send(target, content) {
		if (content.trim() === "") throw new Error("content must not be empty");
		let channelId = target.channelId;
		if (channelId === void 0) {
			const userId = target.userId ?? this.defaultUserId;
			if (userId === void 0) throw new Error("no target: pass userId/channelId or configure allowedUsers");
			channelId = this.dmChannels.get(userId);
			if (channelId === void 0) {
				channelId = (await this.rest.createDM(userId)).id;
				this.dmChannels.set(userId, channelId);
			}
		}
		const messageIds = [];
		for (const chunk of chunkReply(content, this.maxChunks)) messageIds.push((await this.rest.createMessage(channelId, chunk)).id);
		return {
			channelId,
			messageIds
		};
	}
};
/**
* The tool definition, with the deployment's own HTTP recipe baked into the
* description: calling this MCP tool sends NOW, but reminders and monitors
* fire later, from cron/launchd/sleep jobs that cannot speak MCP — so the
* description teaches the equivalent curl, endpoint and secret path included.
*/
function mcpTool(httpEndpoint, secretPath) {
	return {
		name: "discord_notify",
		description: `Send a proactive Discord message from this dsh deployment's bot, IMMEDIATELY. Defaults to a DM to the deployment owner; pass userId for another allowlisted user's DM, or channelId for a guild channel the bot can post in. Use for alerts and task-completion notices. For a SCHEDULED or delayed reminder (提醒/闹钟/定时通知), do NOT call this tool now — instead create a timed job (sleep-in-background / at / cron / launchd) whose command sends the same notification over plain HTTP: curl -X POST ${httpEndpoint} -H "authorization: Bearer ${secretPath === "" ? "<the same bearer secret this MCP connection uses>" : `$(cat ${secretPath})`}" -H "content-type: application/json" -d '{"content": "提醒内容"}'. That endpoint is this same capability, callable without MCP, so it works from any scheduled job.`,
		inputSchema: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "Message text (Discord markdown; long text is split automatically)."
				},
				userId: {
					type: "string",
					description: "Discord user id to DM. Optional; defaults to the deployment owner."
				},
				channelId: {
					type: "string",
					description: "Guild channel id to post in instead of a DM. Optional."
				}
			},
			required: ["content"]
		}
	};
}
/**
* Answer one MCP JSON-RPC message.
* @returns the response object, or undefined for notifications (no `id`).
*/
async function handleMcpMessage(message, deps) {
	const { id, method, params } = message;
	const respond = (result) => ({
		jsonrpc: "2.0",
		id: id ?? null,
		result
	});
	const fail = (code, text) => ({
		jsonrpc: "2.0",
		id: id ?? null,
		error: {
			code,
			message: text
		}
	});
	if (method === void 0) return fail(-32600, "not a request");
	const isNotification = id === void 0;
	switch (method) {
		case "initialize": return respond({
			protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: {
				name: "dsh-plugin-discord",
				title: `Discord notify (${deps.botLabel()})`,
				version: deps.version
			}
		});
		case "ping": return respond({});
		case "tools/list": return respond({ tools: [mcpTool(deps.httpEndpoint, deps.secretPath)] });
		case "tools/call": {
			const name = params?.name;
			if (name !== "discord_notify") return fail(-32602, `unknown tool ${String(name)}`);
			const args = params?.arguments ?? {};
			if (typeof args.content !== "string" || args.content.trim() === "") return fail(-32602, "arguments.content must be a non-empty string");
			try {
				const sent = await deps.notifier.send({
					...typeof args.userId === "string" && args.userId !== "" ? { userId: args.userId } : {},
					...typeof args.channelId === "string" && args.channelId !== "" ? { channelId: args.channelId } : {}
				}, args.content);
				return respond({ content: [{
					type: "text",
					text: `sent via ${deps.botLabel()}: channel ${sent.channelId}, ${String(sent.messageIds.length)} message(s)`
				}] });
			} catch (error) {
				return respond({
					content: [{
						type: "text",
						text: `send failed: ${error instanceof Error ? error.message : String(error)}`
					}],
					isError: true
				});
			}
		}
		default:
			if (isNotification) return void 0;
			return fail(-32601, `method not found: ${method}`);
	}
}
const MAX_BODY_BYTES = 262144;
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}
/**
* Build the prefix-route handler for `/plugins/discord`.
* @param secret - required bearer token; every request is checked first.
* @param deps - capability implementations.
* @param log - operational logging.
*/
function createNotifyHandler(secret, deps, log) {
	return async (req, res) => {
		try {
			const path = (req.url ?? "").split("?")[0] ?? "";
			if (!(req.headers.authorization === `Bearer ${secret}`)) {
				sendJson(res, 401, { error: "missing or wrong bearer token" });
				return;
			}
			if (path === "/plugins/discord/api/notify" && req.method === "POST") {
				let body;
				try {
					body = JSON.parse(await readBody(req));
				} catch {
					sendJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (typeof body.content !== "string" || body.content.trim() === "") {
					sendJson(res, 400, { error: "content must be a non-empty string" });
					return;
				}
				try {
					sendJson(res, 200, {
						ok: true,
						...await deps.notifier.send({
							...typeof body.userId === "string" && body.userId !== "" ? { userId: body.userId } : {},
							...typeof body.channelId === "string" && body.channelId !== "" ? { channelId: body.channelId } : {}
						}, body.content)
					});
				} catch (error) {
					sendJson(res, 502, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
				return;
			}
			if (path === "/plugins/discord/mcp") {
				if (req.method !== "POST") {
					res.writeHead(405, { allow: "POST" });
					res.end();
					return;
				}
				let parsed;
				try {
					parsed = JSON.parse(await readBody(req));
				} catch {
					sendJson(res, 400, {
						jsonrpc: "2.0",
						id: null,
						error: {
							code: -32700,
							message: "parse error"
						}
					});
					return;
				}
				const messages = Array.isArray(parsed) ? parsed : [parsed];
				const responses = [];
				for (const message of messages) {
					const response = await handleMcpMessage(message, deps);
					if (response !== void 0) responses.push(response);
				}
				if (responses.length === 0) {
					res.writeHead(202);
					res.end();
					return;
				}
				sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
				return;
			}
			sendJson(res, 404, { error: "not found" });
		} catch (error) {
			log("warn", `notify handler failed: ${String(error)}`);
			if (!res.headersSent) sendJson(res, 500, { error: "internal" });
			else res.end();
		}
	};
}
//#endregion
//#region src/questions.ts
/** Discord component/interaction wire constants (numbers per Discord API v10). */
const DISCORD = {
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
	TEXT_INPUT_PARAGRAPH: 2
};
const truncate = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
/** Compose the Discord message text for one question. */
function formatQuestionContent(item, index, total) {
	const parts = [];
	const counter = total > 1 ? `(${String(index + 1)}/${String(total)}) ` : "";
	parts.push(`❓ ${counter}**${truncate(item.header ?? "请确认", 80)}**`);
	parts.push(truncate(item.question, 900));
	if (item.detail !== void 0 && item.detail.trim() !== "") parts.push(truncate(item.detail, 700).split("\n").map((line) => `> ${line}`).join("\n"));
	if ((item.options ?? []).length === 0) parts.push("_点击下面的按钮输入回答。_");
	return truncate(parts.join("\n"), 1900);
}
/**
* Build the component rows for one question: a select for the options (when
* present), plus buttons for a free-text answer and cancelling the ask.
* Custom ids embed the rpcId and question index — both well under Discord's
* 100-char id budget, unlike caller-supplied question ids.
*/
function buildComponents(rpcId, index, item) {
	const rows = [];
	const options = (item.options ?? []).slice(0, 25);
	if (options.length > 0) rows.push({
		type: DISCORD.ACTION_ROW,
		components: [{
			type: DISCORD.STRING_SELECT,
			custom_id: `q:${rpcId}:${String(index)}`,
			placeholder: truncate(item.multiSelect === true ? "选择一项或多项…" : "选择一项…", 100),
			min_values: 1,
			max_values: item.multiSelect === true ? options.length : 1,
			options: options.map((option, optionIndex) => ({
				value: String(optionIndex),
				label: truncate(option.label, 100),
				...option.description === void 0 ? {} : { description: truncate(option.description, 100) }
			}))
		}]
	});
	rows.push({
		type: DISCORD.ACTION_ROW,
		components: [{
			type: DISCORD.BUTTON,
			style: DISCORD.BUTTON_SECONDARY,
			custom_id: `qc:${rpcId}:${String(index)}`,
			label: "✏️ 自定义回答"
		}, {
			type: DISCORD.BUTTON,
			style: DISCORD.BUTTON_DANGER,
			custom_id: `qx:${rpcId}:${String(index)}`,
			label: "取消提问"
		}]
	});
	return rows;
}
/** Parse a custom id minted by {@link buildComponents}; undefined for foreign ids. */
function parseCustomId(customId) {
	const match = /^(q|qc|qx|qm):([^:]+):(\d+)$/.exec(customId);
	if (match === null) return void 0;
	return {
		kind: {
			q: "select",
			qc: "custom",
			qx: "cancel",
			qm: "modal"
		}[match[1]],
		rpcId: match[2] ?? "",
		index: Number(match[3])
	};
}
/** The live relay; one per plugin instance. */
var QuestionRelay = class {
	options;
	pending = /* @__PURE__ */ new Map();
	stopped = true;
	ws;
	reconnectTimer;
	backoffMs = 1e3;
	constructor(options) {
		this.options = options;
	}
	start() {
		this.stopped = false;
		this.connect();
	}
	stop() {
		this.stopped = true;
		if (this.reconnectTimer !== void 0) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = void 0;
		try {
			this.ws?.close(1e3);
		} catch {}
		this.ws = void 0;
	}
	/**
	* Attach to the host's mux WebSocket (the same `/api/events.mux` upgrade the
	* browser performs); pending questions replay on every (re)connect.
	*/
	connect() {
		if (this.stopped) return;
		const url = `${this.options.apiOrigin.replace(/^http/, "ws")}/api/events.mux`;
		let ws;
		try {
			ws = new WebSocket(url);
		} catch (error) {
			this.options.log("warn", `mux socket open failed: ${String(error)}`);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.addEventListener("open", () => {
			this.backoffMs = 1e3;
			this.options.log("info", "question relay attached to mux stream");
		});
		ws.addEventListener("message", (event) => {
			if (typeof event.data === "string") this.handleFrame(event.data);
		});
		ws.addEventListener("close", () => {
			if (this.ws !== ws) return;
			this.ws = void 0;
			if (this.stopped) return;
			this.scheduleReconnect();
		});
		ws.addEventListener("error", () => {});
	}
	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer !== void 0) return;
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, 3e4);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.connect();
		}, delay);
	}
	handleFrame(data) {
		let envelope;
		try {
			envelope = JSON.parse(data);
		} catch {
			return;
		}
		const payload = envelope.payload;
		if (payload?.type === "question/requested" && envelope.rpcId !== void 0) {
			const frame = payload;
			this.onRequested(envelope.rpcId, frame.sessionId, frame.questions);
		} else if (payload?.type === "question/resolved") {
			const frame = payload;
			this.onResolved(frame.questionRpcId, frame.outcome);
		}
	}
	async onRequested(rpcId, sessionId, questions) {
		if (this.pending.has(rpcId)) return;
		const channelId = this.options.channelForSession(sessionId);
		if (channelId === void 0) return;
		const relay = {
			rpcId,
			sessionId,
			channelId,
			questions,
			answers: /* @__PURE__ */ new Map(),
			messageIds: questions.map(() => void 0)
		};
		this.pending.set(rpcId, relay);
		try {
			for (const [index, item] of questions.entries()) {
				const message = await this.options.rest.createComponentMessage(channelId, formatQuestionContent(item, index, questions.length), buildComponents(rpcId, index, item));
				relay.messageIds[index] = message.id;
			}
		} catch (error) {
			this.options.log("warn", `question relay post failed: ${String(error)}`);
		}
	}
	async onResolved(rpcId, outcome) {
		const relay = this.pending.get(rpcId);
		if (relay === void 0) return;
		this.pending.delete(rpcId);
		const note = outcome === "answered" ? "✅ 已回答(可能来自 web 端)。" : "⏹️ 提问已取消。";
		for (const [index, messageId] of relay.messageIds.entries()) {
			if (messageId === void 0) continue;
			const item = relay.questions[index];
			if (item === void 0) continue;
			await this.options.rest.editMessage(relay.channelId, messageId, `${formatQuestionContent(item, index, relay.questions.length)}\n\n${note}`, []).catch(() => {});
		}
	}
	/**
	* Handle one component/modal interaction. Returns false when the custom id
	* is not ours, so the caller can route it elsewhere.
	*/
	async handleInteraction(interaction) {
		const customId = interaction.data?.custom_id;
		if (customId === void 0) return false;
		const parsed = parseCustomId(customId);
		if (parsed === void 0) return false;
		const relay = this.pending.get(parsed.rpcId);
		if (relay === void 0) {
			await this.options.rest.respondInteraction(interaction.id, interaction.token, {
				type: DISCORD.CALLBACK_UPDATE_MESSAGE,
				data: {
					content: "⌛ 这个提问已经结束(可能已在别处回答)。",
					components: []
				}
			}).catch(() => {});
			return true;
		}
		const item = relay.questions[parsed.index];
		if (item === void 0) return true;
		if (parsed.kind === "cancel") {
			await this.respondToHost(relay, void 0);
			await this.options.rest.respondInteraction(interaction.id, interaction.token, {
				type: DISCORD.CALLBACK_UPDATE_MESSAGE,
				data: {
					content: `~~${formatQuestionContent(item, parsed.index, relay.questions.length).split("\n")[0] ?? ""}~~\n⏹️ 已取消。`,
					components: []
				}
			});
			return true;
		}
		if (parsed.kind === "custom") {
			await this.options.rest.respondInteraction(interaction.id, interaction.token, {
				type: DISCORD.CALLBACK_MODAL,
				data: {
					custom_id: `qm:${parsed.rpcId}:${String(parsed.index)}`,
					title: truncate(item.question, 45),
					components: [{
						type: DISCORD.ACTION_ROW,
						components: [{
							type: DISCORD.TEXT_INPUT,
							custom_id: "answer",
							style: DISCORD.TEXT_INPUT_PARAGRAPH,
							label: truncate("你的回答", 45),
							required: true,
							max_length: 1500
						}]
					}]
				}
			});
			return true;
		}
		let answer;
		if (parsed.kind === "modal") {
			const value = (interaction.data?.components ?? [])[0]?.components?.[0]?.value ?? "";
			answer = {
				id: item.id,
				selected: [],
				custom: value
			};
		} else {
			const labels = (interaction.data?.values ?? []).map((value) => (item.options ?? [])[Number(value)]?.label).filter((label) => label !== void 0);
			answer = {
				id: item.id,
				selected: labels
			};
		}
		relay.answers.set(parsed.index, answer);
		const chosen = answer.custom !== void 0 ? `✏️ ${answer.custom}` : answer.selected.join("、");
		const remaining = relay.questions.length - relay.answers.size;
		const status = remaining > 0 ? `\n(还有 ${String(remaining)} 个问题待回答)` : "";
		await this.options.rest.respondInteraction(interaction.id, interaction.token, {
			type: DISCORD.CALLBACK_UPDATE_MESSAGE,
			data: {
				content: `${formatQuestionContent(item, parsed.index, relay.questions.length)}\n\n✅ 已选择: **${truncate(chosen, 300)}**${status}`,
				components: []
			}
		}).catch((error) => {
			this.options.log("warn", `interaction ack failed: ${String(error)}`);
		});
		if (relay.answers.size === relay.questions.length) await this.respondToHost(relay, [...relay.answers.entries()].sort(([a], [b]) => a - b).map(([, value]) => value));
		return true;
	}
	/** Settle the ask at the host: answers, or `undefined` to cancel it. */
	async respondToHost(relay, answers) {
		const body = {
			type: "client-response",
			rpcId: relay.rpcId,
			result: answers === void 0 ? {
				ok: false,
				error: {
					code: "cancelled",
					message: "cancelled from Discord",
					details: {}
				}
			} : {
				ok: true,
				value: {
					sessionId: relay.sessionId,
					answer: { answers }
				}
			}
		};
		try {
			const response = await fetch(`${this.options.apiOrigin}/api/respond`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const receipt = await response.json().catch(() => ({}));
			if (receipt.accepted !== true) {
				this.options.log("warn", `host rejected the answer: ${receipt.reason ?? String(response.status)}`);
				await this.options.rest.createMessage(relay.channelId, `⚠️ 答案未被接受(${receipt.reason ?? "unknown"}),可能已在 web 端处理。`).catch(() => {});
			}
		} catch (error) {
			this.options.log("warn", `respond failed: ${String(error)}`);
		}
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
/** Core services required before the bridge can start. webServer carries the notify/MCP surface. */
const inject = [
	"agents",
	"sessions",
	"agentDefaultModel",
	"webServer"
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
	maxUploadBytes: z.number().default(8e6),
	uploadRoots: z.array(z.string()).default([]),
	maxIncomingBytes: z.number().default(25e6),
	stateFile: z.string().default(""),
	typingIntervalMs: z.number().default(8e3),
	gatewayUrl: z.string().default(""),
	restBaseUrl: z.string().default(""),
	apiOrigin: z.string().default(""),
	notifyEnabled: z.boolean().default(true),
	notifySecret: z.string().default(""),
	notifySecretEnv: z.string().default("DSH_DISCORD_NOTIFY_SECRET")
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
/**
* Resolve the notify bearer secret: config, then environment, then a
* generated secret persisted next to the binding state (0600), so the
* surface is usable out of the box and local callers can read the file.
* @returns the secret and where it came from.
*/
async function resolveNotifySecret(config, stateFile) {
	if (config.notifySecret.trim() !== "") return {
		secret: config.notifySecret.trim(),
		source: "config"
	};
	const fromEnv = (process.env[config.notifySecretEnv] ?? "").trim();
	if (fromEnv !== "") return {
		secret: fromEnv,
		source: `env ${config.notifySecretEnv}`
	};
	const file = join(dirname(stateFile), "discord-notify.secret");
	try {
		const existing = (await readFile(file, "utf8")).trim();
		if (existing !== "") return {
			secret: existing,
			source: file
		};
	} catch {}
	const generated = randomBytes(24).toString("hex");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${generated}\n`, { mode: 384 });
	return {
		secret: generated,
		source: `${file} (generated)`
	};
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
		let relay;
		let disposeNotify;
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
			await ctx.get("loader")?.await?.();
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
					maxChunksPerReply: config.maxChunksPerReply,
					maxUploadBytes: config.maxUploadBytes,
					uploadRoots: config.uploadRoots,
					maxIncomingBytes: config.maxIncomingBytes
				},
				log: (level, text) => {
					logger[level](`discord-bridge: ${text}`);
				}
			});
			let botLabel = "bot";
			const webServer = ctx.get("webServer");
			if (config.notifyEnabled && webServer !== void 0) {
				const { secret, source } = await resolveNotifySecret(config, resolveStateFile(config.stateFile, ctx.baseUrl));
				const notifier = new DiscordNotifier(rest, config.allowedUsers[0], config.maxChunksPerReply);
				const port = webServer.port ?? 3080;
				const secretFile = join(dirname(resolveStateFile(config.stateFile, ctx.baseUrl)), "discord-notify.secret");
				const handler = createNotifyHandler(secret, {
					notifier,
					botLabel: () => botLabel,
					version: "0.5.1",
					httpEndpoint: `http://127.0.0.1:${String(port)}/plugins/discord/api/notify`,
					secretPath: source.startsWith("/") || source.includes("generated") ? secretFile : ""
				}, (level, text) => {
					logger[level](`discord-bridge: ${text}`);
				});
				disposeNotify = webServer.register({
					kind: "prefix",
					path: "/plugins/discord",
					handler
				});
				logger.info(`discord-bridge: notify API + MCP at /plugins/discord (secret: ${source})`);
			}
			let me;
			for (let delay = 5e3; !disposed; delay = Math.min(delay * 2, 6e4)) try {
				me = await rest.getMe();
				break;
			} catch (error) {
				logger.warn(`discord-bridge: identity check failed (${String(error)}); retrying in ${String(delay / 1e3)}s`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
			if (me === void 0 || disposed) {
				if (!disposed) logger.info("discord-bridge: boot abandoned (effect disposed mid-boot)");
				return;
			}
			botUserId = me.id;
			botLabel = me.username;
			logger.info(`discord-bridge: authenticated as ${me.username} (${me.id})`);
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
					const reply = await bridge.handle(command, message.channel_id, message.id, () => beginTypingFor(message.channel_id), message.attachments ?? []);
					for (const [index, chunk] of reply.chunks.entries()) try {
						await rest.createMessage(message.channel_id, chunk, index === 0 ? message.id : void 0);
					} catch (error) {
						logger.warn(`discord-bridge: send failed: ${String(error)}`);
						break;
					}
					if (reply.files.length > 0) try {
						await rest.createMessageWithFiles(message.channel_id, "", reply.files);
					} catch (error) {
						logger.warn(`discord-bridge: file upload failed: ${String(error)}`);
						await rest.createMessage(message.channel_id, "⚠️ 附件上传失败,文件仍在服务器上。").catch(() => {});
					}
				})().catch((error) => {
					logger.warn(`discord-bridge: message handling failed: ${String(error)}`);
				});
			};
			relay = new QuestionRelay({
				apiOrigin: config.apiOrigin !== "" ? config.apiOrigin : `http://127.0.0.1:${String(ctx.get("webServer")?.port ?? 3080)}`,
				rest,
				channelForSession: (sessionId) => {
					for (const [channel, session] of store.entries()) if (session === sessionId) return channel;
				},
				log: (level, text) => {
					logger[level](`discord-bridge: ${text}`);
				}
			});
			if (!disposed) relay.start();
			logger.info(`discord-bridge: question relay started (origin ${config.apiOrigin !== "" ? config.apiOrigin : "auto"})`);
			const questionRelay = relay;
			const onInteraction = (interaction) => {
				const author = interaction.member?.user ?? interaction.user;
				if (author === void 0) return;
				const channelId = interaction.channel_id ?? "";
				const admission = {
					...interaction.guild_id === void 0 ? {} : { guild_id: interaction.guild_id },
					channel_id: channelId,
					author
				};
				if (interaction.type === 3 || interaction.type === 5) {
					if (!isAllowed(admission, botUserId, config.allowedUsers, config.allowedChannels)) return;
					questionRelay.handleInteraction(interaction).catch((error) => {
						logger.warn(`discord-bridge: component interaction failed: ${String(error)}`);
					});
					return;
				}
				const commandName = interaction.data?.name;
				if (commandName === void 0) return;
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
					const reply = await bridge.handle(command, channelId, interaction.id, () => () => {});
					const appId = applicationId;
					if (appId === void 0) return;
					const [first, ...others] = reply.chunks;
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
			relay?.stop();
			disposeNotify?.();
			store.flush();
		};
	}, "discord bridge lifecycle");
}
//#endregion
export { Config, apply, inject, isAllowed, name, resolveNotifySecret, resolveStateFile, resolveToken };

//# sourceMappingURL=index.js.map