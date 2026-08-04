import type { ContextUsage, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentUsage, TranscriptEntry } from '@workflows/model.ts';
import { emptyUsage } from '@workflows/model.ts';
import type { WorkflowModel } from '@workflows/runner.ts';
import { safeStringify, truncateUtf8 } from '@workflows/serialization.ts';

const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

type AgentMessage = AgentSession['messages'][number];

type ToolTimingEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' | 'tool_execution_end' }>;

/** Lifecycle timings associated with one tool call. */
export interface ToolExecutionTiming {
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
}

/** Record tool lifecycle timing without inferring completion from timestamps. */
const observedTimes = new WeakMap<object, number>();

export function recordToolExecutionTiming(timings: Map<string, ToolExecutionTiming>, event: ToolTimingEvent, observedAt?: number) {
	const timestamp = observedAt ?? observedTimes.get(event) ?? Date.now();

	observedTimes.set(event, timestamp);

	const previous = timings.get(event.toolCallId);

	if (event.type === 'tool_execution_start') {
		if (previous?.startedAt !== undefined) {
			return;
		}

		timings.set(event.toolCallId, { ...previous, startedAt: timestamp });

		return;
	}

	if (previous?.finishedAt !== undefined) {
		return;
	}

	const durationMs = previous?.startedAt === undefined ? undefined : Math.max(0, timestamp - previous.startedAt);

	timings.set(event.toolCallId, {
		...previous,
		finishedAt: timestamp,
		...(durationMs === undefined ? {} : { durationMs }),
	});
}

/** Joined text from an assistant message's text parts. */
export function assistantText(message: Extract<AgentMessage, { role: 'assistant' }>) {
	return message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
		.trim();
}

/** Most recent non-empty assistant response in a message history. */
export function finalOutput(messages: AgentMessage[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];

		if (message?.role !== 'assistant') {
			continue;
		}

		const text = assistantText(message);

		if (text) {
			return text;
		}
	}

	return '';
}

function safeJson(value: unknown) {
	return safeStringify(
		value,
		{
			maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
			maxDepth: 12,
			maxNodes: 2_000,
		},
	);
}

function toolMetadata(toolCallId: string, timings: ReadonlyMap<string, ToolExecutionTiming>) {
	const timing = timings.get(toolCallId);

	return {
		toolCallId: truncateUtf8(toolCallId, 1024),
		...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
		...(timing?.finishedAt === undefined ? {} : { finishedAt: timing.finishedAt }),
		...(timing?.durationMs === undefined ? {} : { durationMs: timing.durationMs }),
	};
}

function entriesForMessage(message: AgentMessage, toolTimings: ReadonlyMap<string, ToolExecutionTiming>): TranscriptEntry[] {
	if (message.role === 'user') {
		const text = typeof message.content === 'string' ? message.content : message.content.map((part) => (part.type === 'text' ? part.text : `[image: ${part.mimeType}]`)).join('\n');

		return text.trim() ? [{ role: 'user', text, timestamp: message.timestamp }] : [];
	}

	if (message.role === 'assistant') {
		const entries: TranscriptEntry[] = [];

		for (const part of message.content) {
			if (part.type === 'text' && part.text.trim()) {
				entries.push({ role: 'assistant', text: part.text, timestamp: message.timestamp });
			} else if (part.type === 'thinking' && part.thinking.trim()) {
				entries.push({ role: 'thinking', text: part.thinking, timestamp: message.timestamp });
			} else if (part.type === 'toolCall') {
				entries.push({ role: 'tool', name: part.name, text: safeJson(part.arguments), timestamp: message.timestamp, ...toolMetadata(part.id, toolTimings) });
			}
		}

		return entries;
	}

	if (message.role !== 'toolResult') {
		return [];
	}

	return [
		{
			role: 'toolResult',
			name: message.toolName,
			text: message.content.map((part) => (part.type === 'text' ? part.text : `[image: ${part.mimeType}]`)).join('\n'),
			isError: message.isError,
			timestamp: message.timestamp,
			...toolMetadata(message.toolCallId, toolTimings),
		},
	];
}

