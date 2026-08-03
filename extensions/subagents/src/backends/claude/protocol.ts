import * as os from 'node:os';
import * as path from 'node:path';
import type { SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptPart } from '../../domain.ts';

const PREVIEW_MAX_LENGTH = 4_096;

/** Pure Claude message parsing and bounded preview formatting. */
export class ClaudeProtocol {
	private constructor() {}

	/** Bound an external error for normalized backend events. */
	static boundedError(error: unknown) {
		return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
	}

	/** Flatten text to a bounded single-line preview. */
	static singleLine(text: string) {
		const flattened = text.replace(/\s+/g, ' ').trim();

		return flattened ? flattened.slice(0, PREVIEW_MAX_LENGTH) : undefined;
	}

	/** Serialize a value into a bounded preview. */
	static safeJson(value: unknown) {
		try {
			const text = JSON.stringify(value);

			if (!text || text === '{}') {
				return undefined;
			}

			return this.singleLine(text);
		} catch {
			return undefined;
		}
	}

	/** Extract visible text from a Claude tool result payload. */
	static outputPreview(value: unknown): string | undefined {
		if (typeof value === 'string') {
			return this.singleLine(value);
		}

		if (Array.isArray(value)) {
			const text = value
				.flatMap((part) => {
					if (!part || typeof part !== 'object') {
						return [];
					}

					const record = part as { type?: unknown; text?: unknown };

					return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
				})
				.join(' ');

			return this.singleLine(text) ?? this.safeJson(value);
		}

		return this.safeJson(value);
	}

	/** Normalize assistant content blocks into transcript parts. */
	static assistantParts(message: SDKAssistantMessage): TranscriptPart[] {
		const parts: TranscriptPart[] = [];

		for (const block of message.message.content) {
			if (block.type === 'text') {
				parts.push({ type: 'text', text: block.text });
			} else if (block.type === 'thinking') {
				parts.push({ type: 'thinking', text: block.thinking });
			} else if (block.type === 'redacted_thinking') {
				parts.push({ type: 'thinking', text: '', redacted: true });
			} else if (block.type === 'tool_use') {
				parts.push({ type: 'toolCall', toolId: block.id, name: block.name, argsPreview: this.safeJson(block.input) });
			}
		}

		return parts;
	}

	/** Locate the persisted Claude session transcript. */
	static sessionFilePath(cwd: string, sessionId: string) {
		const projectDirectory = cwd.replace(/[/.]/g, '-');

		return path.join(os.homedir(), '.claude', 'projects', projectDirectory, `${sessionId}.jsonl`);
	}

	/** Calculate current context occupancy from one assistant request. */
	static contextOccupancyTokens(
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
		if (!usage || typeof usage.input_tokens !== 'number') {
			return undefined;
		}

		const count = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

		return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
	}

	/** Read a model's reported context-window capacity. */
	static resultContextWindow(result: SDKResultMessage) {
		return Object.values(result.modelUsage)[0]?.contextWindow;
	}
}
