/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import { Type, type TSchema } from 'typebox';
import { createToolCallTimeoutGuard } from '../shared/tool-call-timeout.ts';
import { emptyUsage, type AgentUsage, type TranscriptEntry } from './model.ts';
import { truncateUtf8 } from './serialization.ts';
import type { CreateAgentSessionOptions, DefaultResourceLoader, SessionShutdownEvent, SettingsManager } from '@earendil-works/pi-coding-agent';
import { bindChildSessionExtensions, childToolPolicy, createChildResources, shutdownAndDisposeChildSession } from '../shared/child-session.ts';
import { buildWorkflowAgentPrompt, STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION, STRUCTURED_OUTPUT_TOOL_DESCRIPTION } from './prompt.ts';

import {
	createAgentSession,
	defineTool,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;

export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;

export type WorkflowModel = NonNullable<ExtensionContext['model']>;

export type ThinkingLevel = ReturnType<ExtensionAPI['getThinkingLevel']>;

export interface AgentOutcome {
	ok: boolean;
	/** Final assistant text (may be empty when only structured output was produced). */
	output: string;
	/** Captured structured_output payload when a schema was supplied. */
	structured?: unknown;
	error?: string;
	aborted: boolean;
	usage: AgentUsage;
	model?: string;
	contextWindow?: number;
	transcript: TranscriptEntry[];
}

export interface AgentProgress {
	preview: string;
	usage: AgentUsage;
	model?: string;
	contextWindow?: number;
	transcript: TranscriptEntry[];
}

export interface RunAgentOptions {
	prompt: string;
	schema?: unknown;
	model?: WorkflowModel;
	thinkingLevel?: ThinkingLevel;
	cwd: string;
	loader: DefaultResourceLoader;
	settingsManager: SettingsManager;
	modelRegistry: ExtensionContext['modelRegistry'];
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	/** Test-only override for the per-tool execution timeout. */
	toolCallTimeoutMs?: number;
	/** Test-only override for the first assistant response-event timeout. */
	firstResponseTimeoutMs?: number;
	/** Test-only override for session creation; defaults to the production Pi SDK. */
	createSession?: CreateWorkflowAgentSession;
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(cwd: string, variant: 'plain' | 'structured', projectTrusted: boolean) {
	return createChildResources(
		{
			cwd,
			projectTrusted,
			...(variant === 'structured' ? { appendSystemPrompt: [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] } : {}),
		},
	);
}

interface WorkflowToolSession {
	getAllTools(): Array<{ name: string }>;
	getToolDefinition(name: string): ToolDefinition | undefined;
	subscribe(listener: AgentSessionEventListener): () => void;
}

/**
 * The minimal `AgentSession` lifecycle `runAgent()` depends on: creation
 * output, message/model/context inspection, event subscription, prompting,
 * abort, and disposal. `Pick`s off `AgentSession`'s public method/property
 * types instead of naming its private fields, so a plain object literal
 * satisfies this type structurally and can stand in for a real session in
 * tests without a cast. `extensionRunner` is narrowed to the concrete
 * `session_shutdown` shape (mirroring `shared/child-session.ts`'s
 * `ChildExtensionRunner`) rather than `AgentSession["extensionRunner"]`'s
 * generic `emit`, which only a real `ExtensionRunner` can implement.
 */
export type WorkflowAgentSession = WorkflowToolSession &
	Pick<AgentSession, 'model' | 'messages' | 'getContextUsage' | 'bindExtensions' | 'prompt' | 'abort' | 'dispose'> & {
		readonly extensionRunner: {
			hasHandlers(eventType: string): boolean;
			emit(event: SessionShutdownEvent): Promise<unknown>;
		};
	};

/** Test-only seam for session creation; the production default is `createAgentSession`. */
export type CreateWorkflowAgentSession = (options: CreateAgentSessionOptions) => Promise<{ session: WorkflowAgentSession }>;

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(session: WorkflowToolSession, timeoutMs?: number) {
	const guard = createToolCallTimeoutGuard(timeoutMs);

	guard.apply(session);

	return session.subscribe((event) => {
		if (event.type === 'agent_start') {
			guard.apply(session);
		}
	});
}

function isJsonSchema(value: unknown): value is TSchema {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	const seen = new WeakSet<object>();

	let nodes = 0;

	const validate = (current: unknown, depth: number): boolean => {
		if (++nodes > 10_000 || depth > 24) {
			return false;
		}

		if (current === null || typeof current === 'string' || typeof current === 'boolean') {
			return true;
		}

		if (typeof current === 'number') {
			return Number.isFinite(current);
		}

		if (Array.isArray(current)) {
			return current.every((item) => validate(item, depth + 1));
		}

		if (typeof current !== 'object') {
			return false;
		}

		if (seen.has(current)) {
			return false;
		}

		seen.add(current);

		return Object.keys(current).every((key) => {
			if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
				return false;
			}

			return validate((current as Record<string, unknown>)[key], depth + 1);
		});
	};

	return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
	if (!isJsonSchema(schema)) {
		throw new Error('structured output schema must be a bounded JSON object');
	}

	return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(schema: unknown, capture: (value: unknown) => void): ToolDefinition {
	return defineTool(
		{
			name: 'structured_output',
			label: 'Structured Output',
			description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
			parameters: jsonSchemaToTypebox(schema),
			async execute(_toolCallId, params) {
				capture(params);

				return {
					content: [{ type: 'text', text: 'Recorded structured result.' }],
					details: params,
					terminate: true,
				};
			},
		},
	);
}

/**
 * Joined, trimmed text of an assistant message's text parts (empty when the
 * message has none, e.g. a tool-call-only turn). Shared by the full-rescan
 * `finalOutput()` and the incremental `IncrementalProgressTracker` so both
 * agree on what counts as "the latest assistant output".
 */
export { assistantText, computeUsage, finalOutput, IncrementalProgressTracker, recordToolExecutionTiming, transcriptFromMessages } from './runner/progress.ts';
export type { ToolExecutionTiming } from './runner/progress.ts';
import { computeUsage, finalOutput, IncrementalProgressTracker, recordToolExecutionTiming, transcriptFromMessages } from './runner/progress.ts';
import type { ToolExecutionTiming } from './runner/progress.ts';

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

function formatTimeout(timeoutMs: number) {
	return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs} ms`;
}

/** Abort a provider call that opens but never emits its first assistant event. */
export function createFirstResponseWatchdog(onTimeout: () => Promise<unknown>, options: { timeoutMs?: number; model?: string } = {}) {
	const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;

	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			timer = undefined;

			const model = options.model ? ` for ${options.model}` : '';

			reject(new Error(`Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`));
			void onTimeout().catch(() => {});
		}, timeoutMs);
		timer.unref?.();
	});

	const cancel = () => {
		if (timer) {
			clearTimeout(timer);
		}

		timer = undefined;
	};

	return {
		markResponse: cancel,
		async waitFor<T>(operation: Promise<T>) {
			try {
				return await Promise.race([operation, timeout]);
			} finally {
				cancel();
			}
		},
	};
}

function isAssistantResponseEvent(event: AgentSessionEvent) {
	return (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant';
}

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
	let structured: unknown;
	let customTools: ToolDefinition[] | undefined;
	let session: WorkflowAgentSession | undefined;
	let unsubscribeToolTimeout: (() => void) | undefined;

	const createSession = options.createSession ?? createAgentSession;

	try {
		customTools =
			options.schema !== undefined
				? [
						makeStructuredOutputTool(options.schema, (value) => {
							structured = value;
						}),
					]
				: undefined;

		({ session } = await createSession(
			{
				cwd: options.cwd,
				...(options.model ? { model: options.model } : {}),
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
				resourceLoader: options.loader,
				settingsManager: options.settingsManager,
				sessionManager: SessionManager.inMemory(options.cwd),
				...(customTools ? { customTools } : {}),
				...childToolPolicy(),
			},
		));

		await bindChildSessionExtensions(session);

		unsubscribeToolTimeout = guardWorkflowChildTools(session, options.toolCallTimeoutMs);
	} catch (error) {
		unsubscribeToolTimeout?.();

		if (session) {
			await shutdownAndDisposeChildSession(session);
		}

		return {
			ok: false,
			output: '',
			error: `Failed to create agent session: ${errorText(error)}`,
			aborted: false,
			usage: emptyUsage(),
			model: options.model?.id,
			contextWindow: options.model?.contextWindow,
			transcript: [],
		};
	}

	const childSession = session;

	let usage = emptyUsage();
	let modelId = childSession.model?.id ?? options.model?.id;
	let contextWindow = childSession.model?.contextWindow;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	const toolTimings = new Map<string, ToolExecutionTiming>();

	const sync = () => {
		const messages = childSession.messages;

		usage = computeUsage(messages);

		const sessionModel = childSession.model;

		modelId = sessionModel?.id ?? modelId;
		contextWindow = sessionModel?.contextWindow ?? contextWindow;

		const context = childSession.getContextUsage();

		if (typeof context?.tokens === 'number' && Number.isFinite(context.tokens) && context.tokens >= 0) {
			usage.contextTokens = context.tokens;
		}

		if (typeof context?.contextWindow === 'number' && Number.isFinite(context.contextWindow) && context.contextWindow > 0) {
			contextWindow = context.contextWindow;
		}

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];

			if (msg.role !== 'assistant') {
				continue;
			}
			// Some gateways report a concrete fallback model. Prefer its registry
			// metadata when available so capacity tracks the model that served the
			// latest response rather than a hardcoded/configured guess.
			const responseMatchesSession = !sessionModel || (msg.provider === sessionModel.provider && msg.model === sessionModel.id);

			const reportedId = msg.responseModel ?? msg.model;

			const reportedModel = responseMatchesSession ? options.modelRegistry.find(msg.provider, reportedId) : undefined;

			if (reportedModel) {
				modelId = reportedModel.id;
				contextWindow = reportedModel.contextWindow;
			}

			if (msg.stopReason) {
				stopReason = msg.stopReason;
			}

			if (msg.errorMessage) {
				errorMessage = msg.errorMessage;
			}

			break;
		}
	};

	const progress = new IncrementalProgressTracker(modelId, contextWindow);

	const applyProgressContextUsage = () => {
		progress.applyContextUsage(childSession.getContextUsage());
	};

	let markFirstResponse = () => {};

	const unsubscribe = childSession.subscribe((event) => {
		if (isAssistantResponseEvent(event)) {
			markFirstResponse();
		}

		const sessionModel = childSession.model;

		if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
			recordToolExecutionTiming(toolTimings, event);
			progress.patchToolTiming(event.toolCallId, toolTimings);
		} else if (event.type === 'message_end') {
			progress.observeMessage(event.message, sessionModel, options.modelRegistry, toolTimings);
		} else if (event.type === 'compaction_end') {
			// The session replaced its whole message array (summary + surviving
			// tail); refold from scratch instead of trusting stale indexes/totals.
			progress.rebuild(childSession.messages, toolTimings, sessionModel, options.modelRegistry);
		} else {
			return;
		}

		applyProgressContextUsage();
		options.onProgress?.({
			preview: progress.preview,
			usage: progress.usage,
			model: progress.modelId,
			contextWindow: progress.contextWindow,
			transcript: progress.transcript(),
		});
	});

	let aborted = false;
	let abortPromise: Promise<void> | undefined;

	const onAbort = () => {
		aborted = true;
		abortPromise ??= childSession.abort().catch(() => {});
	};

	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	let output = '';
	let transcript: TranscriptEntry[] = [];

	try {
		if (!aborted) {
			const watchdog = createFirstResponseWatchdog(
				() => childSession.abort(),
				{
					timeoutMs: options.firstResponseTimeoutMs,
					model: modelId,
				},
			);

			markFirstResponse = watchdog.markResponse;

			await watchdog.waitFor(childSession.prompt(buildWorkflowAgentPrompt(options.prompt)));
		}
	} catch (error) {
		errorMessage = errorMessage ?? errorText(error);
		stopReason = stopReason ?? 'error';
	} finally {
		options.signal?.removeEventListener('abort', onAbort);

		if (abortPromise) {
			await abortPromise;
		}

		unsubscribe();
		unsubscribeToolTimeout?.();
		sync();
		output = truncateUtf8(
			finalOutput(childSession.messages),
			AGENT_OUTPUT_MAX_BYTES,
		);
		transcript = transcriptFromMessages(childSession.messages, toolTimings);

		await shutdownAndDisposeChildSession(childSession);
	}

	if (aborted || stopReason === 'aborted') {
		return {
			ok: false,
			output,
			structured,
			error: 'Agent was aborted',
			aborted: true,
			usage,
			model: modelId,
			contextWindow,
			transcript,
		};
	}

	const failed = stopReason === 'error' || errorMessage !== undefined;

	if (failed) {
		return {
			ok: false,
			output,
			structured,
			error: errorMessage ?? 'Agent failed',
			aborted: false,
			usage,
			model: modelId,
			contextWindow,
			transcript,
		};
	}

	if (options.schema !== undefined && structured === undefined) {
		return {
			ok: false,
			output,
			error: 'Agent finished without calling structured_output; no structured result matching the schema was produced.',
			aborted: false,
			usage,
			model: modelId,
			contextWindow,
			transcript,
		};
	}

	return {
		ok: true,
		output,
		structured,
		aborted: false,
		usage,
		model: modelId,
		contextWindow,
		transcript,
	};
}
