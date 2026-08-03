/** A changed repository path as reported by Git porcelain output. */
export interface ChangedPath {
	readonly path: string;
	readonly status: string;
}

/** A changed file with display-safe names and Git loading metadata. */
export interface ChangedFile {
	additions: number | null;
	deletions: number | null;
	name: string;
	path: string;
	/** Original unsanitized path used only for Git arguments. */
	rawPath: string;
	/** Porcelain XY status code. */
	status: string;
}

/** The result of the changed-file listing operation. */
export interface ChangedFilesResult {
	files: ChangedFile[];
	hasHead: boolean;
	repoRoot: string;
}

/** The result of loading one file's textual diff. */
export type DiffLoadResult = { _tag: 'loaded'; lines: string[] } | { _tag: 'unavailable'; message: string };

/** Loads a selected file's diff and supports cancellation. */
export type LoadFileDiff = (file: ChangedFile, signal: AbortSignal) => Promise<DiffLoadResult>;
