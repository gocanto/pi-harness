import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./serialization.ts";

/**
 * Explicit workflow-tool activation policy.
 *
 * The `workflow` tool fans out to multiple subagents and can be expensive, so
 * it is only callable by the model once the user has explicitly turned it on
 * — there is no hidden trigger phrase and no automatic activation. Precedence,
 * highest first:
 *
 *   1. The `PI_WORKFLOWS_ENABLED` environment variable. Lets whoever launches
 *      pi force the tool on or off for that process regardless of the
 *      persisted preference (for example, to keep workflows off for an
 *      untrusted or unattended run).
 *   2. The persisted preference written by `/workflows enable|disable`.
 *   3. Default: disabled.
 *
 * Activation only ever changes via `pi.setActiveTools()` from `session_start`
 * and the `/workflows` command handler in `index.ts` — never from workflow
 * script content, agent() output, or project files. An untrusted project's
 * contents cannot enable the tool for itself; only the interactive user or
 * the process launcher (via the environment variable) can.
 */

/** Environment variable that overrides the persisted activation preference. */
export const WORKFLOW_ACTIVATION_ENV_VAR = "PI_WORKFLOWS_ENABLED";

const ENV_TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const ENV_FALSE_VALUES = new Set(["0", "false", "off", "no"]);

interface PersistedActivationPreference {
  enabled?: unknown;
}

/** Path to the persisted global activation preference file, under the agent dir. */
export function activationPreferencePath(agentDir: string): string {
  return path.join(agentDir, "workflows", "activation.json");
}

/**
 * Parse `PI_WORKFLOWS_ENABLED` into a tri-state.
 *
 * @param value - The raw environment variable value, or `undefined` when unset.
 * @returns `true`/`false` for a recognized value, `undefined` when unset or unrecognized.
 */
export function parseActivationEnv(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (ENV_TRUE_VALUES.has(normalized)) return true;
  if (ENV_FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * Read the persisted activation preference.
 *
 * @param agentDir - The agent directory (`getAgentDir()`).
 * @returns The persisted `enabled` value, or `undefined` when no preference has been saved yet or the file is missing/unreadable/invalid.
 */
export function readActivationPreference(
  agentDir: string,
): boolean | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(activationPreferencePath(agentDir), "utf8"),
    ) as PersistedActivationPreference;
    return typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the user's explicit `/workflows enable|disable` choice so it holds
 * for future sessions.
 *
 * @param agentDir - The agent directory (`getAgentDir()`).
 * @param enabled - Whether the workflow tool should be active by default from now on.
 */
export function writeActivationPreference(
  agentDir: string,
  enabled: boolean,
): void {
  writeFileAtomic(
    activationPreferencePath(agentDir),
    JSON.stringify({ enabled }, null, 2),
  );
}

/** Which activation policy source ultimately decided the result. */
export type ActivationSource = "env" | "preference" | "default";

/** The resolved workflow-tool activation decision and the source that decided it. */
export interface ResolvedActivation {
  enabled: boolean;
  source: ActivationSource;
}

/**
 * Resolve whether the workflow tool should be active right now, applying the
 * environment-override / persisted-preference / default precedence described
 * above.
 *
 * @param options.agentDir - The agent directory (`getAgentDir()`).
 * @param options.env - Environment to read the override from (defaults to `process.env`; overridable for tests).
 */
export function resolveWorkflowActivation(options: {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedActivation {
  const envOverride = parseActivationEnv(
    (options.env ?? process.env)[WORKFLOW_ACTIVATION_ENV_VAR],
  );
  if (envOverride !== undefined) {
    return { enabled: envOverride, source: "env" };
  }
  const preference = readActivationPreference(options.agentDir);
  if (preference !== undefined) {
    return { enabled: preference, source: "preference" };
  }
  return { enabled: false, source: "default" };
}
