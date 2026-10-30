import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
/** Largest delay a Node timer accepts; inlined so this file needs no dsh-timeout package. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
* Report why the configured executable cannot be run, or undefined when it can.
*
* A host launched from a desktop shell inherits launchd's PATH rather than the
* one a login shell assembles, so an installed CLI is routinely unreachable
* under the bare name `codebuddy`. Discovery would otherwise report an empty
* catalog, which reads as "this route serves no models" instead of "the CLI is
* not installed or not on this process's PATH".
* @param command - configured executable, either a bare name or a path.
* @param env - extra environment entries the child receives over the seam's base.
* @returns an actionable diagnostic, or undefined when the executable resolves.
*/
function executableProblem(command, env) {
	const runs = (candidate) => {
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (command.length === 0) return "the configured command is empty";
	if (command.includes("/")) return runs(command) ? undefined : `${command} is missing or not executable`;
	const path = env.PATH ?? process.env.PATH ?? "";
	const searched = path.split(delimiter).filter((dir) => dir.length > 0);
	for (const dir of searched) if (runs(join(dir, command))) return undefined;
	return `${command} is not on this process's PATH (${searched.length === 0 ? "PATH is empty" : `${searched.length} directories searched`})`;
}
//#region lib/types/acp.js
/**
* ACP transport: one long-lived CLI child that carries every delegated run of a
* route, driven over the Agent Client Protocol (NDJSON on stdin and stdout).
*
* The print transport starts a child per model call, so every call pays the
* CLI's cold start and the answer can only be read from that one run. This
* transport starts the child once, handshakes, and maps each model call to a
* `session/prompt` on the session its conversation owns; the answer arrives as
* `session/update` notifications, which is also where the CLI's own thinking
* becomes visible instead of staying inside the child.
*
* The child is addressed by JSON-RPC framing: requests carry an id this module
* correlates, notifications carry a session id it routes, and a request the CLI
* raises for itself — a tool permission — is answered by the configured policy
* rather than left hanging, because an unanswered request stalls the turn.
*
* @module dsh-codebuddy-llm/acp
*/
/** Protocol revision this client speaks; the CLI answers with its own. */
const PROTOCOL_VERSION = 1;
/** A delegated turn that outlived the connection's deadline. */
var AcpTurnTimeoutError = class extends Error {
	/** @param timeoutMs - the deadline the turn exceeded. */
	constructor(timeoutMs) {
		super(`the delegated turn exceeded its ${String(timeoutMs)}ms deadline`);
		this.name = "AcpTurnTimeoutError";
	}
};
/** A buffered consumer of one turn's events. */
var TurnBuffer = class {
	events = [];
	waiter;
	ended = false;
	failure;
	/** Append one event and wake a waiting consumer. */
	push(event) {
		this.events.push(event);
		this.wake();
	}
	/** End the turn without an error. */
	end() {
		this.ended = true;
		this.wake();
	}
	/** End the turn with the failure the caller must not lose. */
	fail(error) {
		this.failure ??= error;
		this.ended = true;
		this.wake();
	}
	/** Wait for the next event, or undefined once the turn ended and drained. */
	async shift() {
		while (this.events.length === 0) {
			if (!this.ended) {
				await new Promise((resolve) => {
					this.waiter = resolve;
				});
				continue;
			}
			if (this.failure !== void 0) throw this.failure;
			return;
		}
		return this.events.shift();
	}
	wake() {
		const waiter = this.waiter;
		this.waiter = void 0;
		waiter?.();
	}
};
/** Narrow a parsed JSON value to a plain record. */
function asRecord$1(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	return value;
}
/** Parent-agent text and thoughts; delegated tool output is not its answer. */
function updateEventOf(update) {
	const kind = update.sessionUpdate;
	if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return void 0;
	const parentToolCallId = asRecord$1(update._meta)?.["codebuddy.ai/parentToolCallId"];
	if (typeof parentToolCallId === "string" && parentToolCallId.length > 0) return void 0;
	const text = asRecord$1(update.content)?.text;
	if (typeof text !== "string" || text.length === 0) return void 0;
	return kind === "agent_message_chunk" ? {
		kind: "text",
		text
	} : {
		kind: "thought",
		text
	};
}
/**
* Read the catalog one `session/new` response advertises. The CLI reports the
* ids it accepts and the input capacity behind each of them, which is the only
* capacity a route that owns no endpoint can obtain.
* @param result - the response's result, as the CLI sent it.
* @returns one entry per advertised id, in the CLI's own order.
*/
function catalogOf(result) {
	const available = asRecord$1(asRecord$1(result)?.models)?.availableModels;
	if (!Array.isArray(available)) return [];
	const catalog = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of available) {
		const record = asRecord$1(entry);
		const id = record?.modelId;
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		const name = record?.name;
		const capacity = asRecord$1(record?._meta)?.maxInputTokens;
		catalog.push({
			id,
			...typeof name === "string" && name.length > 0 ? { name } : {},
			...typeof capacity === "number" && Number.isInteger(capacity) && capacity > 0 ? { contextWindow: capacity } : {}
		});
	}
	return catalog;
}
/**
* Read how one `session/prompt` response ended the turn.
* @param result - the response's result, as the CLI sent it.
* @returns the stop reason and, when the CLI reported one, its failure detail.
*/
function promptOutcomeOf(result) {
	const record = asRecord$1(result);
	const stopReason = record?.stopReason;
	const detail = asRecord$1(record?._meta)?.["codebuddy.ai/errorMessage"];
	return {
		stopReason: typeof stopReason === "string" && stopReason.length > 0 ? stopReason : "unknown",
		...typeof detail === "string" && detail.length > 0 ? { detail } : {}
	};
}
/** The permission options one request offers, in the CLI's own order. */
function permissionOptionsOf(params) {
	const options = params.options;
	if (!Array.isArray(options)) return [];
	const parsed = [];
	for (const option of options) {
		const record = asRecord$1(option);
		if (record === void 0) continue;
		const id = record.optionId ?? record.id;
		if (typeof id !== "string" || id.length === 0) continue;
		parsed.push({
			id,
			kind: typeof record.kind === "string" ? record.kind : ""
		});
	}
	return parsed;
}
/**
* One route's long-lived ACP connection.
*
* A transport is started lazily on first use and lives until {@link dispose};
* sessions are created per harness conversation and reused across its calls,
* so a second call to the same conversation pays neither a cold start nor a
* handshake.
*/
var AcpTransport = class {
	options;
	child;
	starting;
	buffer = "";
	nextId = 1;
	disposed = false;
	pending = /* @__PURE__ */ new Map();
	turns = /* @__PURE__ */ new Map();
	sessions = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
	}
	/**
	* The ACP session one conversation is bound to, opened on first use.
	*
	* A conversation this child already serves keeps its session. Otherwise the
	* caller's `adopt` id — the session a previous child created for the same
	* conversation — is loaded through `session/load`, which is what keeps the
	* CLI's own history across a restarted harness or a replaced child. A failed
	* load (the CLI forgot it, or does not support loading) falls back to a fresh
	* session, and the returned lease says so, which is the caller's signal that
	* this call must carry the conversation itself.
	*
	* @param key - the harness conversation this session belongs to.
	* @param cwd - workspace the session runs in.
	* @param adopt - CLI session id a previous child created for this conversation.
	* @returns the session id and whether this child created it.
	*/
	async openSession(key, cwd, adopt) {
		const existing = this.sessions.get(key);
		if (existing !== void 0) return {
			sessionId: existing,
			created: false
		};
		await this.ensureStarted();
		if (adopt !== void 0 && await this.loadSession(cwd, adopt)) {
			this.sessions.set(key, adopt);
			return {
				sessionId: adopt,
				created: false
			};
		}
		const sessionId = asRecord$1(await this.request("session/new", {
			cwd,
			mcpServers: []
		}))?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("llm-cli: the CLI created no session for this conversation");
		this.sessions.set(key, sessionId);
		return {
			sessionId,
			created: true
		};
	}
	/**
	* Read the model catalog this CLI advertises, by opening the session whose
	* answer carries it. The connection is the caller's to dispose afterwards: a
	* discovery probe wants the catalog and nothing of the session's history.
	* @param cwd - workspace the probe session runs in.
	* @returns one entry per advertised model, with the capacity it discloses.
	*/
	async describeModels(cwd) {
		await this.ensureStarted();
		return catalogOf(await this.request("session/new", {
			cwd,
			mcpServers: []
		}));
	}
	/**
	* Ask the child to resume a session a previous child created.
	* @param cwd - workspace the session runs in.
	* @param sessionId - CLI session id to load.
	* @returns whether the child resumed it; a refusal is not this call's failure.
	*/
	async loadSession(cwd, sessionId) {
		try {
			await this.request("session/load", {
				sessionId,
				cwd,
				mcpServers: []
			});
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Run one model call as a prompt on the session that owns the conversation.
	* @param sessionId - the ACP session from {@link openSession}.
	* @param text - the prompt text this call carries.
	* @param signal - caller cancellation, forwarded as `session/cancel`.
	* @returns the answer's incremental events, and how the CLI ended the turn
	*   once they are drained — `cancelled` and `refusal` are outcomes, not errors.
	*/
	async *prompt(sessionId, text, signal) {
		await this.ensureStarted();
		if (signal?.aborted === true) throw new Error("llm-cli: the request was aborted before the turn started");
		const turn = new TurnBuffer();
		this.turns.set(sessionId, turn);
		const cancel = () => {
			this.notify("session/cancel", { sessionId });
		};
		signal?.addEventListener("abort", cancel, { once: true });
		const deadline = this.options.turnTimeoutMs;
		const expiry = deadline === void 0 || deadline <= 0 ? void 0 : setTimeout(() => {
			this.notify("session/cancel", { sessionId });
			turn.fail(new AcpTurnTimeoutError(deadline));
		}, deadline);
		expiry?.unref();
		let outcome;
		const response = this.request("session/prompt", {
			sessionId,
			prompt: [{
				type: "text",
				text
			}]
		}).then((result) => {
			outcome = promptOutcomeOf(result);
			turn.end();
		}).catch((error) => {
			turn.fail(error instanceof Error ? error : new Error(String(error)));
		});
		try {
			for (;;) {
				const event = await turn.shift();
				if (event === void 0) break;
				yield event;
			}
			await response;
			return outcome ?? { stopReason: "unknown" };
		} finally {
			if (expiry !== void 0) clearTimeout(expiry);
			signal?.removeEventListener("abort", cancel);
			if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
		}
	}
	/**
	* End the connection and the child behind it.
	* @returns once the child's process tree is gone.
	*/
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		const child = this.child;
		this.child = void 0;
		this.failAll(/* @__PURE__ */ new Error("llm-cli: the ACP connection was disposed"));
		if (child === void 0) return;
		child.terminate();
		await child.done.catch(() => void 0);
	}
	/** Start the child and handshake once; a second caller joins the first attempt. */
	async ensureStarted() {
		if (this.disposed) throw new Error("llm-cli: the ACP connection was disposed");
		this.starting ??= this.start();
		await this.starting;
	}
	async start() {
		const { argv, cwd, graceMs, env, spawn } = this.options;
		const child = spawn({
			argv: [...argv],
			cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit"
			},
			graceMs,
			env
		});
		this.child = child;
		const stdout = child.stdout;
		if (stdout === void 0) throw new Error("llm-cli: the ACP child has no stdout to read from");
		stdout.on("data", (data) => {
			this.buffer += data.toString("utf8");
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline === -1) break;
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.handleLine(line);
			}
		});
		child.done.then(() => {
			this.failAll(/* @__PURE__ */ new Error("llm-cli: the ACP child exited"));
		}, (error) => {
			this.failAll(error instanceof Error ? error : new Error(String(error)));
		});
		await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: {
				readTextFile: false,
				writeTextFile: false
			} }
		});
	}
	/** Route one parsed line: a response, a turn update, or a request to answer. */
	handleLine(line) {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return;
		}
		const message = asRecord$1(parsed);
		if (message === void 0) return;
		const id = message.id;
		if (typeof id === "number" && (message.result !== void 0 || message.error !== void 0)) {
			const pending = this.pending.get(id);
			if (pending === void 0) return;
			this.pending.delete(id);
			if (message.error !== void 0) {
				const detail = asRecord$1(message.error)?.message;
				pending.reject(new Error(typeof detail === "string" ? detail : "llm-cli: the CLI refused a request"));
				return;
			}
			pending.resolve(message.result);
			return;
		}
		const params = asRecord$1(message.params);
		if (message.method === "session/update" && params !== void 0) {
			const sessionId = params.sessionId;
			const update = asRecord$1(params.update);
			if (typeof sessionId !== "string" || update === void 0) return;
			const event = updateEventOf(update);
			if (event !== void 0) this.turns.get(sessionId)?.push(event);
			return;
		}
		if (typeof id === "number" && typeof message.method === "string") this.answerRequest(id, message.method, params ?? {});
	}
	/** Answer one request the CLI raised, so the turn it belongs to can continue. */
	answerRequest(id, method, params) {
		if (method === "session/request_permission") {
			const selected = this.options.selectPermission?.(permissionOptionsOf(params));
			this.write({
				jsonrpc: "2.0",
				id,
				result: selected === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: {
					outcome: "selected",
					optionId: selected
				} }
			});
			return;
		}
		this.write({
			jsonrpc: "2.0",
			id,
			error: {
				code: -32601,
				message: `unsupported request ${method}`
			}
		});
	}
	/** Send one request and await its response. */
	async request(method, params) {
		if (this.disposed) throw new Error("llm-cli: the ACP connection was disposed");
		const id = this.nextId;
		this.nextId += 1;
		const answered = new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject
			});
		});
		this.write({
			jsonrpc: "2.0",
			id,
			method,
			params
		});
		return answered;
	}
	/** Send one notification, which expects no answer. */
	notify(method, params) {
		if (this.disposed) return;
		this.write({
			jsonrpc: "2.0",
			method,
			params
		});
	}
	write(message) {
		this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
	}
	/** Fail every waiter: the child is gone, so no request can be answered. */
	failAll(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const turn of this.turns.values()) turn.fail(error);
		this.turns.clear();
	}
};
//#endregion
//#region lib/types/wire.js
/**
* Line-protocol parsing for a CLI child's stream-json output. CodeBuddy-style
* CLIs emit one JSON object per line; this parser owns line framing, the event
* vocabulary it understands, and the text-delta computation.
*
* Two line families carry answer text, and a run may produce either or both:
* `stream_event` frames wrap the model request's own SSE events when the child
* is asked for partial messages, so text arrives while it is still being
* generated; and the completed `assistant` frame repeats the whole message once
* the message ends. Both are measured against the text already observed *for
* the message in progress*, which is why `message_start` is reported rather
* than ignored — it is the only boundary a caller has for resetting that
* measurement. A frame adding nothing beyond the text already seen is ignored,
* so a run reading both families emits each character once.
*
* Unknown events are ignored: the event vocabulary is merge-extensible and this
* adapter only consumes what it maps.
*
* @module dsh-codebuddy-llm/wire
*/
/** Narrow a parsed JSON value to a plain record. */
function asRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	return value;
}
/** Parse one line as JSON; a non-JSON line is a diagnostic outside the protocol. */
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Extract the concatenated text from an assistant message content array. */
function messageText(record) {
	const message = asRecord(record.message);
	if (message === void 0) return void 0;
	const content = message.content;
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const block of content) {
		const item = asRecord(block);
		if (item !== void 0 && item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return parts.join("");
}
/** Extract a complete {@link TokenUsage} from a result event, when it carries one. */
function extractUsage(record) {
	const usage = asRecord(record.usage);
	if (usage === void 0) return void 0;
	const inputTokens = usage.input_tokens;
	const outputTokens = usage.output_tokens;
	if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return void 0;
	return {
		inputTokens,
		outputTokens
	};
}
/** Describe a failed result event, from its own detail or from its subtype. */
function failureOf(record, subtype) {
	return {
		message: typeof record.result === "string" && record.result.length > 0 ? record.result : subtype.length > 0 ? subtype : "unknown CLI failure",
		code: "CLI_RUN_FAILED"
	};
}
/** Read the terminal a result event reports. */
function terminalOf(record) {
	const subtype = typeof record.subtype === "string" ? record.subtype : "";
	if (record.is_error === true) return subtype.includes("max_turns") || subtype.includes("max-turns") ? { kind: "max-turns" } : {
		kind: "error",
		failure: failureOf(record, subtype)
	};
	const sessionId = typeof record.session_id === "string" && record.session_id.length > 0 ? record.session_id : void 0;
	const usage = extractUsage(record);
	return {
		kind: "stop",
		...sessionId === void 0 ? {} : { sessionId },
		...usage === void 0 ? {} : { usage }
	};
}
/**
* Read the SSE event a partial-message line wraps.
* @param record - the parsed stream-json line.
* @returns the wrapped event, or undefined when the line is not one.
*/
function streamEventOf(record) {
	if (record.type !== "stream_event") return void 0;
	return asRecord(record.event);
}
/**
* Read the text one SSE event contributes to the message being generated.
* @param event - the wrapped SSE event.
* @returns the incremental text, or undefined for any event that carries none.
*/
function partialTextOf(event) {
	if (event.type !== "content_block_delta") return void 0;
	const delta = asRecord(event.delta);
	if (delta === void 0 || delta.type !== "text_delta") return void 0;
	const text = delta.text;
	return typeof text === "string" && text.length > 0 ? text : void 0;
}
/**
* Parse one line of CLI stream-json output.
* @param line - one raw stdout line (already stripped of its newline).
* @param lastText - the text observed so far for the message in progress; a delta is measured against it.
* @returns the event this line contributes, or undefined when the line is blank.
*/
function parseCliLine(line, lastText) {
	const trimmed = line.trim();
	if (trimmed.length === 0) return void 0;
	const record = asRecord(parseJson(trimmed));
	if (record === void 0) return { kind: "ignored" };
	const streamEvent = streamEventOf(record);
	if (streamEvent !== void 0) {
		if (streamEvent.type === "message_start") return { kind: "message-start" };
		const text = partialTextOf(streamEvent);
		return text === void 0 ? { kind: "ignored" } : {
			kind: "text",
			delta: { text }
		};
	}
	if (record.type === "assistant") {
		const full = messageText(record);
		if (full === void 0 || full.length <= lastText.length) return { kind: "ignored" };
		return {
			kind: "text",
			delta: { text: full.slice(lastText.length) }
		};
	}
	if (record.type === "result") return {
		kind: "terminal",
		terminal: terminalOf(record)
	};
	return { kind: "ignored" };
}
//#endregion
//#region lib/types/translate.js
/**
* Message translation for the CLI adapter: turns harness conversation content
* into the prompt text one CLI child run consumes, and lifts the system prompt
* out of the history into the CLI's own system-prompt slot.
*
* The delegated CLI runs its own agentic loop with its own tools, so no harness
* tool vocabulary crosses the boundary; only human-authored user text and prior
* assistant answers do, and the CLI's own session (keyed by the harness session
* id) owns its tool history.
*
* @module dsh-codebuddy-llm/translate
*/
/**
* Flatten one message's text content into consecutive lines.
* @param message - the harness message to flatten.
* @returns its text blocks, in order.
*/
function textBlocksOf(message) {
	const texts = [];
	for (const block of message.content) if (block.type === "text") texts.push(block.text);
	return texts;
}
/**
* The rendered system prompt a request carries.
*
* Two request shapes reach an adapter, and they carry the prompt differently: a
* loop-built request passes its derived history, whose leading system-role
* message is the prompt, and leaves `GenerateOptions.system` undefined; a
* hand-built one-shot may fill that field instead. Reading both — preferring
* the explicit field — is what keeps the prompt from being silently dropped on
* either path. System blocks are concatenated without a separator, matching the
* projection `dsh-llm-deepseek` applies to the same history so both routes read
* one session alike.
* @param messages - ordered conversation messages.
* @param system - the request's explicit system slot, when it has one.
* @returns the system prompt text, or undefined when the request carries none.
*/
function systemTextOf(messages, system) {
	if (system !== void 0 && system.length > 0) return system;
	for (const message of messages) {
		if (message.role !== "system") continue;
		const text = textBlocksOf(message).join("");
		if (text.length > 0) return text;
	}
}
/**
* Render the conversation as role-prefixed lines, in order.
*
* Only human-visible conversation crosses: user text and prior assistant
* answers. System-role messages are excluded because {@link systemTextOf} owns
* the system prompt, and developer and tool-role content is excluded because
* the delegated CLI owns its tool loop — forwarding it would present harness
* tool scaffolding to a second agent as if it were conversation.
*
* @param messages - ordered conversation messages.
* @returns one part per text block, in conversation order.
*/
function conversationParts(messages) {
	const parts = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		for (const text of textBlocksOf(message)) {
			if (text.trim().length === 0) continue;
			parts.push({
				text: message.role === "assistant" ? `Assistant: ${text}` : `User: ${text}`,
				human: message.role === "user" && message.source?.kind === "user"
			});
		}
	}
	return parts;
}
/**
* Flatten the harness conversation into one prompt text for a stateless call.
*
* Plugin-injected user-role context is user-role conversation and therefore
* *is* forwarded here: a stateless call has no CLI-side history, so dropping it
* would hand the CLI a different conversation than the harness model would have
* seen. That is the opposite of {@link trailingUserText}, where the same
* injected text must not displace the human's newest input.
*
* @param messages - ordered conversation messages.
* @returns the complete prompt, or `undefined` when nothing text-worthy exists.
*/
function flattenConversation(messages) {
	const parts = conversationParts(messages);
	if (parts.length === 0) return void 0;
	return parts.map((part) => part.text).join("\n\n");
}
/**
* The conversation as it stood before the newest human input, for a delegated
* CLI that owns no history of it.
*
* The ACP transport keeps the CLI's own session alive, so an ongoing
* conversation normally never needs this. It is the fallback for the cases
* where that session is gone — a restarted harness, a replaced child, or a CLI
* that refused to resume one — and the CLI would otherwise answer the newest
* message knowing nothing that came before it.
*
* @param messages - ordered conversation messages.
* @returns the prior turns, or `undefined` when only the newest input exists.
*/
function conversationRecap(messages) {
	const parts = conversationParts(messages);
	const newest = parts.findLastIndex((part) => part.human);
	const recap = newest === -1 ? parts : parts.slice(0, newest);
	if (recap.length === 0) return void 0;
	return recap.map((part) => part.text).join("\n\n");
}
/**
* Extract the trailing human-authored user text of a conversation. A
* persistent session forwards only the newest human input, because the CLI
* already knows the history under the session id. Plugin context also uses the
* user role, so the message source — not the role alone — is what distinguishes
* the human's words from an injected context message that must not replace them.
* @param messages - ordered conversation messages.
* @returns the last human-authored user text, or `undefined` when none exists.
*/
function trailingUserText(messages) {
	let found;
	for (const message of messages) {
		if (message.role !== "user" || message.source?.kind !== "user") continue;
		const texts = textBlocksOf(message).filter((text) => text.trim().length > 0);
		if (texts.length > 0) found = texts.join("\n");
	}
	return found;
}
//#endregion
//#region lib/types/adapter.js
/**
* `CliAdapter`: the delegating LLM adapter that answers one model call by
* running one CLI child process and translating its stream-json output into
* harness `StreamChunk`s. The configured CLI (CodeBuddy by default) carries its
* own authentication and runs its own agentic loop with its own tools, so the
* harness forwards conversation text and receives the final answer: no API key,
* no harness-side tool loop, and no harness tool vocabulary on the wire.
*
* The adapter is transport-only. Executable facts arrive through a thunk
* resolved once per operation, and the registering plugin owns validation,
* defaults, and configuration — so a settings change reaches the next call
* without re-registering this route.
*
* @module dsh-codebuddy-llm/adapter
*/
/** The CLI permission modes its non-interactive print command accepts. */
const CODEBUDDY_PERMISSION_MODES = [
	"acceptEdits",
	"bypassPermissions",
	"default",
	"plan",
	"dontAsk",
	"auto"
];
/** The reasoning effort levels the CLI's own flag accepts. */
const CODEBUDDY_EFFORT_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** The ways this route can reach the CLI. */
const CLI_TRANSPORTS = ["print", "acp"];
/** Transport a deployment gets without asking for one. */
const DEFAULT_TRANSPORT = "print";
/** Failure code reported when the child cannot be started or breaks its protocol. */
const CLI_START_FAILED_CODE = "CLI_START_FAILED";
/** Failure code reported for a turn the CLI cancelled on its own. */
const CLI_TURN_CANCELLED_CODE = "CLI_TURN_CANCELLED";
/** Failure code reported for a turn the CLI refused to answer. */
const CLI_TURN_REFUSED_CODE = "CLI_TURN_REFUSED";
/** Failure code reported for a turn that ended for a reason this route cannot name. */
const CLI_TURN_UNKNOWN_CODE = "CLI_TURN_FAILED";
/** Failure code reported for a delegated turn that outlived its deadline. */
const CLI_TURN_TIMEOUT_CODE = "CLI_TURN_TIMEOUT";
/** Render one terminal failure chunk, classified as aborted when the signal fired. */
function failureChunk(message, code, signal) {
	return {
		type: "finish",
		reason: signal?.aborted === true ? {
			kind: "aborted",
			failure: {
				message,
				code
			}
		} : {
			kind: "error",
			failure: {
				message,
				code
			}
		}
	};
}
/**
* A single-consumer handoff between the stdout callbacks that produce chunks and
* the generator that yields them. Closing it ends consumption once drained, so
* a terminal event or a stream end settles the generator without the callbacks
* knowing about it.
*/
var ChunkQueue = class {
	items = [];
	waiter;
	closed = false;
	/** Append chunks and wake a waiting consumer. */
	push(...chunks) {
		this.items.push(...chunks);
		this.wake();
	}
	/** Close the queue; the consumer ends once every queued chunk is drained. */
	close() {
		this.closed = true;
		this.wake();
	}
	/** @returns the next queued chunk, or undefined once closed and drained. */
	async next() {
		while (this.items.length === 0) {
			if (this.closed) return void 0;
			await new Promise((resolve) => {
				this.waiter = resolve;
			});
		}
		return this.items.shift();
	}
	wake() {
		const waiter = this.waiter;
		this.waiter = void 0;
		waiter?.();
	}
};
/**
* Delegating CLI adapter: one provider route whose model ids name the CLI's own
* model selection. Its default transport spawns a child per call, hands it the
* prompt as its final positional argument, and consumes stream-json on stdout;
* the ACP transport keeps one child per route and prompts a session on it, so
* the CLI's cold start is paid once per route instead of once per call.
*/
var CliAdapter = class extends LlmAdapter {
	options;
	spawn;
	resolveSessionCwd;
	/**
	* The long-lived ACP connection of each workspace, replaced when what starts
	* its child changes. The CLI takes its workspace from the directory the child
	* starts in rather than from `session/new`, so a workspace needs its own child.
	*/
	acp = /* @__PURE__ */ new Map();
	/**
	* CLI sessions this route opened, by harness conversation. Held here rather
	* than in the transport because a replaced child must be able to resume them:
	* the id names a session in the CLI's own store, not in one child.
	*/
	acpSessions = /* @__PURE__ */ new Map();
	/** Numbers the throwaway sessions a stateless call gets. */
	statelessCalls = 0;
	constructor(options) {
		super();
		this.options = options.options;
		this.spawn = options.spawn;
		this.resolveSessionCwd = options.resolveSessionCwd ?? (() => void 0);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: provider
		};
	}
	listModels(provider) {
		return Promise.resolve(this.options().models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: ["text"]
		})));
	}
	resolveModel(provider, model) {
		const entry = this.options().models.find((candidate) => candidate.id === model);
		const contextWindow = entry?.contextWindow;
		return Promise.resolve({
			provider,
			id: model,
			name: entry?.name ?? model,
			...contextWindow === void 0 ? {} : { context: { contextWindow } }
		});
	}
	async *stream(options) {
		const facts = this.options();
		const signal = options.signal;
		if (signal?.aborted === true) {
			yield failureChunk("llm-cli: the request was aborted before the CLI child started", "ABORTED", signal);
			return;
		}
		const sessionId = options.sessionId;
		const prompt = sessionId === void 0 ? flattenConversation(options.messages) : trailingUserText(options.messages);
		if (prompt === void 0) {
			yield failureChunk("llm-cli: the request carries no text the CLI can consume", "INVALID_REQUEST");
			return;
		}
		const argv = [
			...facts.argv,
			"--permission-mode",
			facts.permissionMode,
			"--model",
			options.model
		];
		if (facts.tools !== void 0) argv.push("--tools", facts.tools);
		if (facts.maxTurns !== void 0) argv.push("--max-turns", String(facts.maxTurns));
		if (facts.effort !== void 0) argv.push("--effort", facts.effort);
		const system = systemTextOf(options.messages, options.system);
		if (system !== void 0) argv.push("--append-system-prompt", system);
		if (sessionId !== void 0 && facts.sessionIdArg !== void 0) argv.push(facts.sessionIdArg, sessionId);
		argv.push(prompt);
		const cwd = sessionId !== void 0 && facts.useSessionCwd ? this.resolveSessionCwd(sessionId) ?? facts.cwd : facts.cwd;
		if (facts.transport === "acp") {
			const recap = sessionId === void 0 ? void 0 : conversationRecap(options.messages);
			yield* this.streamAcp(facts, options, prompt, recap, cwd, signal);
			return;
		}
		let child;
		try {
			child = this.spawn({
				argv,
				cwd,
				stdio: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "inherit"
				},
				graceMs: facts.disposeGraceMs,
				env: facts.env,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			yield failureChunk(`llm-cli: the CLI child could not be started: ${error instanceof Error ? error.message : String(error)}`, CLI_START_FAILED_CODE, signal);
			return;
		}
		const stdout = child.stdout;
		if (stdout === void 0) {
			yield failureChunk("llm-cli: the CLI child has no stdout to read stream-json from", CLI_START_FAILED_CODE, signal);
			return;
		}
		const queue = new ChunkQueue();
		let buffer = "";
		let messageText = "";
		let lastText = "";
		let blockStarted = false;
		let settled = false;
		let pendingUsage;
		let finish;
		/**
		* Translate one stdout line into queued chunks and, at most once, a terminal.
		* @param line - one complete stdout line, newline removed.
		* @returns whether the line carried the run's terminal event.
		*/
		const acceptLine = (line) => {
			const event = parseCliLine(line, messageText);
			if (event === void 0 || event.kind === "ignored") return false;
			if (event.kind === "message-start") {
				messageText = "";
				return false;
			}
			if (event.kind === "text") {
				if (!blockStarted) {
					blockStarted = true;
					queue.push({
						type: "block-start",
						index: 0,
						blockType: "text"
					});
				}
				messageText += event.delta.text;
				lastText += event.delta.text;
				queue.push({
					type: "text-delta",
					index: 0,
					text: event.delta.text
				});
				return false;
			}
			const terminal = event.terminal;
			if (terminal.kind === "stop") {
				if (terminal.usage !== void 0) pendingUsage = {
					type: "usage",
					usage: terminal.usage
				};
				finish = {
					type: "finish",
					reason: { kind: "stop" }
				};
			} else if (terminal.kind === "max-turns") finish = {
				type: "finish",
				reason: { kind: "max-tokens" }
			};
			else finish = failureChunk(`llm-cli: ${terminal.failure.message}`, terminal.failure.code, signal);
			settled = true;
			queue.close();
			return true;
		};
		const onData = (data) => {
			if (settled) return;
			buffer += data.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (acceptLine(line)) break;
			}
		};
		const onEnd = () => {
			if (!settled) {
				if (buffer.trim().length > 0) acceptLine(buffer);
				settled = true;
			}
			queue.close();
		};
		const onError = (error) => {
			if (!settled) {
				settled = true;
				finish ??= failureChunk(`llm-cli: the CLI output stream failed: ${error.message}`, CLI_START_FAILED_CODE, signal);
			}
			queue.close();
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			finish = failureChunk("llm-cli: the CLI run was aborted", "ABORTED", signal);
			queue.close();
		};
		stdout.on("data", onData);
		stdout.on("end", onEnd);
		stdout.on("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			for (;;) {
				const chunk = await queue.next();
				if (chunk === void 0) break;
				yield chunk;
			}
			if (lastText.length > 0) yield {
				type: "block-end",
				index: 0,
				block: {
					type: "text",
					text: lastText
				}
			};
			if (pendingUsage !== void 0) yield pendingUsage;
			if (finish !== void 0) {
				yield finish;
				return;
			}
			const outcome = await child.done;
			yield failureChunk(`llm-cli: ${lastText.length > 0 ? `the CLI exited (${String(outcome.exitCode)}) without a result event after producing text` : `the CLI exited (${String(outcome.exitCode)}) without a result event`}`, CLI_START_FAILED_CODE);
		} finally {
			stdout.off("data", onData);
			stdout.off("end", onEnd);
			stdout.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
			child.terminate();
			await child.waitForExit().catch(() => {});
		}
	}
	/**
	* Answer one call through the route's long-lived ACP child. The session owns
	* the conversation, so only this call's text is sent — which is also why the
	* transport pays the CLI's cold start once per route instead of once per call.
	* @param facts - resolved executable facts for this operation.
	* @param options - the model call being answered.
	* @param prompt - the text this call carries.
	* @param recap - the conversation before this call's newest human text, sent
	*   instead of `prompt` when the CLI session is new and holds no history.
	* @param cwd - workspace the conversation's session runs in.
	* @param signal - caller cancellation, forwarded as a session cancel.
	* @returns the call's chunks, ending with its terminal.
	*/
	async *streamAcp(facts, options, prompt, recap, cwd, signal) {
		const transport = this.acpTransport(facts, options.model, cwd);
		this.statelessCalls += 1;
		const key = options.sessionId ?? `stateless:${String(this.statelessCalls)}`;
		let lease;
		try {
			lease = await transport.openSession(key, cwd, this.acpSessions.get(key));
		} catch (error) {
			yield failureChunk(`llm-cli: the CLI session could not be opened: ${error instanceof Error ? error.message : String(error)}`, CLI_START_FAILED_CODE, signal);
			return;
		}
		this.acpSessions.set(key, lease.sessionId);
		const promptText = lease.created && recap !== void 0 ? `${recap}\n\nUser: ${prompt}` : prompt;
		const session = lease.sessionId;
		let kind;
		let index = -1;
		let blockText = "";
		try {
			const events = transport.prompt(session, promptText, signal);
			let step = await events.next();
			while (!step.done) {
				const event = step.value;
				if (kind !== event.kind) {
					if (kind !== void 0) yield {
						type: "block-end",
						index,
						block: answerBlock(kind, blockText)
					};
					kind = event.kind;
					blockText = "";
					index += 1;
					yield {
						type: "block-start",
						index,
						blockType: blockTypeOf(kind)
					};
				}
				blockText += event.text;
				if (event.kind === "text") yield {
					type: "text-delta",
					index,
					text: event.text
				};
				else yield {
					type: "reasoning-delta",
					index,
					text: event.text
				};
				step = await events.next();
			}
			if (kind !== void 0) yield {
				type: "block-end",
				index,
				block: answerBlock(kind, blockText)
			};
			yield finishOfAcpOutcome(step.value, signal);
		} catch (error) {
			if (signal?.aborted === true) {
				yield failureChunk("llm-cli: the CLI run was aborted", "ABORTED", signal);
				return;
			}
			if (error instanceof AcpTurnTimeoutError) {
				yield failureChunk(`llm-cli: ${error.message}`, CLI_TURN_TIMEOUT_CODE, signal);
				return;
			}
			yield failureChunk(`llm-cli: ${error instanceof Error ? error.message : String(error)}`, CLI_START_FAILED_CODE, signal);
		}
	}
	/**
	* Release the route's long-lived children, if any were ever started. The
	* plugin calls this from the effect that registered the route, so unloading
	* the route unloads its children rather than leaving them to outlive the
	* composition.
	* @returns once every child's process tree is gone.
	*/
	async dispose() {
		const transports = [...this.acp.values()].map((entry) => entry.transport);
		this.acp.clear();
		await Promise.all(transports.map((transport) => transport.dispose()));
	}
	/**
	* The ACP connection one workspace runs on, started on first use and replaced
	* when the facts that started it change. The model and the workspace ride the
	* process: the CLI takes both as launch facts, so one child serves one model
	* in one workspace.
	* @param facts - resolved executable facts for this operation.
	* @param model - model id this call selected.
	* @param cwd - workspace the conversation's session runs in.
	* @returns the connection to prompt on.
	*/
	acpTransport(facts, model, cwd) {
		const argv = [
			...facts.acpArgv,
			"--permission-mode",
			facts.permissionMode,
			...facts.tools === void 0 ? [] : ["--tools", facts.tools],
			...facts.maxTurns === void 0 ? [] : ["--max-turns", String(facts.maxTurns)],
			...facts.effort === void 0 ? [] : ["--effort", facts.effort],
			"--model",
			model
		];
		const signature = JSON.stringify([
			argv,
			facts.env,
			facts.disposeGraceMs
		]);
		const existing = this.acp.get(cwd);
		if (existing?.signature === signature) return existing.transport;
		const selectPermission = selectPermissionFor(facts.permissionMode);
		const transport = new AcpTransport({
			spawn: this.spawn,
			argv,
			cwd,
			env: facts.env,
			graceMs: facts.disposeGraceMs,
			...facts.turnTimeoutMs <= 0 ? {} : { turnTimeoutMs: facts.turnTimeoutMs },
			...selectPermission === void 0 ? {} : { selectPermission }
		});
		this.acp.set(cwd, {
			signature,
			transport
		});
		existing?.transport.dispose().catch(() => void 0);
		return transport;
	}
};
/**
* The terminal this route reports for how the CLI ended one delegated turn. The
* stop reason is the only thing that separates a turn the CLI abandoned from a
* short reply, so every reason but a completed turn is reported as a failure.
* @param outcome - stop reason the CLI reported for the turn.
* @param signal - caller cancellation, which outranks the CLI's own reason.
* @returns the terminal chunk for the call.
*/
function finishOfAcpOutcome(outcome, signal) {
	const detail = outcome.detail === void 0 ? "" : ` (${outcome.detail})`;
	switch (outcome.stopReason) {
		case "end_turn": return {
			type: "finish",
			reason: { kind: "stop" }
		};
		case "max_tokens":
		case "max_turn_requests":
		case "max_turns": return {
			type: "finish",
			reason: { kind: "max-tokens" }
		};
		case "cancelled": return failureChunk(`llm-cli: the CLI cancelled the turn${detail}`, CLI_TURN_CANCELLED_CODE, signal);
		case "refusal": return failureChunk(`llm-cli: the CLI refused the turn${detail}`, CLI_TURN_REFUSED_CODE, signal);
		default: return failureChunk(`llm-cli: the CLI ended the turn with stop reason "${outcome.stopReason}"${detail}`, CLI_TURN_UNKNOWN_CODE, signal);
	}
}
/** The block kind one ACP stream reports as, in this seam's vocabulary. */
function blockTypeOf(kind) {
	return kind === "text" ? "text" : "reasoning";
}
/** The finished block one partial stream leaves behind. */
function answerBlock(kind, text) {
	return kind === "text" ? {
		type: "text",
		text
	} : {
		type: "reasoning",
		text
	};
}
/**
* The policy a permission request is answered with. A mode that already lets the
* CLI run its tools unattended answers with the same intent the CLI's own flag
* means; every other mode refuses, because approving there would override a
* policy the deployment chose deliberately.
* @param mode - the route's permission policy.
* @returns the selector, or undefined to refuse every request.
*/
function selectPermissionFor(mode) {
	return mode === "bypassPermissions" || mode === "acceptEdits" || mode === "auto" || mode === "dontAsk" ? (options) => options.find((option) => option.kind === "allow_always")?.id ?? options.find((option) => option.kind.startsWith("allow"))?.id : void 0;
}
//#endregion
//#region lib/types/config.js
/**
* Plugin configuration and the one resolve step from raw config to validated
* executable facts.
*
* Every field is `Volatile`, so a Models-page edit reaches the next request
* through the loader's volatile update without restarting anything. The resolve
* step re-judges every default and bound because programmatic construction and
* a settings snapshot both bypass Schemastery normalization.
*
* @module dsh-codebuddy-llm/config
*/
/** The default CLI executable; a bare name resolves on PATH. */
const DEFAULT_COMMAND = "codebuddy";
/**
* Base arguments producing stream-json on stdout with a trailing positional
* prompt. Partial messages are requested too: without them the CLI reports a
* message only once it is complete, so a caller waits out the child's whole
* agent loop — tool rounds included — before the first character arrives.
*/
const DEFAULT_ARGS = [
	"--print",
	"--output-format",
	"stream-json",
	"--include-partial-messages"
];
/** The argument that carries the persistent session id. */
const DEFAULT_SESSION_ID_ARG = "--session-id";
/** Permission mode that makes a delegated, non-interactive CLI run usable by default. */
const DEFAULT_PERMISSION_MODE = "bypassPermissions";
/** Default graceful-termination window for a CLI child. */
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
/** Arguments that start the CLI as a long-lived ACP agent on stdio. */
const DEFAULT_ACP_ARGS = ["--acp"];
/** Arguments that print the CLI's supported model ids without starting an agent session. */
const DEFAULT_MODEL_DISCOVERY_ARGS = ["--help"];
/** Default ceiling for one model-discovery child. */
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15e3;
/**
* Default ceiling for one delegated `acp` turn. A turn is the CLI's whole agent
* loop, not one model round, so the bound is generous; it exists to end a run
* that never converges rather than to pace an ordinary one.
*/
const DEFAULT_TURN_TIMEOUT_MS = 6e5;
/**
* Read the current value behind every reference of a parsed {@link Config}.
* Every schema field is volatile, so each entry is a reference by construction.
* @param config - parsed plugin config.
* @returns one detached value per option.
*/
function plainOptions(config) {
	const plain = {};
	for (const key of Object.keys(config)) plain[key] = config[key].get();
	return plain;
}
/** Advisory catalog entry as it appears in yml. */
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	contextWindow: z.natural().min(1)
});
/** Fields shared by the plugin entry config and the `llm-cli` settings section. */
const cliConfigFields = {
	command: z.string().default(DEFAULT_COMMAND).volatile(),
	args: z.array(z.string()).default([...DEFAULT_ARGS]).volatile(),
	acpArgs: z.array(z.string()).default([...DEFAULT_ACP_ARGS]).volatile(),
	modelDiscoveryArgs: z.array(z.string()).default([...DEFAULT_MODEL_DISCOVERY_ARGS]).volatile(),
	modelDiscoveryTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS).volatile(),
	turnTimeoutMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TURN_TIMEOUT_MS).volatile(),
	models: z.array(catalogModel).default([]).volatile(),
	cwd: z.string().volatile(),
	env: z.dict(z.string()).default({}).volatile(),
	sessionIdArg: z.string().default(DEFAULT_SESSION_ID_ARG).volatile(),
	transport: z.union(CLI_TRANSPORTS).default(DEFAULT_TRANSPORT).volatile(),
	permissionMode: z.union(CODEBUDDY_PERMISSION_MODES).default(DEFAULT_PERMISSION_MODE).volatile(),
	tools: z.string().volatile(),
	maxTurns: z.natural().min(1).volatile(),
	effort: z.union(CODEBUDDY_EFFORT_LEVELS).volatile(),
	disposeGraceMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_DISPOSE_GRACE_MS).volatile()
};
const Config = z.object(cliConfigFields);
/**
* Validate a millisecond bound that must be a positive finite number inside the
* timer ceiling, which is what both the spawn grace and the discovery deadline
* are handed to.
* @param value - the resolved bound.
* @param field - option name used in the diagnostic.
* @returns the same value once it is accepted.
*/
function timerBound(value, field) {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`llm-cli: ${field} must be a positive finite number no greater than ${String(MAX_TIMER_DELAY_MS)}`);
	return value;
}
/** Reject a blank argument list entry, which would silently shift the prompt. */
function assertNoBlankArg(args, field) {
	if (args.some((arg) => arg.length === 0)) throw new Error(`llm-cli: ${field} must not contain an empty argument`);
}
/** Validate and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? []).map((model) => {
		if (model.id.length === 0) throw new Error("llm-cli: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-cli: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-cli: catalog model "${model.id}" contextWindow must be a positive whole number`);
		if (seen.has(model.id)) throw new Error(`llm-cli: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }
		};
	});
}
/**
* Merge what the CLI last advertised with the ids the deployment declared. The
* advertised order leads — it is the CLI's own listing, which is what a picker
* should show — and a declared entry keeps the fields it declares there, so a
* curated label is not replaced by the bare id, while everything it leaves out
* still comes from the CLI. Declared ids the CLI did not report follow, so an
* advisory id stays selectable.
* @param configured - catalog entries the deployment declared.
* @param discovered - entries the last probe of the CLI reported.
* @returns one entry per id, advertised order first.
*/
function mergeCatalog(configured, discovered) {
	const declared = new Map(configured.map((model) => [model.id, model]));
	const seen = /* @__PURE__ */ new Set();
	const merged = [];
	for (const model of [...discovered, ...configured]) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		const declaredEntry = declared.get(model.id);
		const name = declaredEntry?.name ?? model.name;
		const contextWindow = declaredEntry?.contextWindow ?? model.contextWindow;
		merged.push({
			id: model.id,
			...name === void 0 ? {} : { name },
			...contextWindow === void 0 ? {} : { contextWindow }
		});
	}
	return merged;
}
/**
* The one explicit resolve step from raw config to validated executable facts.
* @param config - raw plugin config or a resolved settings snapshot.
* @param defaultCwd - fallback working directory for the CLI child.
* @returns validated executable facts for the adapter.
*/
function resolveAdapterOptions(config, defaultCwd) {
	const command = config.command ?? "codebuddy";
	if (command.trim().length === 0) throw new Error("llm-cli: command must be non-empty");
	const args = config.args ?? DEFAULT_ARGS;
	assertNoBlankArg(args, "args");
	const transport = config.transport ?? "print";
	if (!CLI_TRANSPORTS.includes(transport)) throw new Error(`llm-cli: unsupported transport "${transport}"`);
	const permissionMode = config.permissionMode ?? "bypassPermissions";
	if (!CODEBUDDY_PERMISSION_MODES.includes(permissionMode)) throw new Error(`llm-cli: unsupported permissionMode "${permissionMode}"`);
	const disposeGraceMs = timerBound(config.disposeGraceMs ?? 3e3, "disposeGraceMs");
	const acpArgs = config.acpArgs ?? DEFAULT_ACP_ARGS;
	assertNoBlankArg(acpArgs, "acpArgs");
	const discoveryArgs = config.modelDiscoveryArgs ?? DEFAULT_MODEL_DISCOVERY_ARGS;
	assertNoBlankArg(discoveryArgs, "modelDiscoveryArgs");
	const discoveryTimeoutMs = timerBound(config.modelDiscoveryTimeoutMs ?? 15e3, "modelDiscoveryTimeoutMs");
	const turnTimeoutMs = config.turnTimeoutMs ?? 6e5;
	if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs < 0 || turnTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-cli: turnTimeoutMs must be 0 or a positive finite number no greater than ${String(MAX_TIMER_DELAY_MS)}`);
	const sessionIdArg = config.sessionIdArg ?? "--session-id";
	const maxTurns = config.maxTurns;
	if (maxTurns !== void 0 && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new Error("llm-cli: maxTurns must be a positive whole number");
	const effort = config.effort;
	if (effort !== void 0 && !CODEBUDDY_EFFORT_LEVELS.includes(effort)) throw new Error(`llm-cli: unsupported effort "${effort}"`);
	return {
		argv: [command, ...args],
		cwd: config.cwd ?? defaultCwd,
		useSessionCwd: config.cwd === void 0,
		env: { ...config.env ?? {} },
		...sessionIdArg.length === 0 ? {} : { sessionIdArg },
		transport,
		permissionMode,
		...config.tools === void 0 ? {} : { tools: config.tools },
		...maxTurns === void 0 ? {} : { maxTurns },
		...effort === void 0 ? {} : { effort },
		disposeGraceMs,
		turnTimeoutMs,
		acpArgv: [command, ...acpArgs],
		discoveryArgv: [command, ...discoveryArgs],
		discoveryTimeoutMs,
		models: resolveModels(config.models)
	};
}
//#endregion
//#region lib/types/discovery.js
/**
* Host-side CLI model discovery. It runs the configured CLI's own listing
* command (default `--help`) through the shared subprocess seam and parses the
* model ids the CLI reports, so the standard Models page can offer the CLI's
* real catalog without this package owning a remote surface of its own.
*
* Every child here goes through the seam, so discovery inherits process-tree
* termination and environment scrubbing instead of managing a child itself.
*
* @module dsh-codebuddy-llm/discovery
*/
/** In-memory stdout cap for one discovery child; a larger listing is not a model catalog. */
const DISCOVERY_OUTPUT_MAX_BYTES = 1024 * 1024;
/**
* Parse the model ids a CodeBuddy-style CLI lists for its `--model` option.
* @param help - the CLI's own help output.
* @returns the unique ids in the CLI's reported order, without display names.
*/
function parseCodeBuddyModels(help) {
	const listing = /--model <model>[\s\S]*?Currently supported:\s*\(([^)]*)\)/.exec(help)?.[1];
	if (listing === void 0) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const value of listing.split(",")) {
		const id = value.trim();
		if (id.length > 0) ids.add(id);
	}
	return [...ids].map((id) => ({ id }));
}
/** Run the listing child to completion and return its stdout, or undefined when it did not report. */
async function captureListing(request) {
	if (request.signal?.aborted === true) return void 0;
	const controller = new AbortController();
	const abort = () => {
		controller.abort();
	};
	const timer = setTimeout(abort, request.timeoutMs);
	timer.unref();
	request.signal?.addEventListener("abort", abort, { once: true });
	try {
		const handle = request.spawn({
			argv: request.argv,
			cwd: request.cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: DISCOVERY_OUTPUT_MAX_BYTES },
				stderr: "inherit"
			},
			graceMs: request.timeoutMs,
			signal: controller.signal
		});
		if ((await handle.done).exitCode !== 0) return void 0;
		return handle.collected.stdout?.readFrom(0).text;
	} catch {
		return;
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", abort);
	}
}
/**
* Interrogate an ACP route for the catalog its handshake reports.
* @param request - the route's ACP connection, its bounds, and the seam's spawn.
* @returns the advertised models, or undefined when the CLI never answered.
*/
async function discoverAcpModels(request) {
	const acp = request.acp;
	if (acp === void 0) return void 0;
	if (request.signal?.aborted === true) return void 0;
	const transport = new AcpTransport({
		spawn: request.spawn,
		argv: acp.argv,
		cwd: request.cwd,
		env: acp.env,
		graceMs: acp.graceMs
	});
	const abort = () => {
		transport.dispose();
	};
	const timer = setTimeout(abort, request.timeoutMs);
	timer.unref();
	request.signal?.addEventListener("abort", abort, { once: true });
	try {
		return await transport.describeModels(request.cwd);
	} catch {
		return;
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", abort);
		await transport.dispose();
	}
}
/**
* Discover the models the configured CLI advertises.
* @param request - the listing invocation, its bounds, and the route's own catalog.
* @returns the discovered models first, then configured ids the CLI did not report.
*/
async function discoverCliModels(request) {
	const advertised = request.acp === void 0 ? void 0 : await discoverAcpModels(request);
	const help = advertised === void 0 || advertised.length === 0 ? await captureListing(request) : void 0;
	let discovered;
	if (advertised !== void 0 && advertised.length > 0) discovered = [...advertised];
	else if (help === void 0) throw new Error(`the discovery command \`${request.argv.join(" ")}\` reported nothing within ${String(request.timeoutMs)}ms (non-zero exit, timeout, or cancellation)`);
	else {
		discovered = parseCodeBuddyModels(help);
		// Help text without the model listing means this CLI's ids cannot be read,
		// which is a different fault from a route that serves none: reporting it
		// keeps a shape change from passing as an empty catalog.
		if (discovered.length === 0) throw new Error(`\`${request.argv.join(" ")}\` listed no supported models; the CLI's --model help text is not in the expected shape`);
	}
	const seen = new Set(discovered.map((model) => model.id));
	const models = [...discovered];
	for (const model of request.configured) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push({
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }
		});
	}
	return models;
}
//#endregion
//#region lib/types/index.js
/**
* `llm-cli`: a provider route answered by a CLI child instead of a provider HTTP
* endpoint.
*
* The route exists so a deployment can run the harness with no API key at all:
* the configured CLI (CodeBuddy by default) carries its own authentication and
* runs its own agentic loop with its own tools. The harness forwards
* conversation text and receives the final answer, so a model swap is a
* configuration change rather than a harness change.
*
* The plugin depends on exactly two seams — `llm` (the adapter registry) and
* `subprocess` (child lifecycle) — and reaches the session store, when a
* deployment has one, through an untyped service lookup. Nothing here requires
* `dsh-session`, a remote surface, or a client package, so mounting it changes
* no shared package.
*
* ```yaml
* - id: llm-cli
*   name: 'dsh-codebuddy-llm'
*   config:
*     command: codebuddy
*     args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
*     permissionMode: bypassPermissions
* ```
*
* @module dsh-codebuddy-llm
*/
const name = "llm-cli";
const inject = ["llm", "subprocess"];
/** The single provider route this plugin owns; a registration-time fact. */
const PROVIDER = "codebuddy-cli";
/** Human-readable provider name for selectors. */
const DISPLAY_NAME = "CodeBuddy CLI";
/** Register the CLI route, its settings section, and its model discovery. */
function apply(ctx, config) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	const settingsNs = ctx.fiber.entry?.options.id ?? "llm-cli";
	/**
	* Model entries the CLI last advertised. The picker reads this route's
	* catalog through `listModels`, so the CLI's own listing has to reach the
	* resolved facts; discovery is best-effort, and an unreachable CLI leaves the
	* configured catalog standing alone.
	*/
	let advertised = [];
	/**
	* Executable facts for the current configuration, re-resolved per operation
	* so a settings edit reaches the very next request without re-registering the
	* route. Nothing about this route is captured at registration time — the
	* provider id, its display name, and the settings namespace are all create-once
	* facts — so a volatile update needs no reload hook of its own: the loader
	* commits a snapshot only after {@link apply}'s `internal/config` listener has
	* accepted it, which is why a resolve here can no longer fail.
	*/
	const options = () => {
		const current = plainOptions(config);
		return resolveAdapterOptions({
			...current,
			models: mergeCatalog(current.models ?? [], advertised)
		}, process.cwd());
	};
	options();
	/**
	* Probe the CLI for the models it advertises and remember them for this
	* route, so a picker offers the CLI's real ids instead of an empty list.
	* @param signal - caller cancellation, honored beside the discovery bound.
	* @returns the advertised ids, declared entries the CLI did not report last.
	*/
	const probeCatalog = async (signal) => {
		const current = plainOptions(config);
		const facts = resolveAdapterOptions(current, process.cwd());
		// A missing CLI is a deployment fault, not an empty catalog: throwing here
		// reaches the Models page as a refusal carrying this text, while the load
		// probe logs it, so neither surface shows a silent zero-model route.
		const problem = executableProblem(facts.argv[0], facts.env);
		if (problem !== void 0) throw new Error(`CodeBuddy CLI is unavailable: ${problem}. Install the CodeBuddy CLI, or point \`command\` in this plugin's \`llm-cli\` config at its absolute path.`);
		const models = await discoverCliModels({
			argv: facts.discoveryArgv,
			cwd: facts.cwd,
			timeoutMs: facts.discoveryTimeoutMs,
			configured: current.models ?? [],
			spawn: (spec) => ctx.subprocess.spawn(spec),
			...facts.transport === "acp" ? { acp: {
				argv: facts.acpArgv,
				env: facts.env,
				graceMs: facts.disposeGraceMs
			} } : {},
			...signal === void 0 ? {} : { signal }
		});
		advertised = models.map((model) => ({
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }
		}));
		return models;
	};
	probeCatalog().catch((error) => {
		ctx.logger.warn("llm-cli: model discovery failed: %s", error instanceof Error ? error.message : String(error));
	});
	ctx.on("internal/config", function(_raw, next) {
		const raw = next();
		if (this !== ctx.fiber) return raw;
		resolveAdapterOptions(plainOptions(Config(raw)), process.cwd());
		return raw;
	});
	const adapter = new CliAdapter({
		options,
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveSessionCwd: (sessionId) => ctx.get("sessions")?.get(sessionId)?.header.cwd
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: DISPLAY_NAME,
		settingsNs,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
	ctx.effect(() => () => adapter.dispose());
	ctx.llm.registerModelDiscovery(settingsNs, (_request, signal) => probeCatalog(signal));
}
//#endregion
export { AcpTransport, CLI_TRANSPORTS, CODEBUDDY_EFFORT_LEVELS, CODEBUDDY_PERMISSION_MODES, CliAdapter, Config, DEFAULT_ARGS, DEFAULT_COMMAND, DEFAULT_DISPOSE_GRACE_MS, DEFAULT_MODEL_DISCOVERY_ARGS, DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS, DEFAULT_PERMISSION_MODE, DEFAULT_SESSION_ID_ARG, DEFAULT_TRANSPORT, apply, conversationRecap, discoverCliModels, flattenConversation, inject, name, parseCliLine, parseCodeBuddyModels, plainOptions, resolveAdapterOptions, systemTextOf, textBlocksOf, trailingUserText };
