import { ChangedFilesRenderer } from './changed-files-renderer.ts';
import { GitChangesLoader, MAX_DIFF_LINES } from './git-changes-loader.ts';
import { TerminalText } from './terminal-text.ts';

export { ChangedFilesRenderer, GitChangesLoader, MAX_DIFF_LINES, TerminalText };
export type { ChangedFile, ChangedFilesResult, DiffLoadResult, LoadFileDiff } from './types.ts';

/** Load changed files and their cheap per-file statistics. */
export const loadChangedFiles = GitChangesLoader.loadChangedFiles;
/** Load a selected file's textual diff lazily. */
export const loadFileDiff = GitChangesLoader.loadFileDiff;
/** Remove terminal control sequences from repository-controlled text. */
export function sanitizeTerminalText(text: string) {
	return TerminalText.sanitize(text);
}
/** Open the changed-files TUI overlay. */
export const showChangedFiles = ChangedFilesRenderer.show;
