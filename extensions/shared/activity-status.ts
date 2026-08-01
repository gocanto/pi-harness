import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type Theme = ExtensionContext['ui']['theme'];

/** Counts rendered by the activity status line. */
export interface ActivityCounts {
	running: number;
	done: number;
	failed: number;
}

/** Presentation object for the shared activity status line. */
export class ActivityStatusFormatter {
	/** Render activity counts and the command used to open their dashboard. */
	static format(theme: Theme, label: 'subagents' | 'workflows', counts: ActivityCounts) {
		const parts: string[] = [];

		if (counts.running > 0) {
			parts.push(theme.fg('warning', `■ ${counts.running} running`));
		}

		if (counts.done > 0) {
			parts.push(theme.fg('success', `■ ${counts.done} done`));
		}

		if (counts.failed > 0) {
			parts.push(theme.fg('error', `■ ${counts.failed} failed`));
		}

		parts.push(theme.fg('accent', `/${label}`) + theme.fg('dim', ' to view'));

		return `${theme.fg('muted', `${label}:`)} ${parts.join(theme.fg('dim', ' · '))}`;
	}
}

/** Backward-compatible activity formatter. */
export function formatActivityStatus(theme: Theme, label: 'subagents' | 'workflows', counts: ActivityCounts) {
	return ActivityStatusFormatter.format(theme, label, counts);
}
