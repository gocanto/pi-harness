import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentRecord, TranscriptEntry, WorkflowDetails } from '@workflows/model.ts';

/** One workflow run available to the dashboard. */
export interface RunEntry {
	runId: string;
	details: WorkflowDetails;
	live: boolean;
}

interface CachedRun {
	details: WorkflowDetails;
	mtimeMs: number;
	hydratedAtMtimeMs?: number;
}

/** Reads and caches workflow run metadata and lazily loaded artifacts. */
export class WorkflowRunCache {
	private readonly runs = new Map<string, CachedRun>();
	private readonly runsDir: () => string;

	/** @param runsDirOverride Test-only override for the workflow run store root. */
	constructor(runsDirOverride?: () => string) {
		this.runsDir = runsDirOverride ?? (() => path.join(getAgentDir(), 'workflows'));
	}

	/** List every run visible to this session. */
	list(active: Map<string, WorkflowDetails>, sessionId: string, referencedRunIds: ReadonlySet<string>): RunEntry[] {
		let names: string[] = [];

		try {
			names = fs.readdirSync(this.runsDir()).filter((name) => name.startsWith('wf_'));
		} catch {
			// No runs yet.
		}

		const seen = new Set<string>();
		const entries: RunEntry[] = [];

		for (const runId of names) {
			seen.add(runId);

			const live = active.get(runId);

			if (live) {
				entries.push({ runId, details: live, live: true });
				continue;
			}

			const details = this.readPersisted(runId);

			if (details && (details.sessionId === sessionId || referencedRunIds.has(runId))) {
				entries.push({ runId, details, live: false });
			}
		}

		for (const runId of [...this.runs.keys()]) {
			if (!seen.has(runId)) {
				this.runs.delete(runId);
			}
		}

		return entries.sort((a, b) => b.details.startedAt - a.details.startedAt);
	}

	/** Force a run to be reread on the next list or hydrate operation. */
	invalidate(runId?: string) {
		if (runId) {
			this.runs.delete(runId);
		} else {
			this.runs.clear();
		}
	}

	/** Lazily load result and transcript artifacts for a selected run. */
	hydrate(entry: RunEntry) {
		if (entry.live) {
			return;
		}

		const cached = this.runs.get(entry.runId);

		if (!cached || cached.hydratedAtMtimeMs === cached.mtimeMs) {
			return;
		}

		const runDir = path.join(this.runsDir(), entry.runId);
		const details = cached.details;

		if (details.resultArtifact) {
			try {
				details.result = JSON.parse(fs.readFileSync(path.join(runDir, path.basename(details.resultArtifact)), 'utf8'));
			} catch {
				// Keep the compatibility marker from workflow.json.
			}
		}

		if (details.transcriptArtifact) {
			try {
				const transcripts = JSON.parse(fs.readFileSync(path.join(runDir, path.basename(details.transcriptArtifact)), 'utf8')) as Record<string, unknown>;

				for (const agent of details.agents) {
					agent.transcript = this.normalizeTranscript(transcripts[String(agent.index)]);
				}
			} catch {
				// Older or partially written artifacts may lack transcripts.
			}
		}

		cached.hydratedAtMtimeMs = cached.mtimeMs;
	}

	private readPersisted(runId: string): WorkflowDetails | undefined {
		const workflowPath = path.join(this.runsDir(), runId, 'workflow.json');

		let mtimeMs: number;

		try {
			mtimeMs = fs.statSync(workflowPath).mtimeMs;
		} catch {
			this.runs.delete(runId);

			return undefined;
		}

		const cached = this.runs.get(runId);

		if (cached && cached.mtimeMs === mtimeMs) {
			return cached.details;
		}

		try {
			const details = this.normalizeDetails(runId, JSON.parse(fs.readFileSync(workflowPath, 'utf8')));

			if (!details) {
				this.runs.delete(runId);

				return undefined;
			}

			if (details.status === 'running') {
				details.status = 'aborted';
				details.finishedAt = details.finishedAt ?? Date.now();
				details.error = details.error ?? 'Recovered stale run that was not active';

				for (const agent of details.agents) {
					if (agent.state !== 'running') {
						continue;
					}

					agent.state = 'error';
					agent.error = agent.error ?? 'Run ended before this agent settled';
					agent.finishedAt = details.finishedAt;
				}
			}

			this.runs.set(runId, { details, mtimeMs });

			return details;
		} catch {
			return cached?.details;
		}
	}

