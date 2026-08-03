// Strip terminal control sequences from repository-controlled paths and diff text.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

/** Pure terminal-text sanitization and display formatting operations. */
export class TerminalText {
	/** Remove terminal control sequences and non-printing control characters. */
	static sanitize(text: string) {
		// eslint-disable-next-line no-control-regex
		return (
			text
				.replace(OSC_PATTERN, '')
				.replace(CSI_PATTERN, '')
				.replace(ESCAPE_PATTERN, '')
				// eslint-disable-next-line no-control-regex
				.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
		);
	}
	/** Make a repository path safe and readable in a one-line label. */
	static cleanDisplayPath(path: string) {
		return TerminalText.sanitize(path).replace(/[\r\n\t]/g, ' ');
	}
}
