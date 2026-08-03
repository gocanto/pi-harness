import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { TranscriptPart } from '../../domain.ts';
import { PiProtocol } from './protocol.ts';

/** Converts pi-native messages into the normalized subagent transcript shape. */
export class PiTranscript {
	/** Return the supported native role, if the value is a pi message. */
	static messageRole(msg: unknown): Message['role'] | undefined {
		if (!this.isRecord(msg)) {
			return undefined;
		}

		const role = msg.role;

		if (role === 'user' || role === 'assistant' || role === 'toolResult') {
			return role;
		}

		return undefined;
	}

	/** Find the last assistant message in a session transcript. */
	static lastAssistantMessage(session: AgentSession) {
		const messages = session.messages;

		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = this.assistantMessage(messages[index]);

			if (message) {
				return message;
			}
		}

		return undefined;
	}

	/** Return the last non-empty assistant text, matching v1 finalOutput. */
	static finalOutput(session: AgentSession) {
		const messages = session.messages;

		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = this.assistantMessage(messages[index]);

			if (!message) {
				continue;
			}

			const text = message.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n')
				.trim();

			if (text) {
				return text;
			}
		}

		return '';
	}

	/** Convert assistant text, thinking, and tool calls to transcript parts. */
	static assistantParts(message: AssistantMessage): TranscriptPart[] {
		const parts: TranscriptPart[] = [];

		for (const part of message.content) {
			if (part.type === 'text') {
				parts.push({ type: 'text', text: part.text });
			} else if (part.type === 'thinking') {
				parts.push({
					type: 'thinking',
					text: part.redacted ? '' : part.thinking,
					redacted: part.redacted,
				});
			} else if (part.type === 'toolCall') {
				parts.push({
					type: 'toolCall',
					toolId: part.id,
					name: part.name,
					argsPreview: PiProtocol.safeJson(part.arguments),
				});
			}
		}

		return parts;
	}

	/** Extract user-visible text from a native user message. */
	static userText(message: unknown) {
		if (!this.isRecord(message)) {
			return '';
		}

		const content = message.content;

		if (typeof content === 'string') {
			return content;
		}

		if (!Array.isArray(content)) {
			return '';
		}

		return content
			.filter((part): part is { type: 'text'; text: string } => this.isRecord(part) && part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text)
			.join('\n');
	}

	/** Narrow a native message to an assistant message by its role discriminator. */
	static assistantMessage(message: unknown): AssistantMessage | undefined {
		if (!this.isRecord(message) || message.role !== 'assistant') {
			return undefined;
		}

		// SAFETY: AgentSession messages and message_end events use pi's role
		// discriminator; the SDK guarantees the assistant payload for this role.
		return message as unknown as AssistantMessage;
	}

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}
}
