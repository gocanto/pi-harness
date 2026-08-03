/**
 * Claude Code backend — real implementation over the Claude Agent SDK.
 *
 * One SDK `query()` and one streaming-input bridge live for the whole scoped
 * session. User sends are pushed into that bridge, while the query iterator is
 * pumped in the background and translated to normalized SubagentEvents. The
 * CLI therefore owns conversation continuity, tool execution, and persisted
 * `~/.claude/projects` transcripts; this file only owns lifecycle guarantees
 * and the normalized view consumed by the manager.
 */

import type { Cause, Scope } from 'effect';
import { Effect, Queue, Stream } from 'effect';
import type { SubagentBackend, SubagentSession } from '../backend.ts';
import { SendError, SpawnError } from '../domain.ts';
import { ClaudeBinaryResolver, ClaudeInput, ClaudeProtocol, ClaudeTeardown } from './claude/index.ts';

import { query, type Options, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { QueuedMessage, ReasoningEffort, RunOutcome, SpawnTask, SubagentEvent, SubagentMeta } from '../domain.ts';

const CLAUDE_CONTEXT_WINDOW = 200_000;
const INTERRUPT_TIMEOUT_MS = 2_000;
const claudeBinaryResolver = new ClaudeBinaryResolver();

const THINKING_BUDGETS = {
	off: 0,
	minimal: 1_024,
	low: 4_096,
	medium: 10_000,
	high: 16_000,
	xhigh: 32_000,
	max: 63_999,
} satisfies Record<ReasoningEffort, number>;

/**
 * Query permission options gated by workspace trust. Headless children
 * cannot answer interactive approval prompts, so a trusted cwd (the caller
 * already vetted the directory — see `resolveStandaloneChildProjectTrust`)
 * gets the SDK's autonomous `bypassPermissions` mode. An untrusted cwd
 * instead gets `dontAsk`, the SDK's headless-safe restricted mode: it denies
 * any tool call that is not already pre-approved rather than bypassing
 * checks or hanging on a prompt no one can answer. `permissionMode` is the
 * actual access boundary; `settingSources` only controls which config files
 * load (stopping an untrusted project's own settings from reconfiguring the
 * child) and must never substitute for the permission mode.
 */
export function claudePermissionOptions(trusted: boolean): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions' | 'settingSources'> {
	return trusted
		? {
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
			}
		: { permissionMode: 'dontAsk', settingSources: ['user'] };
}

/** Calculate context occupancy from one Claude assistant request. */
export function contextOccupancyTokens(
	usage:
		| {
				input_tokens?: number | null;
				cache_read_input_tokens?: number | null;
				cache_creation_input_tokens?: number | null;
				output_tokens?: number | null;
		  }
		| null
		| undefined,
) {
	return ClaudeProtocol.contextOccupancyTokens(usage);
}

// --- The session -------------------------------------------------------------

interface NativeQueuedMessage extends QueuedMessage {
	readonly uuid: string;
	/** Raw response sequence after which this steer can be consumed. */
	readonly afterResponse: number;
}

