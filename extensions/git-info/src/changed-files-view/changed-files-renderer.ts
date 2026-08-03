import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import type { ChangedFile, ChangedFilesResult, LoadFileDiff } from './types.ts';

type CustomFactory = Parameters<ExtensionContext['ui']['custom']>[0];

type Tui = Parameters<CustomFactory>[0];

type Theme = Parameters<CustomFactory>[1];

type Done = (value: void) => void;

const DIFF_SCROLL_STEP = 5;
const LOADING_DIFF_PLACEHOLDER = ['Loading diff…'];

/** TUI concern for browsing changed files and their lazily loaded diffs. */
export class ChangedFilesRenderer implements Component {
	private readonly files: ChangedFile[];
	private readonly loadFileDiffLazily: LoadFileDiff;
	private readonly tui: Tui;
	private readonly theme: Theme;
	private readonly done: Done;
	private focus: 'files' | 'diff' = 'files';
	private selectedIndex = 0;
	private sidebarOffset = 0;
	private diffOffset = 0;
	private disposed = false;
	private readonly diffCache = new Map<string, string[]>();
	private readonly pendingDiffLoads = new Map<string, AbortController>();

	/** Create a changed-files component. */
	constructor(tui: Tui, theme: Theme, files: ChangedFile[], loadFileDiffLazily: LoadFileDiff, done: Done) {
		this.tui = tui;
		this.theme = theme;
		this.files = files;
		this.loadFileDiffLazily = loadFileDiffLazily;
		this.done = done;
		this.ensureDiffLoaded(this.selectedFile());
	}

	/** Open the changed-files overlay when the context is interactive. */
	static async show(ctx: ExtensionContext, result: ChangedFilesResult, loadFileDiffLazily: LoadFileDiff) {
		if (ctx.mode !== 'tui') {
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ChangedFilesRenderer(tui, theme, result.files, loadFileDiffLazily, done), {
			overlay: true,
			overlayOptions: { anchor: 'center', margin: 1, maxHeight: '90%', minWidth: 60, width: '95%' },
		});
	}

	/** Dispose the component and cancel all outstanding diff loads. */
	dispose() {
		if (this.disposed) {
			return;
		}

		this.disposed = true;

		for (const controller of this.pendingDiffLoads.values()) {
			controller.abort();
		}

		this.pendingDiffLoads.clear();
	}