function boundTranscriptEntries(entries: TranscriptEntry[]) {
	const selected = entries.length <= TRANSCRIPT_MAX_ENTRIES ? entries : [entries[0], ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
	const bounded: TranscriptEntry[] = [];

	let totalBytes = 0;

	for (const entry of selected) {
		const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;

		if (remaining <= 0) {
			break;
		}

		const text = truncateUtf8(
			entry.text,
			Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
		);

		totalBytes += Buffer.byteLength(text, 'utf8');
		bounded.push({ ...entry, text: text === entry.text ? text : `${text}\n[transcript entry truncated]` });
	}

	if (bounded.length < entries.length) {
		bounded.push({ role: 'toolResult', name: 'transcript', text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]` });
	}

	return bounded;
}

/** Convert agent messages into the bounded transcript shown by workflow UIs. */
export function transcriptFromMessages(messages: AgentMessage[], toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map()) {
	return boundTranscriptEntries(
		messages.flatMap((message) => entriesForMessage(message, toolTimings)),
	);
}

function foldAssistantUsage(usage: AgentUsage, message: AgentMessage) {
	if (message.role !== 'assistant') {
		return;
	}

	usage.turns++;

	const current = message.usage;

	if (!current) {
		return;
	}

	usage.input += current.input || 0;
	usage.output += current.output || 0;
	usage.cacheRead += current.cacheRead || 0;
	usage.cacheWrite += current.cacheWrite || 0;
	usage.cost += current.cost?.total || 0;
}

/** Calculate aggregate usage from an agent message history. */
export function computeUsage(messages: AgentMessage[]) {
	const usage = emptyUsage();

	for (const message of messages) {
		foldAssistantUsage(usage, message);
	}

	return usage;
}

function assistantSyncInfo(message: Extract<AgentMessage, { role: 'assistant' }>, sessionModel: WorkflowModel | undefined, modelRegistry: ExtensionContext['modelRegistry']) {
	const responseMatchesSession = !sessionModel || (message.provider === sessionModel.provider && message.model === sessionModel.id);
	const reportedId = message.responseModel ?? message.model;
	const reportedModel = responseMatchesSession ? modelRegistry.find(message.provider, reportedId) : undefined;

	return {
		...(reportedModel ? { modelId: reportedModel.id, contextWindow: reportedModel.contextWindow } : {}),
		...(message.stopReason ? { stopReason: message.stopReason } : {}),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
	};
}

/** Incrementally maintains usage, preview, model metadata, and transcript state. */
export class IncrementalProgressTracker {
	private _usage: AgentUsage = emptyUsage();
	private _modelId?: string;
	private _contextWindow?: number;
	private _stopReason?: string;
	private _errorMessage?: string;
	private _preview = '';
	private _entries: TranscriptEntry[] = [];
	private readonly _toolEntryIndexes = new Map<string, number[]>();

	constructor(modelId?: string, contextWindow?: number) {
		this._modelId = modelId;
		this._contextWindow = contextWindow;
	}

	get usage() {
		return this._usage;
	}

	get modelId() {
		return this._modelId;
	}

	get contextWindow() {
		return this._contextWindow;
	}

	get stopReason() {
		return this._stopReason;
	}

	get errorMessage() {
		return this._errorMessage;
	}

	get preview() {
		return this._preview;
	}

	/** Return the same bounded transcript shape as the full rescan. */
	transcript() {
		return boundTranscriptEntries(this._entries);
	}

	/** Overlay live context-window occupancy onto the running usage state. */
	applyContextUsage(context: ContextUsage | undefined) {
		if (typeof context?.tokens === 'number' && Number.isFinite(context.tokens) && context.tokens >= 0) {
			this._usage.contextTokens = context.tokens;
		}

		if (typeof context?.contextWindow === 'number' && Number.isFinite(context.contextWindow) && context.contextWindow > 0) {
			this._contextWindow = context.contextWindow;
		}
	}

	/** Fold one finalized message into the running state. */
	observeMessage(message: AgentMessage, sessionModel: WorkflowModel | undefined, modelRegistry: ExtensionContext['modelRegistry'], toolTimings: ReadonlyMap<string, ToolExecutionTiming>) {
		if (message.role === 'assistant') {
			foldAssistantUsage(this._usage, message);

			const info = assistantSyncInfo(message, sessionModel, modelRegistry);

			if (info.modelId !== undefined) {
				this._modelId = info.modelId;
			}

			if (info.contextWindow !== undefined) {
				this._contextWindow = info.contextWindow;
			}

			if (info.stopReason !== undefined) {
				this._stopReason = info.stopReason;
			}

			if (info.errorMessage !== undefined) {
				this._errorMessage = info.errorMessage;
			}

			const text = assistantText(message);

			if (text) {
				this._preview = text;
			}
		}

		this.appendEntries(entriesForMessage(message, toolTimings));
	}

	/** Refresh timing metadata for an already-recorded tool entry. */
	patchToolTiming(toolCallId: string, toolTimings: ReadonlyMap<string, ToolExecutionTiming>) {
		const indexes = this._toolEntryIndexes.get(toolCallId);

		if (!indexes) {
			return;
		}

		const metadata = toolMetadata(toolCallId, toolTimings);

		for (const index of indexes) {
			const entry = this._entries[index];

			if (entry) {
				this._entries[index] = { ...entry, ...metadata };
			}
		}
	}

	/** Rebuild state after compaction or message-history replacement. */
	rebuild(messages: AgentMessage[], toolTimings: ReadonlyMap<string, ToolExecutionTiming>, sessionModel: WorkflowModel | undefined, modelRegistry: ExtensionContext['modelRegistry']) {
		this._usage = emptyUsage();
		this._preview = '';
		this._entries = [];
		this._toolEntryIndexes.clear();

		for (const message of messages) {
			this.observeMessage(message, sessionModel, modelRegistry, toolTimings);
		}
	}

	private appendEntries(entries: TranscriptEntry[]) {
		for (const entry of entries) {
			const index = this._entries.length;

			this._entries.push(entry);
			if (entry.toolCallId) {
				const indexes = this._toolEntryIndexes.get(entry.toolCallId) ?? [];

				indexes.push(index);
				this._toolEntryIndexes.set(entry.toolCallId, indexes);
			}
		}
	}
}
