function isAbortError(error: unknown) {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** Await an operation and translate cancellation into the host-facing message. */
export async function runWithCancellation<T>(operation: Promise<T>, signal: AbortSignal | undefined, message: string) {
	try {
		return await operation;
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			throw new Error(message);
		}

		throw error;
	}
}
