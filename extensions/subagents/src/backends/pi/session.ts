import { createAgentSession, type AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import type { Cause, Scope } from 'effect';
import { Effect, Queue, Stream } from 'effect';
import type { SubagentSession } from '@subagents/src/backend.ts';
import { SendError, SpawnError, type SpawnTask, type SubagentEvent, type SubagentMeta } from '@subagents/src/domain.ts';
import { createToolCallTimeoutGuard } from '@shared/tool-call-timeout.ts';
import { PiModelResolver, type PiThinkingLevel } from '@subagents/src/backends/pi/model.ts';
import { PiProtocol } from '@subagents/src/backends/pi/protocol.ts';
import { PI_CHILD_EXCLUDED_TOOL_NAMES, PiChildResources, PiChildSessionLifecycle } from '@subagents/src/backends/pi/resources.ts';
import { PiTranscript } from '@subagents/src/backends/pi/transcript.ts';

/** Owns one scoped, in-process pi child session. */
export class PiSession {
	/** Create and start a scoped pi session for a subagent task. */
	static create(task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> {
		return Effect.gen(function* () {
			const registry = task.parent.modelRegistry;

			if (!registry) {
				return yield* new SpawnError({
					message: "pi backend requires the parent session's model registry.",
				});
			}

			const model = yield* Effect.try({
				try: () => PiModelResolver.resolve(registry, task.model, task.parent.inheritedModel),
				catch: (error) => new SpawnError({ message: PiProtocol.boundedError(error) }),
			});

			const thinkingLevel = (task.reasoningEffort ?? task.parent.inheritedThinkingLevel) as PiThinkingLevel | undefined;

			const session = yield* Effect.tryPromise({
				try: async () => {
					const { loader, settingsManager } = await PiChildResources.create(task.cwd, task.parent.projectTrusted);

					const { session } = await createAgentSession(
						{
							cwd: task.cwd,
							sessionManager: SessionManager.create(task.cwd),
							settingsManager,
							resourceLoader: loader,
							model,
							thinkingLevel,
							excludeTools: [...PI_CHILD_EXCLUDED_TOOL_NAMES],
						},
					);
					// Start child extension session hooks/resources in headless mode.
					// A rejection here would otherwise leak the freshly created session:
					// the scope finalizer that owns cleanup is only registered later.
					try {
						await session.bindExtensions({ mode: 'print' });
					} catch (error) {
						await PiChildSessionLifecycle.shutdownAndDispose(session);

						throw error;
					}

					return session;
				},
				catch: (error) => new SpawnError({ message: PiProtocol.boundedError(error) }),
			});

			const state = {
				closed: false,
				/** prompt() rejection for the active run; folded into RunSettled. */
				runError: undefined as string | undefined,
				/** One terminal event per run: lifecycle, prompt-rejection, and abort
				 * fallbacks can all race to settle; the first wins. */
				settled: false,
			};

			const events = yield* Queue.make<SubagentEvent, Cause.Done>();

			const emit = (event: SubagentEvent) => {
				Queue.offerUnsafe(events, event);
			};

			const toolTimeout = createToolCallTimeoutGuard();

			toolTimeout.apply(session);

			const activeModel = () => {
				const sessionModel = session.model;
				const last = PiTranscript.lastAssistantMessage(session);

				if (!last) {
					return sessionModel;
				}

				if (sessionModel && (last.provider !== sessionModel.provider || last.model !== sessionModel.id)) {
					// The session changed models after this assistant response.
					return sessionModel;
				}

				return registry.find(last.provider, last.responseModel ?? last.model) ?? sessionModel;
			};

			const currentMeta = (): SubagentMeta => {
				const model = activeModel();

				return {
					backend: 'pi',
					modelLabel: model ? `${model.provider}/${model.id}` : undefined,
					contextWindow: model?.contextWindow,
					sessionFilePath: session.sessionFile,
				};
			};

			const emitUsage = () => {
				const usage = session.getContextUsage();

				emit(
					{
						_tag: 'UsageChanged',
						tokens: usage?.tokens ?? undefined,
						contextWindow: activeModel()?.contextWindow ?? usage?.contextWindow,
					},
				);
			};

			const settle = () => {
				if (state.settled) {
					return;
				}

				state.settled = true;

				const last = PiTranscript.lastAssistantMessage(session);
				const partialText = PiTranscript.finalOutput(session) || undefined;

				if (last?.stopReason === 'aborted') {
					emit(
						{
							_tag: 'RunSettled',
							outcome: { _tag: 'Interrupted', partialText },
						},
					);

					return;
				}

				const errorText = state.runError ?? (last?.stopReason === 'error' ? (last.errorMessage ?? 'Run failed') : undefined);

				if (errorText !== undefined) {
					emit(
						{
							_tag: 'RunSettled',
							outcome: {
								_tag: 'Failed',
								errorText: PiProtocol.boundedError(errorText),
								partialText,
							},
						},
					);

					return;
				}

				emit(
					{
						_tag: 'RunSettled',
						outcome: { _tag: 'Completed', finalText: PiTranscript.finalOutput(session) },
					},
				);
			};

			const handleEvent = (event: AgentSessionEvent) => {
				if (state.closed) {
					return;
				}

				switch (event.type) {
					case 'agent_start':
						// Extensions may register tools between runs; guard new ones too.
						toolTimeout.apply(session);
						state.settled = false;
						emit(
							{ _tag: 'RunStarted' },
						);
						break;

					case 'message_update': {
						const streamEvent = event.assistantMessageEvent;

						if (streamEvent.type === 'text_delta') {
							emit(
								{
									_tag: 'AssistantDelta',
									kind: 'text',
									delta: streamEvent.delta,
								},
							);
						} else if (streamEvent.type === 'thinking_delta') {
							emit(
								{
									_tag: 'AssistantDelta',
									kind: 'thinking',
									delta: streamEvent.delta,
								},
							);
						}

						break;
					}

					case 'message_end': {
						const role = PiTranscript.messageRole(event.message);

						if (role === 'user') {
							const text = PiTranscript.userText(event.message);

							if (text.trim()) {
								emit(
									{ _tag: 'UserMessage', text },
								);
							}
						} else if (role === 'assistant') {
							const message = PiTranscript.assistantMessage(event.message);

							if (!message) {
								break;
							}

							emit(
								{
									_tag: 'AssistantMessage',
									parts: PiTranscript.assistantParts(message),
								},
							);
							emitUsage();
							emit(
								{ _tag: 'MetaChanged', meta: currentMeta() },
							);
						}
						// toolResult messages are covered by tool_execution_end.
						break;
					}

					case 'tool_execution_start':
						emit(
							{
								_tag: 'ToolStart',
								toolId: event.toolCallId,
								name: event.toolName,
								argsPreview: PiProtocol.safeJson(event.args),
							},
						);
						break;

					case 'tool_execution_update':
						emit(
							{
								_tag: 'ToolUpdate',
								toolId: event.toolCallId,
								outputPreview: PiProtocol.toolPreview(event.partialResult),
							},
						);
						break;

					case 'tool_execution_end':
						emit(
							{
								_tag: 'ToolEnd',
								toolId: event.toolCallId,
								name: event.toolName,
								isError: event.isError,
								outputPreview: PiProtocol.toolPreview(event.result),
							},
						);
						break;

					case 'queue_update':
						emit(
							{
								_tag: 'QueueChanged',
								queued: [
									...event.steering.map((text) => ({
										text,
										kind: 'steer' as const,
									})),
									...event.followUp.map((text) => ({
										text,
										kind: 'follow-up' as const,
									})),
								],
							},
						);
						break;

					case 'agent_settled':
						settle();
						break;
				}
			};

			const unsubscribe = session.subscribe(handleEvent);

			yield* Effect.addFinalizer(() =>
				Effect.promise(async () => {
					state.closed = true;
					unsubscribe();
					try {
						session.clearQueue();
					} catch {
						// Continue with abort/dispose.
					}

					await PiChildSessionLifecycle.abort(session);

					await PiChildSessionLifecycle.shutdownAndDispose(session);

					Queue.endUnsafe(events);
				}),
			);

			/** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
			const startRun = (text: string) => {
				state.runError = undefined;
				state.settled = false;
				emit(
					{ _tag: 'RunStarted' },
				);
				void session.prompt(text).catch((error) => {
					state.runError = PiProtocol.boundedError(error);
					// Preflight failures may never start the agent lifecycle, so no
					// agent_settled will arrive for them.
					if (!session.isStreaming) {
						settle();
					}
				});
			};

			// Session naming is best-effort.
			yield* Effect.try(() => session.sessionManager.appendSessionInfo(`${task.origin === 'btw' ? 'btw' : 'subagent'}: ${task.title}`)).pipe(Effect.ignore);

			emit(
				{ _tag: 'MetaChanged', meta: currentMeta() },
			);
			startRun(task.prompt);

			return {
				meta: Effect.sync(currentMeta),
				events: Stream.fromQueue(events),
				send: (text) =>
					Effect.suspend((): Effect.Effect<void, SendError> => {
						if (state.closed) {
							return new SendError({ message: 'Subagent session is closed.' });
						}

						if (session.isStreaming) {
							// Steer the active run via the SDK's queue; queue_update events
							// render it, message_end(user) lands it in the transcript. A
							// rejected steer is a real send failure, not a diagnostic.
							return Effect.tryPromise({
								try: () => session.steer(text),
								catch: (error) => new SendError({ message: PiProtocol.boundedError(error) }),
							}).pipe(Effect.asVoid);
						}

						return Effect.sync(() => startRun(text));
					}),
				interrupt: Effect.promise(async () => {
					if (state.closed) {
						return;
					}

					try {
						session.clearQueue();
					} catch {
						// Abort regardless.
					}

					await session.abort().catch(() => undefined);
					// Only resolve once streaming has actually stopped: reporting the
					// interrupt as complete while the run keeps working would let the
					// manager settle a run that is still mutating the workspace. The
					// manager bounds this effect at 5s and force-disposes on timeout.
					while (!state.closed && session.isStreaming) {
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					// No streaming run means no agent_settled will arrive; emit the
					// terminal event (once) so the run cannot look running forever.
					if (!state.closed && !state.settled) {
						state.settled = true;
						emit(
							{ _tag: 'RunSettled', outcome: { _tag: 'Interrupted' } },
						);
					}
				}),
			} satisfies SubagentSession;
		});
	}
}
