import { ChangedFilesRenderer } from '@git-info/src/changed-files-view/changed-files-renderer.ts';
import { GitChangesLoader, MAX_DIFF_LINES, loadChangedFiles, loadFileDiff } from '@git-info/src/changed-files-view/git-changes-loader.ts';
import { TerminalText } from '@git-info/src/changed-files-view/terminal-text.ts';

export { ChangedFilesRenderer, GitChangesLoader, MAX_DIFF_LINES, loadChangedFiles, loadFileDiff, TerminalText };
export type { ChangedFile, ChangedFilesResult, DiffLoadResult, LoadFileDiff } from '@git-info/src/changed-files-view/types.ts';

/** Remove terminal control sequences from repository-controlled text. */
export function sanitizeTerminalText(text: string) {
	return TerminalText.sanitize(text);
}

/** Open the changed-files TUI overlay. */
export const showChangedFiles = ChangedFilesRenderer.show;
