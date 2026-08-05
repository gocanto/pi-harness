import type { AgentSession } from '@earendil-works/pi-coding-agent';

import { DefaultResourceLoader, getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

/** Maximum time allowed for child shutdown hooks and aborts. */
export const PI_CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless children must not receive. */
export const PI_CHILD_EXCLUDED_TOOL_NAMES = ['subagent_spawn', 'subagent_wait', 'subagent_cancel', 'subagent_check', 'subagent_list', 'workflow', 'ask_user'] as const;

/** Loads global/package resources and trust-gated project resources for a child. */
export class PiChildResources {
	/** Load resources for a child working directory. */
	static async create(cwd: string, projectTrusted: boolean) {
		const agentDir = getAgentDir();

		const settingsManager = SettingsManager.create(cwd, agentDir, {
			projectTrusted,
		});

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
		});

		await loader.reload();

		return { loader, settingsManager };
	}
}

/** Performs bounded, best-effort shutdown of a child pi session. */
export class PiChildSessionLifecycle {
	/** Abort a child session with a bounded wait. */
	static async abort(session: AgentSession) {
		await this.waitBounded(session.abort(), PI_CHILD_SHUTDOWN_TIMEOUT_MS);
	}

	/** Emit the child shutdown hook and dispose the session without throwing. */
	static async shutdownAndDispose(session: AgentSession) {
		try {
			if (session.extensionRunner.hasHandlers('session_shutdown')) {
				await this.waitBounded(
					session.extensionRunner.emit({
						type: 'session_shutdown',
						reason: 'quit',
					}),
					PI_CHILD_SHUTDOWN_TIMEOUT_MS,
				);
			}
		} catch {
			// Extension runner inspection/emission is best-effort during teardown.
		} finally {
			try {
				session.dispose();
			} catch {
				// Disposal is terminal and must remain idempotent for callers.
			}
		}
	}

	private static waitBounded(operation: Promise<unknown>, timeoutMs: number) {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		});

		return Promise.race([
			operation.then(
				() => undefined,
				() => undefined,
			),
			timeout,
		])
			.catch(() => {})
			.finally(() => {
				if (timer) {
					clearTimeout(timer);
				}
			});
	}
}