const makeClaudeSession = (task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
	Effect.gen(function* () {
		const input = new ClaudeInput();
		const abortController = new AbortController();
		const events = yield* Queue.make<SubagentEvent, Cause.Done>();

		const emit = (event: SubagentEvent) => {
			Queue.offerUnsafe(events, event);
		};

		const state = {
			closed: false,
			activeRun: false,
			interruptRequested: false,
			runVersion: 0,
			lastSettledVersion: 0,
			responseSequence: 0,
			queued: [] as NativeQueuedMessage[],
			submittedUuids: new Set<string>(),
			currentText: '',
			liveText: '',
			tools: new Map<string, string>(),
			settleWaiters: new Set<() => void>(),
			meta: {
				backend: 'claude',
				modelLabel: task.model,
				// Claude models used by this backend currently expose 200k context;
				// result.modelUsage replaces this fallback when the CLI knows better.
				contextWindow: CLAUDE_CONTEXT_WINDOW,
			} satisfies SubagentMeta as SubagentMeta,
		};

		const thinkingBudget = task.reasoningEffort ? THINKING_BUDGETS[task.reasoningEffort] : undefined;
		const claudeBinary = claudeBinaryResolver.resolve();

		const nativeQuery = yield* Effect.try({
			try: () =>
				query({
					prompt: input,
					options: {
						cwd: task.cwd,
						...claudePermissionOptions(task.parent.projectTrusted),
						// Keep child orchestration inside this extension's global manager
						// and concurrency cap rather than Claude Code's native subagents.
						disallowedTools: ['Agent', 'Task'],
						includePartialMessages: true,
						abortController,
						...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
						...(task.model ? { model: task.model } : {}),
						...(thinkingBudget !== undefined ? { maxThinkingTokens: thinkingBudget } : {}),
					},
				}),
			catch: (error) => new SpawnError({ message: ClaudeProtocol.boundedError(error) }),
		});

		let resolvePumpDone: (() => void) | undefined;

		const pumpDone = new Promise<void>((resolve) => {
			resolvePumpDone = resolve;
		});

		const queuedView = (): ReadonlyArray<QueuedMessage> => state.queued.map(({ text, kind }) => ({ text, kind }));

		const notifySettled = () => {
			for (const waiter of state.settleWaiters) {
				waiter();
			}

			state.settleWaiters.clear();
		};

		const partialText = () => state.liveText || state.currentText || undefined;

		const settle = (outcome: RunOutcome) => {
			if (!state.activeRun) {
				return;
			}

			emit(
				{ _tag: 'RunSettled', outcome },
			);
			state.activeRun = false;
			state.lastSettledVersion = state.runVersion;
			state.interruptRequested = false;
			state.liveText = '';
			notifySettled();
		};

		const updateMeta = (patch: Partial<SubagentMeta>) => {
			state.meta = { ...state.meta, ...patch };
			emit(
				{ _tag: 'MetaChanged', meta: patch },
			);
		};

		const beginQueuedRunIfNeeded = () => {
			if (state.activeRun || state.queued.length === 0) {
				return;
			}
			// A steer arriving too late for the prior turn becomes a fresh queued
			// turn. The repeated init is the first reliable signal that it started.
			state.activeRun = true;
			state.runVersion++;
			state.currentText = '';
			state.liveText = '';
			emit(
				{ _tag: 'RunStarted' },
			);
		};

		const clearConsumedSteers = () => {
			const remaining = state.queued.filter((message) => message.afterResponse >= state.responseSequence);

			if (remaining.length === state.queued.length) {
				return;
			}

			state.queued = remaining;
			emit(
				{ _tag: 'QueueChanged', queued: queuedView() },
			);
		};

		const handleAssistant = (message: SDKAssistantMessage) => {
			const parts = ClaudeProtocol.assistantParts(message);

			if (parts.length > 0) {
				emit(
					{ _tag: 'AssistantMessage', parts },
				);
			}

			// Top-level messages only: subagent (sidechain) requests have their own
			// context and must not overwrite this conversation's occupancy.
			if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
				const tokens = ClaudeProtocol.contextOccupancyTokens(message.message.usage);

				if (tokens !== undefined) {
					emit(
						{ _tag: 'UsageChanged', tokens },
					);
				}
			}

			const text = message.message.content
				.filter((block) => block.type === 'text')
				.map((block) => block.text)
				.join('\n')
				.trim();

			if (text) {
				state.currentText = text;
			}

			state.liveText = '';

			if (message.message.model !== state.meta.modelLabel) {
				updateMeta(
					{ modelLabel: message.message.model },
				);
			}
			for (const block of message.message.content) {
				if (block.type !== 'tool_use') {
					continue;
				}

				state.tools.set(block.id, block.name);
				emit(
					{
						_tag: 'ToolStart',
						toolId: block.id,
						name: block.name,
						argsPreview: ClaudeProtocol.safeJson(block.input),
					},
				);
			}
		};

		const handleUser = (message: SDKUserMessage) => {
			const content = message.message.content;

			if (!Array.isArray(content)) {
				return;
			}
			for (const block of content) {
				if (block.type !== 'tool_result') {
					continue;
				}

				const name = state.tools.get(block.tool_use_id) ?? 'Tool';

				state.tools.delete(block.tool_use_id);
				emit(
					{
						_tag: 'ToolEnd',
						toolId: block.tool_use_id,
						name,
						isError: block.is_error ?? false,
						outputPreview: ClaudeProtocol.outputPreview(block.content),
					},
				);
			}
			// External prompts are emitted synchronously by submit(); ignoring text
			// here prevents a future CLI echo from duplicating the transcript row.
		};

		const handleResult = (result: SDKResultMessage) => {
			// result.usage is a whole-run aggregate, not occupancy (see
			// contextOccupancyTokens); only the capacity is trustworthy here. The
			// occupancy itself was already emitted by the last assistant message.
			const contextWindow = ClaudeProtocol.resultContextWindow(result);

			emit(
				{
					_tag: 'UsageChanged',
					contextWindow: contextWindow ?? state.meta.contextWindow,
				},
			);
			if (contextWindow !== undefined && contextWindow !== state.meta.contextWindow) {
				updateMeta(
					{ contextWindow },
				);
			}

			if (state.interruptRequested) {
				settle(
					{ _tag: 'Interrupted', partialText: partialText() },
				);
			} else if (result.subtype === 'success') {
				settle(
					{
						_tag: 'Completed',
						finalText: result.result.trim() || state.currentText,
					},
				);
			} else {
				const details = result.errors.filter((error) => error.trim()).join('\n') || result.stop_reason || `Claude Code ended with ${result.subtype}`;

				settle(
					{
						_tag: 'Failed',
						errorText: ClaudeProtocol.boundedError(details),
						partialText: partialText(),
					},
				);
			}
		};

		const handleMessage = (message: SDKMessage) => {
			if (state.closed) {
				return;
			}
			// A queued steer's turn normally announces itself with a repeated
			// system/init, but any turn activity is an equally valid begin signal —
			// without this, a missed init would stream events into a "done" run
			// that could then never settle.
			if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'result') {
				beginQueuedRunIfNeeded();
			}

			if (message.type === 'system' && message.subtype === 'init') {
				beginQueuedRunIfNeeded();
				updateMeta(
					{
						modelLabel: message.model,
						nativeSessionId: message.session_id,
						sessionFilePath: ClaudeProtocol.sessionFilePath(message.cwd, message.session_id),
						contextWindow: CLAUDE_CONTEXT_WINDOW,
					},
				);
			} else if (message.type === 'stream_event') {
				if (message.parent_tool_use_id !== null) {
					return;
				}

				if (message.event.type === 'message_start') {
					state.responseSequence++;
					clearConsumedSteers();
				} else if (message.event.type === 'content_block_delta') {
					const delta = message.event.delta;

					if (delta.type === 'text_delta') {
						state.liveText += delta.text;
						emit(
							{ _tag: 'AssistantDelta', kind: 'text', delta: delta.text },
						);
					} else if (delta.type === 'thinking_delta') {
						emit(
							{
								_tag: 'AssistantDelta',
								kind: 'thinking',
								delta: delta.thinking,
							},
						);
					}
				}
			} else if (message.type === 'assistant') {
				handleAssistant(message);
			} else if (message.type === 'user') {
				handleUser(message);
			} else if (message.type === 'result') {
				handleResult(message);
			}
		};

		const pump = async () => {
			let failure: string | undefined;

			try {
				for await (const message of nativeQuery) {
					handleMessage(message);
				}
			} catch (error) {
				if (!state.closed && !abortController.signal.aborted) {
					failure = ClaudeProtocol.boundedError(error);
				}
			} finally {
				if (!state.closed) {
					if (state.activeRun) {
						settle(
							state.interruptRequested
								? { _tag: 'Interrupted', partialText: partialText() }
								: {
										_tag: 'Failed',
										errorText: failure ?? 'Claude Code query ended unexpectedly',
										partialText: partialText(),
									},
						);
					} else if (failure) {
						emit(
							{ _tag: 'BackendError', message: failure },
						);
					}

					state.closed = true;
					Queue.endUnsafe(events);
				}

				resolvePumpDone?.();
			}
		};

		yield* Effect.addFinalizer(() =>
			Effect.promise(async () => {
				// Settle before marking closed: the pump's finally skips settlement
				// once closed, and every run must end in a RunSettled even when the
				// scope closes mid-run.
				if (state.activeRun) {
					settle(
						{ _tag: 'Interrupted', partialText: partialText() },
					);
				}

				state.closed = true;
				input.end();
				abortController.abort();
				nativeQuery.close();

				await ClaudeTeardown.waitBounded(pumpDone, INTERRUPT_TIMEOUT_MS);

				Queue.endUnsafe(events);
			}),
		);

		void pump();

		const submit = (text: string) => {
			const wasActive = state.activeRun;
			const message = input.push(text);

			if (!message) {
				return false;
			}

			if (!wasActive) {
				state.activeRun = true;
				state.runVersion++;
				state.currentText = '';
				state.liveText = '';
			}

			state.submittedUuids.add(message.uuid ?? '');
			// Idle restarts flip status synchronously (like pi's startRun); a steer
			// into an active run must NOT re-emit RunStarted — its own turn begins
			// later via beginQueuedRunIfNeeded.
			if (!wasActive) {
				emit(
					{ _tag: 'RunStarted' },
				);
			}

			emit(
				{ _tag: 'UserMessage', text },
			);
			if (wasActive) {
				state.queued.push({
					text,
					kind: 'steer',
					uuid: message.uuid ?? '',
					afterResponse: state.responseSequence,
				});
				emit(
					{ _tag: 'QueueChanged', queued: queuedView() },
				);
			}

			return true;
		};

		const waitForVersion = (version: number) => {
			if (state.lastSettledVersion >= version) {
				return Promise.resolve();
			}

			return new Promise<void>((resolve) => {
				const waiter = () => {
					if (state.lastSettledVersion < version && !state.closed) {
						return;
					}

					state.settleWaiters.delete(waiter);
					resolve();
				};

				state.settleWaiters.add(waiter);
			});
		};

		emit(
			{ _tag: 'MetaChanged', meta: state.meta },
		);
		submit(task.prompt);

		return {
			meta: Effect.sync(() => state.meta),
			events: Stream.fromQueue(events),
			send: (text) =>
				Effect.suspend((): Effect.Effect<void, SendError> => {
					if (state.closed) {
						return new SendError({ message: 'Subagent session is closed.' });
					}

					return submit(text) ? Effect.void : new SendError({ message: 'Subagent session is closed.' });
				}),
			interrupt: Effect.promise(async () => {
				if (state.closed || !state.activeRun) {
					return;
				}

				const version = state.runVersion;

				state.interruptRequested = true;
				input.clear();
				state.queued = [];
				emit(
					{ _tag: 'QueueChanged', queued: [] },
				);

				const interruptAndSettle = (async () => {
					try {
						const receipt = await nativeQuery.interrupt();

						const hasOwnQueuedMessage = receipt?.still_queued?.some((uuid) => state.submittedUuids.has(uuid));

						if (hasOwnQueuedMessage) {
							// 0.3.207 exposes cancellation receipts but no public per-message
							// cancel method. Closing is the only way to prevent a cancelled
							// queued prompt from immediately starting another turn.
							input.end();
							nativeQuery.close();
						}
					} catch (error) {
						if (!state.closed) {
							emit(
								{ _tag: 'BackendError', message: ClaudeProtocol.boundedError(error) },
							);
						}
					}

					await waitForVersion(version);
				})();

				await ClaudeTeardown.waitBounded(interruptAndSettle, INTERRUPT_TIMEOUT_MS);

				if (!state.closed && state.activeRun && state.runVersion === version) {
					// Covers pre-init/pending races and SDK versions that acknowledge an
					// interrupt without delivering a result. Force-close after settling
					// so a late native result cannot resurrect or re-settle this run.
					settle(
						{ _tag: 'Interrupted', partialText: partialText() },
					);
					state.closed = true;
					input.end();
					abortController.abort();
					nativeQuery.close();
					Queue.endUnsafe(events);
				}
			}),
		} satisfies SubagentSession;
	});

// --- Backend -----------------------------------------------------------------

export const claudeBackend: SubagentBackend = {
	name: 'claude',
	capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
	available: Effect.sync(() => claudeBinaryResolver.resolve() !== undefined),
	spawn: makeClaudeSession,
};