	/** Handle keyboard input for file selection, focus, and diff scrolling. */
	handleInput(data: string) {
		if (this.focus === 'files') {
			if (matchesKey(data, Key.escape)) {
				this.done(undefined);

				return;
			}

			if (matchesKey(data, Key.down) || data === 'j') {
				this.moveFile(1);

				return;
			}

			if (matchesKey(data, Key.up) || data === 'k') {
				this.moveFile(-1);

				return;
			}

			if (matchesKey(data, Key.home) || data === 'g') {
				this.selectFile(0);

				return;
			}

			if (matchesKey(data, Key.end) || data === 'G') {
				this.selectFile(this.files.length - 1);

				return;
			}

			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, Key.right) || data === 'l') {
				this.focus = 'diff';
				this.tui.requestRender();
			}

			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === 'h') {
			this.focus = 'files';
			this.tui.requestRender();

			return;
		}

		if (matchesKey(data, Key.down) || data === 'j') {
			this.moveDiff(DIFF_SCROLL_STEP);

			return;
		}

		if (matchesKey(data, Key.up) || data === 'k') {
			this.moveDiff(-DIFF_SCROLL_STEP);

			return;
		}

		if (matchesKey(
			data,
			Key.ctrl('d'),
		)) {
			this.moveDiff(Math.max(1, Math.floor(this.bodyHeight() / 2)));

			return;
		}

		if (matchesKey(
			data,
			Key.ctrl('u'),
		)) {
			this.moveDiff(-Math.max(1, Math.floor(this.bodyHeight() / 2)));

			return;
		}

		if (matchesKey(data, Key.home) || data === 'g') {
			this.diffOffset = 0;
			this.tui.requestRender();

			return;
		}

		if (matchesKey(data, Key.end) || data === 'G') {
			this.diffOffset = Math.max(0, this.currentDiffLines(this.selectedFile()).length - this.bodyHeight());
			this.tui.requestRender();
		}
	}

	/** Render the file sidebar and selected diff viewport. */
	render(width: number) {
		const height = this.bodyHeight();
		const sidebarWidth = Math.min(48, Math.max(24, Math.floor(width * 0.34)));
		const diffWidth = Math.max(1, width - sidebarWidth - 3);
		const selectedFile = this.selectedFile();
		const title = `local changes · ${this.files.length} ${this.files.length === 1 ? 'file' : 'files'} · ${this.focus === 'files' ? 'FILES' : 'DIFF'}`;
		const lines = [this.border(width, title, true)];

		for (let row = 0; row < height; row += 1) {
			const fileIndex = this.sidebarOffset + Math.floor(row / 2);
			const file = this.files[fileIndex];

			let sidebar = '';

			if (file) {
				const isSelected = fileIndex === this.selectedIndex;

				if (row % 2 === 0) {
					const marker = isSelected ? '› ' : '  ';
					const isBinary = file.additions === null || file.deletions === null;
					const stats = isBinary ? 'binary' : `+${file.additions} -${file.deletions}`;
					const styledStats = isBinary ? this.theme.fg('success', stats) : `${this.theme.fg('success', `+${file.additions}`)} ${this.theme.fg('error', `-${file.deletions}`)}`;
					const nameWidth = Math.max(1, sidebarWidth - visibleWidth(marker) - visibleWidth(stats) - 1);
					const name = truncateToWidth(file.name, nameWidth, '…');
					const gap = ' '.repeat(Math.max(1, sidebarWidth - visibleWidth(marker) - visibleWidth(name) - visibleWidth(stats)));

					sidebar = `${marker}${name}${gap}${styledStats}`;
				} else {
					sidebar = `  ${this.theme.fg('dim', truncateToWidth(file.path, Math.max(1, sidebarWidth - 2), '…'))}`;
				}

				sidebar = this.padToWidth(sidebar, sidebarWidth);
				if (isSelected) {
					sidebar = this.theme.bg(this.focus === 'files' ? 'selectedBg' : 'customMessageBg', sidebar);
				}
			} else {
				sidebar = ' '.repeat(sidebarWidth);
			}

			const diffLine = this.currentDiffLines(selectedFile)[this.diffOffset + row];
			const diff = this.padToWidth(diffLine === undefined ? '' : this.styleDiffLine(diffLine), diffWidth);
			const separator = this.theme.fg(this.focus === 'diff' ? 'borderAccent' : 'borderMuted', '│');

			lines.push(`${this.theme.fg('borderMuted', '│')}${sidebar}${separator}${diff}${this.theme.fg('borderMuted', '│')}`);
		}

		const help = this.focus === 'files' ? 'j/k or ↑/↓ select · enter/space/l open diff · esc close' : 'j/k or ↑/↓ scroll · ctrl-d/u page · g/G top/bottom · esc/h files';

		lines.push(this.border(width, help, false));

		return lines;
	}

	/** Invalidate cached rendering state when the theme changes. */
	invalidate() {}

	private selectedFile() {
		const file = this.files[this.selectedIndex];

		if (!file) {
			throw new Error('ChangedFilesRenderer requires at least one file');
		}

		return file;
	}

	private bodyHeight() {
		return Math.max(8, Math.floor(this.tui.terminal.rows * 0.8) - 2);
	}

	private currentDiffLines(file: ChangedFile) {
		return this.diffCache.get(file.rawPath) ?? LOADING_DIFF_PLACEHOLDER;
	}

	private ensureDiffLoaded(file: ChangedFile) {
		if (this.diffCache.has(file.rawPath) || this.pendingDiffLoads.has(file.rawPath)) {
			return;
		}
		for (const [rawPath, controller] of this.pendingDiffLoads) {
			if (rawPath === file.rawPath) {
				continue;
			}

			controller.abort();
			this.pendingDiffLoads.delete(rawPath);
		}

		const controller = new AbortController();

		this.pendingDiffLoads.set(file.rawPath, controller);

		const settle = (lines: string[]) => {
			if (this.pendingDiffLoads.get(file.rawPath) !== controller) {
				return;
			}

			this.pendingDiffLoads.delete(file.rawPath);
			if (this.disposed) {
				return;
			}

			this.diffCache.set(file.rawPath, lines);
			this.tui.requestRender();
		};

		this.loadFileDiffLazily(file, controller.signal)
			.then((diffResult) => settle(diffResult._tag === 'loaded' ? diffResult.lines : [diffResult.message]))
			.catch((error: unknown) => settle(
				[`Diff unavailable: ${error instanceof Error ? error.message : String(error)}`],
			));
	}

	private ensureSelectedFileVisible() {
		const visibleFiles = Math.max(1, Math.floor(this.bodyHeight() / 2));

		if (this.selectedIndex < this.sidebarOffset) {
			this.sidebarOffset = this.selectedIndex;
		}

		if (this.selectedIndex >= this.sidebarOffset + visibleFiles) {
			this.sidebarOffset = this.selectedIndex - visibleFiles + 1;
		}
	}

	private selectFile(newIndex: number) {
		this.selectedIndex = newIndex;
		this.diffOffset = 0;
		this.ensureSelectedFileVisible();
		this.ensureDiffLoaded(this.selectedFile());
		this.tui.requestRender();
	}

	private moveFile(amount: number) {
		this.selectFile((this.selectedIndex + amount + this.files.length) % this.files.length);
	}

	private moveDiff(amount: number) {
		const maxOffset = Math.max(0, this.currentDiffLines(this.selectedFile()).length - this.bodyHeight());

		this.diffOffset = Math.max(0, Math.min(maxOffset, this.diffOffset + amount));
		this.tui.requestRender();
	}

	private styleDiffLine(line: string) {
		const expanded = line.replaceAll('\t', '    ');

		if (expanded.startsWith('diff --git') || expanded.startsWith('index ')) {
			return this.theme.fg('accent', this.theme.bold(expanded));
		}

		if (expanded.startsWith('@@')) {
			return this.theme.fg('mdHeading', expanded);
		}

		if (expanded.startsWith('---') || expanded.startsWith('+++')) {
			return this.theme.fg('muted', expanded);
		}

		if (expanded.startsWith('+')) {
			return this.theme.fg('success', expanded);
		}

		if (expanded.startsWith('-')) {
			return this.theme.fg('error', expanded);
		}

		if (expanded.startsWith('…')) {
			return this.theme.fg('warning', expanded);
		}

		return this.theme.fg('text', expanded);
	}

	private border(width: number, label: string, top: boolean) {
		const left = top ? '┌' : '└';
		const right = top ? '┐' : '┘';
		const text = `─ ${label} `;
		const remaining = Math.max(0, width - visibleWidth(text) - 2);

		return this.theme.fg('borderAccent', truncateToWidth(`${left}${text}${'─'.repeat(remaining)}${right}`, width, ''));
	}

	private padToWidth(text: string, width: number) {
		const truncated = truncateToWidth(text, width, '');

		return `${truncated}${' '.repeat(Math.max(0, width - visibleWidth(truncated)))}`;
	}
}
