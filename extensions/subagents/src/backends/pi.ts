/**
 * pi backend composition root.
 *
 * The concern modules under `pi/` own model resolution, child resources,
 * transcript/protocol translation, and scoped session behavior. This module
 * keeps the backend registry contract and public `piBackend` export stable.
 */

import { Effect } from 'effect';
import type { SubagentBackend } from '@subagents/src/backend.ts';
import { PiSession } from '@subagents/src/backends/pi/index.ts';

/** The in-process pi subagent backend. */
export const piBackend: SubagentBackend = {
	name: 'pi',
	capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
	// In-process SDK: always available.
	available: Effect.succeed(true),
	spawn: PiSession.create,
};
