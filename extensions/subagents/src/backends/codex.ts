/**
 * Codex backend — real implementation over `codex app-server`.
 *
 * One scoped app-server process owns one persistent Codex thread. The server
 * speaks LF-delimited JSON-RPC over stdio: initialize, thread/start, and
 * turn/start drive runs; v2 item notifications are translated into normalized
 * SubagentEvents. send() queues a follow-up turn while busy, and interrupt uses
 * turn/interrupt with a local deadline so a missing server acknowledgement can
 * never leave the manager stuck in "running".
 */

import { spawn } from 'node:child_process';
import type { Cause, Scope } from 'effect';
import { Effect, Queue, Stream } from 'effect';
import type { SubagentBackend, SubagentSession } from '@subagents/src/backend.ts';
import { SendError, SpawnError } from '@subagents/src/domain.ts';
import { CodexBinaryResolver, CodexProcessTree } from '@subagents/src/backends/codex/index.ts';
import { CodexProtocol, type JsonRecord } from '@subagents/src/backends/codex/protocol.ts';

import type { RunOutcome, SpawnTask, SubagentEvent, SubagentMeta, TranscriptPart } from '@subagents/src/domain.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const INTERRUPT_FALLBACK_MS = 1_500;
/** A protocol line larger than this without a newline means a broken peer. */
const STDOUT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

