/** Platform shell command construction for background terminal processes. */
export class ShellInvocation {
	private constructor() {}

	/** Build the shell and arguments for one user-provided command. */
	static for(command: string) {
		if (process.platform === 'win32') {
			const shell = process.env.ComSpec ?? 'cmd.exe';

			return { shell, args: ['/d', '/s', '/c', command] };
		}

		return { shell: '/bin/sh', args: ['-c', command] };
	}
}
