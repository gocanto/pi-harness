import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatActivityStatus } from '@shared/activity-status.ts';
import type { RunController } from '@workflows/controller.ts';
import { countStates, type WorkflowDetails } from '@workflows/model.ts';
import { buildWorkflowResultMessage } from '@workflows/prompt.ts';
import { safeStringify } from '@workflows/serialization.ts';

/** A workflow run retained while it is executing or awaiting cleanup. */
export interface ActiveWorkflowRun {
	readonly details: WorkflowDetails;
	readonly controller: RunController;
	completion?: Promise<void>;
}

/** A persisted or live workflow summary shown by the command/dashboard. */
export interface WorkflowRunSummary {
	readonly runId: string;
	readonly name?: string;
	readonly status: string;
	readonly done: number;
	readonly total: number;
	readonly startedAt: number;
	readonly active: boolean;
}

/** Owns live workflow state, indicators, summaries, and artifact read models. */
export class WorkflowRunRegistry {
	private readonly runs = new Map<string, ActiveWorkflowRun>();
	private ui: ExtensionContext['ui'] | undefined;
	private completedCount = 0;
	private failedCount = 0;

	constructor(private readonly workflowDirectory: string) {}

	/** Return a snapshot of live runs. */
	entries() {
		return [...this.runs.values()];
	}

	/** Return active run ids for retention protection. */
	ids() {
		return new Set(this.runs.keys());
	}

	/** Return details suitable for the dashboard. */
	details() {
		return new Map([...this.runs].map(([runId, run]) => [runId, run.details] as const));
	}

	/** Add a live run. */
	add(runId: string, run: ActiveWorkflowRun) {
		this.runs.set(runId, run);
	}

	/** Attach the completion promise after a run starts. */
	setCompletion(runId: string, completion: Promise<void>) {
		const run = this.runs.get(runId);

		if (run) {
			run.completion = completion;
		}
	}

	/** Remove a settled run. */
	remove(runId: string) {
		this.runs.delete(runId);
	}

	/** Record a completed or failed run for the activity indicator. */
	recordSettled(status: WorkflowDetails['status']) {
		if (status === 'completed') {
			this.completedCount += 1;
		} else {
			this.failedCount += 1;
		}
	}

	/** Attach the current UI for status updates. */
	setUi(ui: ExtensionContext['ui'] | undefined) {
		this.ui = ui;
	}

	/** Update the below-editor activity indicator. */
	updateIndicator() {
		if (!this.ui) {
			return;
		}

		try {
			const running = this.runs.size;

			if (running === 0 && this.completedCount === 0 && this.failedCount === 0) {
				this.ui.setStatus('workflows', undefined);

				return;
			}

			this.ui.setStatus(
				'workflows',
				formatActivityStatus(this.ui.theme, 'workflows', {
					running,
					done: this.completedCount,
					failed: this.failedCount,
				}),
			);
		} catch {
			// UI may be unavailable during teardown.
		}
	}

	/** Mark the activity indicator's completed counts as acknowledged. */
	acknowledge() {
		this.completedCount = 0;
		this.failedCount = 0;
		this.updateIndicator();
	}

	/** Clear the UI reference during session shutdown. */
	clearUi() {
		this.ui?.setStatus('workflows', undefined);
		this.ui = undefined;
	}

	/** Render the short live progress line used by tool updates. */
	summaryLine(details: WorkflowDetails) {
		const { done, failed } = countStates(details);
		const settled = done + failed;

		return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${details.currentPhase ? ` · ${details.currentPhase}` : ''}`;
	}

	/** Bound detail payloads before sending them to a tool result or dashboard. */
	compactDetails(details: WorkflowDetails) {
		return {
			...details,
			...(details.result !== undefined ? { result: JSON.parse(safeStringify(details.result, { maxBytes: 64 * 1024 })) } : {}),
			agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
		} satisfies WorkflowDetails;
	}

	/** List runs visible to the current session. */
	list(sessionId: string, referencedRunIds: ReadonlySet<string>) {
		let names: string[] = [];

		try {
			names = fs.readdirSync(this.workflowDirectory).filter((name) => name.startsWith('wf_'));
		} catch {
			// No runs yet.
		}

		const summaries: WorkflowRunSummary[] = [];

		for (const runId of names) {
			const live = this.runs.get(runId);

			if (live) {
				const { done, failed } = countStates(live.details);

				summaries.push({
					runId,
					name: live.details.name,
					status: live.details.status,
					done: done + failed,
					total: live.details.agents.length,
					startedAt: live.details.startedAt,
					active: true,
				});
				continue;
			}

			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(this.workflowDirectory, runId, 'workflow.json'), 'utf8')) as Partial<WorkflowDetails>;

				if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
					continue;
				}

				const agents = parsed.agents ?? [];

				summaries.push({
					runId,
					name: parsed.name,
					status: parsed.status === 'running' ? 'aborted' : (parsed.status ?? 'unknown'),
					done: agents.filter((agent) => agent.state !== 'running').length,
					total: agents.length,
					startedAt: parsed.startedAt ?? 0,
					active: false,
				});
			} catch {
				// Ignore unreadable or incomplete artifacts.
			}
		}

		return summaries.sort((left, right) => right.startedAt - left.startedAt);
	}

	/** Read a run's persisted or live detail message. */
	detailText(run: WorkflowRunSummary) {
		const runDir = path.join(this.workflowDirectory, run.runId);
		const live = this.runs.get(run.runId);

		if (live) {
			return buildWorkflowResultMessage(live.details, runDir);
		}

		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'workflow.json'), 'utf8')) as WorkflowDetails;

			return buildWorkflowResultMessage(parsed, runDir);
		} catch {
			return `Run ${run.runId} — ${run.status}`;
		}
	}
}