	private normalizeTranscript(value: unknown): TranscriptEntry[] {
		if (!Array.isArray(value)) {
			return [];
		}

		const transcript: TranscriptEntry[] = [];

		for (const item of value) {
			if (!item || typeof item !== 'object') {
				continue;
			}

			const entry = item as Record<string, unknown>;

			if (!['user', 'assistant', 'thinking', 'tool', 'toolResult'].includes(String(entry.role))) {
				continue;
			}

			if (typeof entry.text !== 'string') {
				continue;
			}

			transcript.push({
				role: entry.role as TranscriptEntry['role'],
				text: entry.text,
				name: typeof entry.name === 'string' ? entry.name : undefined,
				isError: entry.isError === true,
				timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : undefined,
			});
		}

		return transcript;
	}

	private normalizeDetails(runId: string, raw: unknown): WorkflowDetails | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}

		const record = raw as Record<string, unknown>;
		const meta = (record.meta ?? {}) as Record<string, unknown>;
		const startedAt = typeof record.startedAt === 'number' ? record.startedAt : 0;
		const rawAgents = Array.isArray(record.agents) ? record.agents : [];
		const agents: AgentRecord[] = [];

		for (const item of rawAgents) {
			if (!item || typeof item !== 'object') {
				continue;
			}

			const agent = item as Record<string, unknown>;
			const state = agent.state === 'error' || agent.state === 'failed' ? 'error' : agent.state === 'running' ? 'running' : 'done';

			agents.push({
				index: typeof agent.index === 'number' ? agent.index : agents.length + 1,
				label: typeof agent.label === 'string' ? agent.label : `agent-${agents.length + 1}`,
				phase: typeof agent.phase === 'string' ? agent.phase : undefined,
				state,
				model: typeof agent.model === 'string' ? agent.model : undefined,
				contextWindow: typeof agent.contextWindow === 'number' && Number.isFinite(agent.contextWindow) && agent.contextWindow > 0 ? agent.contextWindow : undefined,
				startedAt: typeof agent.startedAt === 'number' ? agent.startedAt : startedAt,
				finishedAt: typeof agent.finishedAt === 'number' ? agent.finishedAt : undefined,
				error: typeof agent.error === 'string' && agent.error !== '[undefined]' ? agent.error : undefined,
				preview: typeof agent.preview === 'string' ? agent.preview : '',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
					...(agent.usage && typeof agent.usage === 'object' ? agent.usage : {}),
				},
				transcript: this.normalizeTranscript(agent.transcript),
			});
		}

		const rawPhases = Array.isArray(record.phases) ? record.phases : Array.isArray(meta.phases) ? meta.phases : [];

		const phases: WorkflowDetails['phases'] = rawPhases.flatMap((item) => {
			if (!item || typeof item !== 'object') {
				return [];
			}

			const phase = item as Record<string, unknown>;

			return typeof phase.title === 'string' ? [{ title: phase.title, ...(typeof phase.detail === 'string' ? { detail: phase.detail } : {}) }] : [];
		});

		const status = record.status === 'running' || record.status === 'failed' || record.status === 'aborted' ? record.status : 'completed';

		return {
			runId,
			sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
			name: typeof record.name === 'string' ? record.name : typeof meta.name === 'string' ? meta.name : undefined,
			description: typeof record.description === 'string' ? record.description : typeof meta.description === 'string' ? meta.description : undefined,
			background: record.background === true,
			status,
			startedAt,
			finishedAt: typeof record.finishedAt === 'number' ? record.finishedAt : undefined,
			phases,
			currentPhase: typeof record.currentPhase === 'string' ? record.currentPhase : undefined,
			agents,
			result: record.result,
			resultArtifact: typeof record.resultArtifact === 'string' ? record.resultArtifact : undefined,
			transcriptArtifact: typeof record.transcriptArtifact === 'string' ? record.transcriptArtifact : undefined,
			error: typeof record.error === 'string' ? record.error : undefined,
		};
	}
}

/** List runs once without retaining a cache instance. */
export function loadRunEntries(active: Map<string, WorkflowDetails>, sessionId: string, referencedRunIds: ReadonlySet<string>) {
	return new WorkflowRunCache().list(active, sessionId, referencedRunIds);
}

/** Extract workflow run ids referenced by the current session. */
export function sessionWorkflowRunIds(ctx: ExtensionContext) {
	const runIds = new Set<string>();

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.toolName !== 'workflow') {
			continue;
		}

		const details = entry.message.details;

		if (!details || typeof details !== 'object') {
			continue;
		}

		const runId = (details as Record<string, unknown>).runId;

		if (typeof runId === 'string') {
			runIds.add(runId);
		}
	}

	return runIds;
}
