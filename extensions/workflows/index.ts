/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume. Artifacts are
 * private to the owner (see serialization.ts) and are swept automatically
 * once older than `WORKFLOW_RETENTION_MS` (see retention.ts); a run tracked
 * as active in this process is never removed regardless of age.
 *
 * The `workflow` tool is explicit opt-in (see activation.ts): it is inactive
 * by default and only becomes callable once the user runs `/workflows
 * enable` (or sets `PI_WORKFLOWS_ENABLED`). There is no hidden trigger
 * phrase — activation is a visible, user-controlled setting.
 */

import * as path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { sessionWorkflowRunIds, showWorkflowDashboard } from '@workflows/dashboard.ts';
import { cleanupExpiredWorkflowRuns } from '@workflows/retention.ts';
import { WorkflowRunRegistry } from '@workflows/registry.ts';
import { WorkflowToolRegistrar } from '@workflows/tool.ts';

import { resolveWorkflowActivation, writeActivationPreference, WORKFLOW_ACTIVATION_ENV_VAR } from '@workflows/activation.ts';

const WORKFLOW_TOOL_NAME = 'workflow';

function applyWorkflowActivation(pi: ExtensionAPI, enabled: boolean) {
	const withoutWorkflow = pi.getActiveTools().filter((name) => name !== WORKFLOW_TOOL_NAME);

	pi.setActiveTools(enabled ? [...withoutWorkflow, WORKFLOW_TOOL_NAME] : withoutWorkflow);
}

function applyResolvedWorkflowActivation(pi: ExtensionAPI) {
	applyWorkflowActivation(pi, resolveWorkflowActivation({ agentDir: getAgentDir() }).enabled);
}

export default function workflows(pi: ExtensionAPI) {
	const registry = new WorkflowRunRegistry(path.join(getAgentDir(), 'workflows'));
	const activeDetails = () => registry.details();
	const updateIndicator = () => registry.updateIndicator();

	pi.on('session_start', (_event, ctx) => {
		if (ctx.hasUI) {
			registry.setUi(ctx.ui);
		}

		updateIndicator();
		// Explicit opt-in: re-resolve and apply the activation policy every
		// session so a persisted preference or environment override always wins
		// over whatever the tool's default active state happened to be.
		applyResolvedWorkflowActivation(pi);
		// Best-effort retention sweep; cleanupExpiredWorkflowRuns already
		// tolerates a missing directory and per-run failures internally.
		cleanupExpiredWorkflowRuns(
			path.join(getAgentDir(), 'workflows'),
			registry.ids(),
		);
	});

	pi.on('session_shutdown', async () => {
		const runs = registry.entries();

		for (const run of runs) {
			run.controller.abort('Session is shutting down');
		}

		await Promise.all(runs.map((run) => run.controller.settle({ abort: true })));

		const completions = runs.map((run) => run.completion).filter((completion): completion is Promise<void> => completion !== undefined);

		if (completions.length > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;

			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 8_000);
				timer.unref?.();
			});

			await Promise.race([Promise.allSettled(completions), timeout]);

			if (timer) {
				clearTimeout(timer);
			}
		}

		registry.clearUi();
	});

	pi.registerCommand('workflows', {
		description: "List workflow runs (`/workflows <runId>` for one run's detail); " + '`/workflows enable|disable|status` controls whether the model can call the workflow tool',
		handler: async (rawArgs, ctx) => {
			const arg = rawArgs.trim();
			const directive = arg.toLowerCase();

			if (directive === 'enable' || directive === 'disable') {
				const enabled = directive === 'enable';

				writeActivationPreference(
					getAgentDir(),
					enabled,
				);
				applyResolvedWorkflowActivation(pi);

				const resolved = resolveWorkflowActivation(
					{
						agentDir: getAgentDir(),
					},
				);

				ctx.ui.notify(resolved.enabled ? 'Workflow tool enabled: the model can now call `workflow`.' : 'Workflow tool disabled: the model can no longer call `workflow`.', 'info');

				return;
			}

			if (directive === 'status') {
				const resolved = resolveWorkflowActivation(
					{
						agentDir: getAgentDir(),
					},
				);

				ctx.ui.notify(
					`Workflow tool is ${resolved.enabled ? 'enabled' : 'disabled'} (source: ${resolved.source}). ` +
						`Use \`/workflows enable\` or \`/workflows disable\` to change it, or set ${WORKFLOW_ACTIVATION_ENV_VAR}.`,
					'info',
				);

				return;
			}

			if (ctx.mode === 'tui') {
				registry.setUi(ctx.ui);

				await showWorkflowDashboard(ctx, activeDetails, arg || undefined);
				// Opening the dashboard acknowledges finished runs.
				registry.acknowledge();
				updateIndicator();

				return;
			}
			// Non-TUI fallback: plain text listing.
			const runs = registry.list(ctx.sessionManager.getSessionId(), sessionWorkflowRunIds(ctx));

			if (runs.length === 0) {
				ctx.ui.notify('No workflow runs yet.', 'info');

				return;
			}

			if (arg) {
				const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));

				ctx.ui.notify(run ? registry.detailText(run) : `No workflow run matching "${arg}".`, run ? 'info' : 'warning');

				return;
			}

			const labels = runs.map((r) => `${r.active ? '* ' : '  '}${r.runId}  ${r.status}  ${r.name ?? ''}  ${r.done}/${r.total}`);

			if (!ctx.hasUI) {
				ctx.ui.notify(labels.join('\n'), 'info');

				return;
			}

			const choice = await ctx.ui.select('Workflow runs', labels);

			if (!choice) {
				return;
			}

			const run = runs[labels.indexOf(choice)];

			if (run) {
				ctx.ui.notify(registry.detailText(run), 'info');
			}
		},
	});

	new WorkflowToolRegistrar(pi, registry).register();
}
