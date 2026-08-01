/** Resource limits for captured terminal output. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;

/** Maximum full-log spill size for one stdout or stderr stream. */
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;

/** Maximum diagnostic text retained on a terminal snapshot. */
export const OUTPUT_ERROR_TEXT_MAX_LENGTH = 4_096;
