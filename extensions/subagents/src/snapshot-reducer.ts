import type { BackendName, LiveToolState, RunOutcome, QueuedMessage, SubagentEvent, SubagentMeta, SubagentOrigin, SubagentStatus, TranscriptItem } from './domain.ts';

const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;

/** Mutable state owned by a single subagent entry while it is being reduced. */
export interface MutableSubagentSnapshot {
	id: string;
	origin: SubagentOrigin;
	backend: BackendName;
	title: string;
	prompt: string;
	cwd: string;
	status: SubagentStatus;
	createdAt: number;
	settledAt?: number;
	errorText?: string;
	meta: SubagentMeta;
	usage: { tokens?: number; contextWindow?: number };
	transcript: TranscriptItem[];
	liveAssistant?: { text: string; thinking: string };
	liveTools: LiveToolState[];
	queued: ReadonlyArray<QueuedMessage>;
	finalText: string;
	turns: number;
}

/**
 * Reduces backend events into the public subagent snapshot.
 *
 * This object deliberately knows nothing about Effect, persistence, or UI. It
 * owns only transcript/state-transition rules, while the manager owns process
 * lifecycles, scheduling, and notifications.
 */
export class SubagentSnapshotReducer {
	constructor(
		private readonly snapshot: MutableSubagentSnapshot,
		private readonly liveToolMap: Map<string, LiveToolState>,
		private readonly settle: (outcome: RunOutcome) => void,
		private readonly notify: () => void,
		private readonly onRunStarted?: () => void,
	) {}

	/** Apply one normalized backend event to the snapshot. */
	apply(event: SubagentEvent) {
		switch (event._tag) {
			case 'RunStarted':
				this.onRunStarted?.();
				this.snapshot.status = 'running';
				this.snapshot.settledAt = undefined;
				this.snapshot.errorText = undefined;
				break;

			case 'RunSettled':
				this.settle(event.outcome);

				return;

			case 'UserMessage':
				this.appendTranscript({
					kind: 'user',
					text: this.boundedTranscript(event.text),
				});
				break;

			case 'AssistantDelta': {
				const live = this.snapshot.liveAssistant ?? { text: '', thinking: '' };

				this.snapshot.liveAssistant =
					event.kind === 'text'
						? {
								...live,
								text: (live.text + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH),
							}
						: {
								...live,
								thinking: (live.thinking + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH),
							};
				break;
			}

			case 'AssistantMessage':
				this.appendTranscript({
					kind: 'assistant',
					parts: event.parts.map((part) =>
						part.type === 'toolCall'
							? {
									...part,
									argsPreview: part.argsPreview ? this.boundedTranscript(part.argsPreview) : undefined,
								}
							: { ...part, text: this.boundedTranscript(part.text) },
					),
				});
				this.snapshot.liveAssistant = undefined;
				this.snapshot.turns += 1;
				break;

			case 'ToolStart':
				this.liveToolMap.set(event.toolId, {
					toolId: event.toolId,
					name: event.name,
					argsPreview: event.argsPreview ? this.boundedTranscript(event.argsPreview) : undefined,
				});
				this.snapshot.liveTools = [...this.liveToolMap.values()];
				break;

			case 'ToolUpdate': {
				const current = this.liveToolMap.get(event.toolId);

				if (current) {
					this.liveToolMap.set(event.toolId, {
						...current,
						outputPreview: event.outputPreview ? this.boundedTranscript(event.outputPreview) : current.outputPreview,
					});
					this.snapshot.liveTools = [...this.liveToolMap.values()];
				}

				break;
			}

			case 'ToolEnd':
				this.liveToolMap.delete(event.toolId);
				this.snapshot.liveTools = [...this.liveToolMap.values()];
				this.appendTranscript({
					kind: 'toolResult',
					toolId: event.toolId,
					name: event.name,
					isError: event.isError,
					outputPreview: event.outputPreview ? this.boundedTranscript(event.outputPreview) : undefined,
				});
				break;

			case 'QueueChanged':
				this.snapshot.queued = event.queued;
				break;

			case 'UsageChanged':
				this.snapshot.usage = {
					tokens: event.tokens ?? this.snapshot.usage.tokens,
					contextWindow: event.contextWindow ?? this.snapshot.usage.contextWindow,
				};
				break;

			case 'MetaChanged':
				this.snapshot.meta = { ...this.snapshot.meta, ...event.meta };
				break;

			case 'BackendError':
				this.snapshot.errorText = this.bounded(event.message);
				break;
		}

		this.notify();
	}

	private appendTranscript(item: TranscriptItem) {
		this.snapshot.transcript.push(item);
		if (this.snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
			this.snapshot.transcript.splice(0, this.snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS);
		}
	}

	private bounded(text: string) {
		return text.slice(0, ERROR_TEXT_MAX_LENGTH);
	}

	private boundedTranscript(text: string) {
		return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
	}
}