interface PendingRequest {
	readonly resolve: (result: JsonRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ToolState {
	readonly name: string;
	output: string;
}

export function codexSandboxOptions(trusted: boolean) {
	return CodexProtocol.sandboxOptions(trusted);
}

export function parseThreadTokenUsage(params: unknown) {
	return CodexProtocol.threadTokenUsage(params);
}

// --- The session -------------------------------------------------------------

const codexBinary = new CodexBinaryResolver();
const processTree = new CodexProcessTree();

const makeCodexSession = (task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
	Effect.gen(function* () {
		const binary = codexBinary.resolve();

		if (!binary) {
			return yield* new SpawnError({
				message: 'codex executable was not found on PATH.',
			});
		}

		const events = yield* Queue.make<SubagentEvent, Cause.Done>();

		const emit = (event: SubagentEvent) => {
			Queue.offerUnsafe(events, event);
		};

		const child = yield* Effect.try({
			try: () =>
				spawn(binary, ['app-server', '--stdio'], {
					cwd: task.cwd,
					env: process.env,
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true,
					// Own process group on POSIX so teardown can signal the whole
					// tree: a wedged app-server must not orphan a still-running
					// shell command it spawned.
					detached: process.platform !== 'win32',
				}),
			catch: (error) => new SpawnError({ message: CodexProtocol.boundedError(error) }),
		});

		const state = {
			closed: false,
			closing: false,
			exited: false,
			activeRun: false,
			dispatching: false,
			interruptRequested: false,
			effort: CodexProtocol.preferredEffort(task.reasoningEffort),
			runSerial: 0,
			activeTurnId: undefined as string | undefined,
			runError: undefined as string | undefined,
			finalText: '',
			lastAssistantText: '',
			pendingPrompts: [] as string[],
			nextRequestId: 0,
			stderr: '',
			meta: {
				backend: 'codex',
				modelLabel: task.model,
			} satisfies SubagentMeta as SubagentMeta,
			interruptTimer: undefined as ReturnType<typeof setTimeout> | undefined,
		};

		const pendingRequests = new Map<number, PendingRequest>();
		const tools = new Map<string, ToolState>();
		const ignoredTurnIds = new Set<string>();

		const writeMessage = (message: JsonRecord) => {
			if (state.closed || !child.stdin.writable) {
				return false;
			}

			// `writable` is a check-then-act: the app-server can die between the
			// guard above and the write below, and an EPIPE then surfaces either as
			// a throw here or as an 'error' event on the stream (handled further
			// down). Neither may escape as an uncaught exception.
			try {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			} catch (error) {
				failForProcessExit(`Codex app-server stdin failed: ${CodexProtocol.boundedError(error)}`);

				return false;
			}

			return true;
		};

		const request = (method: string, params: JsonRecord, timeoutMs = REQUEST_TIMEOUT_MS) =>
			new Promise<JsonRecord>((resolve, reject) => {
				if (state.closed) {
					reject(new Error('Codex app-server is closed.'));

					return;
				}

				const id = ++state.nextRequestId;

				const timer = setTimeout(() => {
					pendingRequests.delete(id);
					reject(new Error(`Codex app-server request ${method} timed out.`));
				}, timeoutMs);

				pendingRequests.set(id, { resolve, reject, timer });
				if (!writeMessage(
					{ id, method, params },
				)) {
					clearTimeout(timer);
					pendingRequests.delete(id);
					reject(new Error('Codex app-server stdin is closed.'));
				}
			});

		const rejectPending = (message: string) => {
			for (const pending of pendingRequests.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(message));
			}

			pendingRequests.clear();
		};

		const queuedView = () =>
			state.pendingPrompts.map((text) => ({
				text,
				kind: 'follow-up' as const,
			}));

		const startNextQueued = () => {
			if (state.closed || state.activeRun) {
				return;
			}

			const next = state.pendingPrompts.shift();

			if (next === undefined) {
				return;
			}

			emit(
				{ _tag: 'QueueChanged', queued: queuedView() },
			);
			startRun(next);
		};

		const settleRun = (outcome: RunOutcome, serial = state.runSerial) => {
			if (!state.activeRun || serial !== state.runSerial) {
				return;
			}

			if (state.interruptTimer) {
				clearTimeout(state.interruptTimer);
			}

			state.interruptTimer = undefined;
			state.activeRun = false;
			state.dispatching = false;
			// A late turn/completed for this turn must not be misattributed to the
			// next queued run (which starts with no activeTurnId to filter on).
			if (state.activeTurnId) {
				ignoredTurnIds.add(state.activeTurnId);
			}

			state.activeTurnId = undefined;
			state.interruptRequested = false;
			tools.clear();
			emit(
				{ _tag: 'RunSettled', outcome },
			);
			queueMicrotask(startNextQueued);
		};

		const sendInterrupt = (serial: number) => {
			const turnId = state.activeTurnId;
			const threadId = state.meta.nativeSessionId;

			if (!turnId || !threadId || !state.activeRun || serial !== state.runSerial) {
				return;
			}

			void request(
				'turn/interrupt',
				{ threadId, turnId },
				INTERRUPT_FALLBACK_MS,
			).catch((error) => {
				if (state.activeRun && serial === state.runSerial) {
					emit(
						{ _tag: 'BackendError', message: CodexProtocol.boundedError(error) },
					);
				}
			});
		};

		function startRun(text: string) {
			if (state.closed || state.activeRun) {
				return;
			}

			const threadId = state.meta.nativeSessionId;

			if (!threadId) {
				return;
			}

			const serial = ++state.runSerial;

			state.activeRun = true;
			state.dispatching = true;
			state.interruptRequested = false;
			state.activeTurnId = undefined;
			state.runError = undefined;
			state.finalText = '';
			state.lastAssistantText = '';
			emit(
				{ _tag: 'UserMessage', text },
			);
			emit(
				{ _tag: 'RunStarted' },
			);

			const params: JsonRecord = {
				threadId,
				input: [CodexProtocol.textInput(text)],
				...(state.effort ? { effort: state.effort } : {}),
			};

			void request('turn/start', params).then(
				(result) => {
					const turn = CodexProtocol.record(result.turn);
					const turnId = CodexProtocol.stringValue(turn?.id);

					if (!state.activeRun || serial !== state.runSerial) {
						if (turnId) {
							// The run was already settled locally (interrupt fallback or
							// failure), so whatever native turn this response describes is
							// invisible work — stop it unconditionally.
							ignoredTurnIds.add(turnId);
							void request(
								'turn/interrupt',
								{ threadId, turnId },
								INTERRUPT_FALLBACK_MS,
							).catch(() => undefined);
						}

						return;
					}

					state.dispatching = false;
					state.activeTurnId = turnId ?? state.activeTurnId;
					if (state.interruptRequested) {
						sendInterrupt(serial);
					}
				},
				(error) => {
					if (!state.activeRun || serial !== state.runSerial) {
						return;
					}

					const errorText = CodexProtocol.boundedError(error);

					settleRun(
						state.interruptRequested
							? {
									_tag: 'Interrupted',
									partialText: state.finalText || undefined,
								}
							: {
									_tag: 'Failed',
									errorText,
									partialText: state.finalText || undefined,
								},
						serial,
					);
					// A timed-out turn/start means a turn may be running that we can
					// never see or interrupt (no turn id). That session cannot be
					// trusted with further work — kill it; the exit handler reports
					// the death. Explicit protocol rejections keep the session alive.
					if (errorText.includes('timed out')) {
						void processTree.terminate(child, () => state.exited);
					}
				},
			);
		}

		const emitToolStart = (item: JsonRecord) => {
			const tool = CodexProtocol.toolDescription(item);

			if (!tool || tools.has(tool.id)) {
				return;
			}

			tools.set(tool.id, { name: tool.name, output: '' });

			const toolPart: TranscriptPart = {
				type: 'toolCall',
				toolId: tool.id,
				name: tool.name,
				argsPreview: tool.args,
			};

			emit(
				{ _tag: 'AssistantMessage', parts: [toolPart] },
			);
			emit(
				{
					_tag: 'ToolStart',
					toolId: tool.id,
					name: tool.name,
					argsPreview: tool.args,
				},
			);
		};

		const emitToolEnd = (item: JsonRecord) => {
			const description = CodexProtocol.toolDescription(item);

			if (!description) {
				return;
			}

			if (!tools.has(description.id)) {
				emitToolStart(item);
			}

			const live = tools.get(description.id);
			const output = CodexProtocol.toolOutput(item, live?.output ?? '');

			tools.delete(description.id);
			emit(
				{
					_tag: 'ToolEnd',
					toolId: description.id,
					name: live?.name ?? description.name,
					isError: CodexProtocol.toolFailed(item),
					outputPreview: CodexProtocol.firstLine(output),
				},
			);
		};

		const handleItemCompleted = (item: JsonRecord) => {
			const type = CodexProtocol.stringValue(item.type);

			if (type === 'agentMessage') {
				const text = CodexProtocol.stringValue(item.text) ?? '';

				if (text) {
					emit(
						{ _tag: 'AssistantMessage', parts: [{ type: 'text', text }] },
					);
					state.lastAssistantText = text;
					if (CodexProtocol.stringValue(item.phase) === 'final_answer') {
						state.finalText = text;
					}
				}

				return;
			}

			if (type === 'reasoning') {
				const thinking = [...CodexProtocol.strings(item.summary), ...CodexProtocol.strings(item.content)].join('\n');

				if (thinking) {
					emit(
						{
							_tag: 'AssistantMessage',
							parts: [{ type: 'thinking', text: thinking }],
						},
					);
				}

				return;
			}

			emitToolEnd(item);
		};

		const handleNotification = (message: JsonRecord) => {
			if (state.closed) {
				return;
			}

			const method = CodexProtocol.stringValue(message.method);
			const params = CodexProtocol.record(message.params) ?? {};
			const notificationTurn = CodexProtocol.record(params.turn);

			const turnId = CodexProtocol.stringValue(params.turnId) ?? CodexProtocol.stringValue(notificationTurn?.id);

			if (turnId && ignoredTurnIds.has(turnId)) {
				return;
			}

			const belongsToRun = method === 'error' || method?.startsWith('turn/') === true || method?.startsWith('item/') === true || method === 'thread/tokenUsage/updated';

			if (belongsToRun && !state.activeRun) {
				if (turnId) {
					ignoredTurnIds.add(turnId);
				}

				return;
			}

			if (belongsToRun && turnId && state.activeTurnId && turnId !== state.activeTurnId) {
				return;
			}

			switch (method) {
				case 'thread/started': {
					const thread = CodexProtocol.record(params.thread);
					const id = CodexProtocol.stringValue(thread?.id);
					const sessionFilePath = CodexProtocol.stringValue(thread?.path);

					if (id) {
						state.meta = { ...state.meta, nativeSessionId: id };
					}

					if (sessionFilePath) {
						state.meta = { ...state.meta, sessionFilePath };
					}

					emit(
						{ _tag: 'MetaChanged', meta: state.meta },
					);
					break;
				}

				case 'thread/settings/updated': {
					const settings = CodexProtocol.record(params.threadSettings);
					const modelLabel = CodexProtocol.stringValue(settings?.model);

					if (modelLabel) {
						state.meta = { ...state.meta, modelLabel };
						emit(
							{ _tag: 'MetaChanged', meta: { modelLabel } },
						);
					}

					break;
				}

				case 'model/rerouted': {
					const modelLabel = CodexProtocol.stringValue(params.toModel);

					if (modelLabel) {
						state.meta = { ...state.meta, modelLabel };
						emit(
							{ _tag: 'MetaChanged', meta: { modelLabel } },
						);
					}

					break;
				}

				case 'turn/started': {
					const turn = CodexProtocol.record(params.turn);
					const startedId = CodexProtocol.stringValue(turn?.id);
					// Only adopt a turn we are actually waiting on. A stale start from
					// a run the interrupt fallback settled before its turn/start
					// response arrived would otherwise capture activeTurnId and filter
					// out every event of the real next turn.
					if (!state.dispatching && startedId !== state.activeTurnId) {
						if (startedId) {
							ignoredTurnIds.add(startedId);
						}

						break;
					}

					state.activeTurnId = startedId ?? state.activeTurnId;
					state.dispatching = false;
					emit(
						{ _tag: 'RunStarted' },
					);
					if (state.interruptRequested) {
						sendInterrupt(state.runSerial);
					}

					break;
				}

				case 'item/agentMessage/delta': {
					const delta = CodexProtocol.stringValue(params.delta);

					if (delta) {
						emit(
							{ _tag: 'AssistantDelta', kind: 'text', delta },
						);
					}

					break;
				}

				case 'item/reasoning/summaryTextDelta':

				case 'item/reasoning/textDelta': {
					const delta = CodexProtocol.stringValue(params.delta);

					if (delta) {
						emit(
							{ _tag: 'AssistantDelta', kind: 'thinking', delta },
						);
					}

					break;
				}

				case 'item/started': {
					const item = CodexProtocol.record(params.item);

					if (item) {
						emitToolStart(item);
					}

					break;
				}

				case 'item/completed': {
					const item = CodexProtocol.record(params.item);

					if (item) {
						handleItemCompleted(item);
					}

					break;
				}

				case 'item/commandExecution/outputDelta':

				case 'item/fileChange/outputDelta': {
					const id = CodexProtocol.stringValue(params.itemId);
					const delta = CodexProtocol.stringValue(params.delta);
					const tool = id ? tools.get(id) : undefined;

					if (id && tool && delta) {
						tool.output = `${tool.output}${delta}`.slice(-16_384);
						emit(
							{
								_tag: 'ToolUpdate',
								toolId: id,
								outputPreview: CodexProtocol.firstLine(tool.output),
							},
						);
					}

					break;
				}

				case 'item/fileChange/patchUpdated': {
					const id = CodexProtocol.stringValue(params.itemId);

					if (id) {
						emit(
							{
								_tag: 'ToolUpdate',
								toolId: id,
								outputPreview: CodexProtocol.fileChangePreview({ changes: params.changes }),
							},
						);
					}

					break;
				}

				case 'item/mcpToolCall/progress': {
					const id = CodexProtocol.stringValue(params.itemId);

					if (id) {
						emit(
							{
								_tag: 'ToolUpdate',
								toolId: id,
								outputPreview: CodexProtocol.firstLine(params.message),
							},
						);
					}

					break;
				}

				case 'thread/tokenUsage/updated': {
					const { tokens, contextWindow } = CodexProtocol.threadTokenUsage(params);

					if (contextWindow !== undefined) {
						state.meta = { ...state.meta, contextWindow };
						emit(
							{ _tag: 'MetaChanged', meta: { contextWindow } },
						);
					}

					emit(
						{ _tag: 'UsageChanged', tokens, contextWindow },
					);
					break;
				}

				case 'error': {
					const error = CodexProtocol.record(params.error);

					const messageText = CodexProtocol.boundedError(CodexProtocol.stringValue(error?.message) ?? 'Codex run failed');

					if (params.willRetry !== true) {
						state.runError = messageText;
					}

					emit(
						{ _tag: 'BackendError', message: messageText },
					);
					break;
				}

				case 'turn/completed': {
					const turn = CodexProtocol.record(params.turn);
					const status = CodexProtocol.stringValue(turn?.status);
					const error = CodexProtocol.record(turn?.error);

					const partialText = state.finalText || state.lastAssistantText || undefined;

					if (state.interruptRequested || status === 'interrupted') {
						settleRun(
							{ _tag: 'Interrupted', partialText },
						);
					} else if (status === 'failed') {
						settleRun(
							{
								_tag: 'Failed',
								errorText: CodexProtocol.boundedError(state.runError ?? CodexProtocol.stringValue(error?.message) ?? 'Codex run failed'),
								partialText,
							},
						);
					} else {
						settleRun(
							{
								_tag: 'Completed',
								finalText: state.finalText || state.lastAssistantText,
							},
						);
					}

					break;
				}
			}
		};

		const handleServerRequest = (message: JsonRecord) => {
			const id = message.id;

			if (typeof id !== 'number' && typeof id !== 'string') {
				return;
			}

			const method = CodexProtocol.stringValue(message.method);

			if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
				writeMessage(
					{ id, result: { decision: 'decline' } },
				);

				return;
			}

			writeMessage(
				{
					id,
					error: {
						code: -32601,
						message: `Unsupported headless server request: ${method ?? 'unknown'}`,
					},
				},
			);
		};

		const handleLine = (line: string) => {
			if (!line.trim()) {
				return;
			}

			let parsed: unknown;

			try {
				parsed = JSON.parse(line);
			} catch {
				emit(
					{
						_tag: 'BackendError',
						message: `Invalid Codex protocol line: ${line.slice(0, 512)}`,
					},
				);

				return;
			}

			const message = CodexProtocol.record(parsed);

			if (!message) {
				return;
			}

			const id = CodexProtocol.numberValue(message.id);

			if (id !== undefined && pendingRequests.has(id)) {
				const pending = pendingRequests.get(id);

				if (!pending) {
					return;
				}

				pendingRequests.delete(id);
				clearTimeout(pending.timer);
				if (message.error !== undefined) {
					pending.reject(new Error(CodexProtocol.protocolError(message.error)));
				} else {
					pending.resolve(CodexProtocol.record(message.result) ?? {});
				}

				return;
			}

			if (message.id !== undefined && message.method !== undefined) {
				handleServerRequest(message);
			} else if (message.method !== undefined) {
				handleNotification(message);
			}
		};

		const failForProcessExit = (detail: string) => {
			if (state.exited) {
				return;
			}

			state.exited = true;
			rejectPending(detail);
			if (state.closing) {
				return;
			}

			state.closed = true;
			state.pendingPrompts = [];
			emit(
				{ _tag: 'QueueChanged', queued: [] },
			);
			if (state.activeRun) {
				settleRun(
					{
						_tag: 'Failed',
						errorText: CodexProtocol.boundedError(detail),
						partialText: state.finalText || state.lastAssistantText || undefined,
					},
				);
			}

			Queue.endUnsafe(events);
		};

		let stdoutBuffer = '';

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdoutBuffer += chunk;

			while (true) {
				const newline = stdoutBuffer.indexOf('\n');

				if (newline < 0) {
					break;
				}

				const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');

				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				handleLine(line);
			}

			if (stdoutBuffer.length > STDOUT_BUFFER_MAX_BYTES) {
				// A frame this large with no newline is protocol corruption, and an
				// unbounded buffer is a memory leak. Session-fatal: the exit handler
				// settles any active run.
				stdoutBuffer = '';
				void processTree.terminate(child, () => state.exited);
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			state.stderr = `${state.stderr}${chunk}`.slice(-4096);
		});
		// Stream-level failures (an EPIPE write racing the child's exit, a read
		// error) are emitted on the individual stdio streams, not on the child. Left
		// unhandled, Node turns them into uncaught exceptions that take the whole pi
		// process down; the session should just fail instead.
		child.stdin.on('error', (error) => failForProcessExit(`Codex app-server stdin failed: ${CodexProtocol.boundedError(error)}`));
		child.stdout.on('error', (error) => failForProcessExit(`Codex app-server stdout failed: ${CodexProtocol.boundedError(error)}`));
		child.stderr.on('error', (error) => failForProcessExit(`Codex app-server stderr failed: ${CodexProtocol.boundedError(error)}`));
		child.once('error', (error) => failForProcessExit(`Codex app-server failed: ${CodexProtocol.boundedError(error)}`));
		child.once('exit', (code, signal) => {
			const suffix = CodexProtocol.firstLine(state.stderr);

			failForProcessExit(`Codex app-server exited (${signal ?? `code ${code ?? 'unknown'}`})${suffix ? `: ${suffix}` : ''}`);
		});

		yield* Effect.addFinalizer(() =>
			Effect.promise(async () => {
				if (state.closing) {
					return;
				}

				state.closing = true;
				if (state.interruptTimer) {
					clearTimeout(state.interruptTimer);
				}
				// Settle before marking closed so the run gets the correct
				// "Interrupted" outcome instead of the pump's generic fallback.
				if (state.activeRun) {
					settleRun(
						{
							_tag: 'Interrupted',
							partialText: state.finalText || state.lastAssistantText || undefined,
						},
					);
				}

				state.closed = true;
				rejectPending('Codex session closed.');

				await processTree.terminate(child, () => state.exited);

				Queue.endUnsafe(events);
			}),
		);

		const threadResult = yield* Effect.tryPromise({
			try: async () => {
				await request(
					'initialize',
					{
						clientInfo: {
							name: 'pi-subagents',
							title: 'pi subagent',
							version: '2.0.0',
						},
						capabilities: { experimentalApi: true },
					},
				);

				writeMessage(
					{ method: 'initialized' },
				);

				return request(
					'thread/start',
					{
						cwd: task.cwd,
						...CodexProtocol.sandboxOptions(task.parent.projectTrusted),
						ephemeral: false,
						...(task.model ? { model: task.model } : {}),
					},
				);
			},
			catch: (error) => new SpawnError({ message: CodexProtocol.boundedError(error) }),
		});

		const thread = CodexProtocol.record(threadResult.thread);
		const nativeSessionId = CodexProtocol.stringValue(thread?.id);

		if (!nativeSessionId) {
			return yield* new SpawnError({
				message: 'Codex thread/start returned no thread id.',
			});
		}

		state.meta = {
			backend: 'codex',
			modelLabel: CodexProtocol.stringValue(threadResult.model) ?? task.model,
			sessionFilePath: CodexProtocol.stringValue(thread?.path),
			nativeSessionId,
		};
		if (task.reasoningEffort) {
			// Optional capability probe: never let a slow/unsupported model/list
			// hold up the spawn (and its concurrency reservation) for the full
			// request timeout; the unclamped preferred effort is a fine fallback.
			const modelList = yield* Effect.tryPromise(() => request(
				'model/list',
				{ includeHidden: true },
				MODEL_LIST_TIMEOUT_MS,
			)).pipe(Effect.orElseSucceed(() => undefined));

			state.effort = CodexProtocol.supportedEffort(task.reasoningEffort, state.meta.modelLabel, modelList);
		}

		emit(
			{ _tag: 'MetaChanged', meta: state.meta },
		);
		startRun(task.prompt);

		return {
			meta: Effect.sync(() => state.meta),
			events: Stream.fromQueue(events),
			send: (text) =>
				Effect.suspend((): Effect.Effect<void, SendError> => {
					if (state.closed) {
						return new SendError({ message: 'Subagent session is closed.' });
					}

					if (state.activeRun) {
						state.pendingPrompts.push(text);
						emit(
							{ _tag: 'QueueChanged', queued: queuedView() },
						);

						return Effect.void;
					}

					return Effect.sync(() => startRun(text));
				}),
			interrupt: Effect.promise(async () => {
				if (state.closed || !state.activeRun) {
					return;
				}

				const serial = state.runSerial;

				state.pendingPrompts = [];
				emit(
					{ _tag: 'QueueChanged', queued: [] },
				);
				state.interruptRequested = true;
				sendInterrupt(serial);
				if (state.interruptTimer) {
					clearTimeout(state.interruptTimer);
				}

				state.interruptTimer = setTimeout(() => {
					if (state.activeRun && serial === state.runSerial) {
						if (state.activeTurnId) {
							ignoredTurnIds.add(state.activeTurnId);
						}

						settleRun(
							{
								_tag: 'Interrupted',
								partialText: state.finalText || state.lastAssistantText || undefined,
							},
						);
						// The server never acknowledged the interrupt, so the native
						// turn may still be executing tools. A session that ignores
						// interrupts cannot be trusted — kill it rather than let
						// invisible work continue behind a "settled" run.
						void processTree.terminate(child, () => state.exited);
					}
				}, INTERRUPT_FALLBACK_MS);
			}),
		} satisfies SubagentSession;
	});

/** Signal the whole process group on POSIX so tool descendants (shell
 * commands the app-server spawned) die with it; a wedged or force-killed
 * server must not orphan a still-running command in the workspace. */
export const codexBackend: SubagentBackend = {
	name: 'codex',
	capabilities: {
		steering: false,
		modelSelection: true,
		reasoningEffort: true,
	},
	available: Effect.sync(() => codexBinary.resolve() !== undefined),
	spawn: makeCodexSession,
};
