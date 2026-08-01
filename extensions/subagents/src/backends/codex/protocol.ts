import type { ReasoningEffort } from '../../domain.ts';

/** JSON object accepted by the Codex app-server protocol. */
export type JsonRecord = Record<string, unknown>;

const PREVIEW_MAX_LENGTH = 1_024;

/** Pure Codex protocol parsing, formatting, and option mapping. */
export class CodexProtocol {
	private constructor() {}

	/** Narrow unknown input to a JSON object. */
	static record(value: unknown): JsonRecord | undefined {
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
	}

	/** Read a string property safely. */
	static stringValue(value: unknown) {
		return typeof value === 'string' ? value : undefined;
	}

	/** Read a finite numeric property safely. */
	static numberValue(value: unknown) {
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}

	/** Read a boolean property safely. */
	static booleanValue(value: unknown) {
		return typeof value === 'boolean' ? value : undefined;
	}

	/** Read all object values from an unknown array. */
	static records(value: unknown) {
		return Array.isArray(value) ? value.map(this.record).filter((item): item is JsonRecord => item !== undefined) : [];
	}

	/** Read all string values from an unknown array. */
	static strings(value: unknown) {
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	}

	/** Serialize a value into a bounded one-line preview. */
	static safeJson(value: unknown) {
		try {
			const text = JSON.stringify(value);

			return text === undefined ? undefined : text.slice(0, PREVIEW_MAX_LENGTH);
		} catch {
			return undefined;
		}
	}

	/** Return the first useful line of a protocol value. */
	static firstLine(value: unknown) {
		if (typeof value !== 'string') {
			return undefined;
		}

		const line = value.split('\n').find((candidate) => candidate.trim());

		return line?.trim().slice(0, PREVIEW_MAX_LENGTH);
	}

	/** Bound an external error for model-facing output. */
	static boundedError(error: unknown) {
		return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
	}

	/** Convert a JSON-RPC error payload into a safe message. */
	static protocolError(value: unknown) {
		const error = this.record(value);

		return this.boundedError(this.stringValue(error?.message) ?? this.safeJson(value) ?? 'Codex app-server request failed');
	}

	/** Map shared reasoning effort to Codex's supported scale. */
	static preferredEffort(effort: ReasoningEffort | undefined) {
		switch (effort) {
			case 'off':

			case 'minimal':
				return 'minimal';

			case 'low':

			case 'medium':

			case 'high':
				return effort;

			case 'xhigh':

			case 'max':
				return 'xhigh';

			case undefined:
				return undefined;
		}
	}

	/** Clamp effort to the capabilities reported by the selected model. */
	static supportedEffort(effort: ReasoningEffort | undefined, modelLabel: string | undefined, modelList: JsonRecord | undefined) {
		const preferred = this.preferredEffort(effort);

		if (!preferred) {
			return undefined;
		}

		const models = this.records(modelList?.data);

		const model =
			models.find((candidate) => this.stringValue(candidate.id) === modelLabel || this.stringValue(candidate.model) === modelLabel) ?? models.find((candidate) => candidate.isDefault === true);

		if (!model) {
			return preferred;
		}

		const supported = this.records(model.supportedReasoningEfforts)
			.map((option) => this.stringValue(option.reasoningEffort))
			.filter((value): value is string => value !== undefined);

		if (supported.includes(preferred)) {
			return preferred;
		}

		const scale = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
		const target = scale.indexOf(preferred);

		const candidates = supported
			.map((value) => ({ value, index: scale.indexOf(value as (typeof scale)[number]) }))
			.filter((candidate) => candidate.index >= 0)
			.sort((a, b) => {
				const distance = Math.abs(a.index - target) - Math.abs(b.index - target);

				if (distance !== 0) {
					return distance;
				}

				return effort === 'off' ? a.index - b.index : b.index - a.index;
			});

		return candidates[0]?.value ?? preferred;
	}

	/** Return trust-gated Codex sandbox settings. */
	static sandboxOptions(trusted: boolean) {
		return trusted ? ({ approvalPolicy: 'never', sandbox: 'danger-full-access' } as const) : ({ approvalPolicy: 'never', sandbox: 'workspace-write' } as const);
	}

	/** Build a Codex text input item. */
	static textInput(text: string) {
		return { type: 'text', text, text_elements: [] };
	}

	/** Parse the latest Codex context-window usage payload. */
	static threadTokenUsage(params: unknown) {
		const usage = this.record(this.record(params)?.tokenUsage);
		const last = this.record(usage?.last);

		return { tokens: this.numberValue(last?.totalTokens), contextWindow: this.numberValue(usage?.modelContextWindow) };
	}

	/** Render changed file paths in a tool preview. */
	static fileChangePreview(item: JsonRecord) {
		const paths = this.records(item.changes)
			.map((change) => this.stringValue(change.path))
			.filter((value): value is string => value !== undefined);

		return paths.length > 0 ? paths.join(', ').slice(0, PREVIEW_MAX_LENGTH) : undefined;
	}

	/** Describe a Codex tool item in normalized terms. */
	static toolDescription(item: JsonRecord): { id: string; name: string; args?: string } | undefined {
		const id = this.stringValue(item.id);
		const type = this.stringValue(item.type);

		if (!id || !type) {
			return undefined;
		}

		switch (type) {
			case 'commandExecution':
				return { id, name: 'shell', args: this.firstLine(item.command) };

			case 'fileChange':
				return { id, name: 'apply_patch', args: this.fileChangePreview(item) };

			case 'webSearch':
				return { id, name: 'web_search', args: this.firstLine(item.query) };

			case 'mcpToolCall': {
				const server = this.stringValue(item.server);
				const tool = this.stringValue(item.tool) ?? 'tool';

				return { id, name: server ? `${server}/${tool}` : tool, args: this.safeJson(item.arguments) };
			}

			case 'dynamicToolCall': {
				const namespace = this.stringValue(item.namespace);
				const tool = this.stringValue(item.tool) ?? 'tool';

				return { id, name: namespace ? `${namespace}/${tool}` : tool, args: this.safeJson(item.arguments) };
			}

			default:
				return undefined;
		}
	}

	/** Render a Codex tool result. */
	static toolOutput(item: JsonRecord, buffered: string) {
		switch (this.stringValue(item.type)) {
			case 'commandExecution':
				return this.stringValue(item.aggregatedOutput) ?? buffered;

			case 'fileChange':
				return this.fileChangePreview(item);

			case 'webSearch':
				return this.stringValue(item.query);

			case 'mcpToolCall':
				return this.safeJson(item.result ?? item.error);

			case 'dynamicToolCall': {
				const text = this.records(item.contentItems)
					.map((content) => this.stringValue(content.text))
					.filter((value): value is string => value !== undefined)
					.join('\n');

				return text || this.safeJson(item.contentItems);
			}

			default:
				return buffered;
		}
	}

	/** Determine whether a Codex item represents a failed tool call. */
	static toolFailed(item: JsonRecord) {
		const status = this.stringValue(item.status);
		const exitCode = this.numberValue(item.exitCode);
		const success = this.booleanValue(item.success);

		return (exitCode !== undefined && exitCode !== 0) || success === false || status === 'failed' || status === 'declined' || status === 'cancelled';
	}
}
