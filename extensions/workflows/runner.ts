/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import type {
  ContextUsage,
  CreateAgentSessionOptions,
  DefaultResourceLoader,
  SessionShutdownEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import { emptyUsage, type AgentUsage, type TranscriptEntry } from "./model.ts";
import {
  buildWorkflowAgentPrompt,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
type ToolTimingEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_end" }
>;

export interface ToolExecutionTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  modelRegistry: ExtensionContext["modelRegistry"];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Test-only override for the per-tool execution timeout. */
  toolCallTimeoutMs?: number;
  /** Test-only override for the first assistant response-event timeout. */
  firstResponseTimeoutMs?: number;
  /** Test-only override for session creation; defaults to the production Pi SDK. */
  createSession?: CreateWorkflowAgentSession;
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(
  cwd: string,
  variant: "plain" | "structured",
  projectTrusted: boolean,
) {
  return createChildResources({
    cwd,
    projectTrusted,
    ...(variant === "structured"
      ? { appendSystemPrompt: [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] }
      : {}),
  });
}

interface WorkflowToolSession {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/**
 * The minimal `AgentSession` lifecycle `runAgent()` depends on: creation
 * output, message/model/context inspection, event subscription, prompting,
 * abort, and disposal. `Pick`s off `AgentSession`'s public method/property
 * types instead of naming its private fields, so a plain object literal
 * satisfies this type structurally and can stand in for a real session in
 * tests without a cast. `extensionRunner` is narrowed to the concrete
 * `session_shutdown` shape (mirroring `shared/child-session.ts`'s
 * `ChildExtensionRunner`) rather than `AgentSession["extensionRunner"]`'s
 * generic `emit`, which only a real `ExtensionRunner` can implement.
 */
export type WorkflowAgentSession = WorkflowToolSession &
  Pick<
    AgentSession,
    | "model"
    | "messages"
    | "getContextUsage"
    | "bindExtensions"
    | "prompt"
    | "abort"
    | "dispose"
  > & {
    readonly extensionRunner: {
      hasHandlers(eventType: string): boolean;
      emit(event: SessionShutdownEvent): Promise<unknown>;
    };
  };

/** Test-only seam for session creation; the production default is `createAgentSession`. */
export type CreateWorkflowAgentSession = (
  options: CreateAgentSessionOptions,
) => Promise<{ session: WorkflowAgentSession }>;

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(
  session: WorkflowToolSession,
  timeoutMs?: number,
) {
  const guard = createToolCallTimeoutGuard(timeoutMs);
  guard.apply(session);
  return session.subscribe((event) => {
    if (event.type === "agent_start") guard.apply(session);
  });
}

function isJsonSchema(value: unknown): value is TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isJsonSchema(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

/**
 * Joined, trimmed text of an assistant message's text parts (empty when the
 * message has none, e.g. a tool-call-only turn). Shared by the full-rescan
 * `finalOutput()` and the incremental `IncrementalProgressTracker` so both
 * agree on what counts as "the latest assistant output".
 */
function assistantText(
  message: Extract<AgentMessage, { role: "assistant" }>,
): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Full rescan: the most recent non-empty assistant text in `messages`. */
function finalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = assistantText(msg);
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string {
  return safeStringify(value, {
    maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
    maxDepth: 12,
    maxNodes: 2_000,
  });
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
  timings: Map<string, ToolExecutionTiming>,
  event: ToolTimingEvent,
  observedAt = Date.now(),
) {
  const previous = timings.get(event.toolCallId);
  if (event.type === "tool_execution_start") {
    if (previous?.startedAt !== undefined) return;
    timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
    return;
  }
  if (previous?.finishedAt !== undefined) return;
  const durationMs =
    previous?.startedAt === undefined
      ? undefined
      : Math.max(0, observedAt - previous.startedAt);
  timings.set(event.toolCallId, {
    ...previous,
    finishedAt: observedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function toolMetadata(
  toolCallId: string,
  timings: ReadonlyMap<string, ToolExecutionTiming>,
) {
  const timing = timings.get(toolCallId);
  return {
    toolCallId: truncateUtf8(toolCallId, 1024),
    ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
    ...(timing?.finishedAt === undefined
      ? {}
      : { finishedAt: timing.finishedAt }),
    ...(timing?.durationMs === undefined
      ? {}
      : { durationMs: timing.durationMs }),
  };
}

/**
 * Convert one already-finalized message into 0+ raw transcript entries.
 * Shared by the full-rescan `transcriptFromMessages()` (looped over the
 * whole history) and `IncrementalProgressTracker` (called once per newly
 * observed message), so both agree on what a message renders as.
 */
function entriesForMessage(
  message: AgentMessage,
  toolTimings: ReadonlyMap<string, ToolExecutionTiming>,
): TranscriptEntry[] {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
            )
            .join("\n");
    return text.trim()
      ? [{ role: "user", text, timestamp: message.timestamp }]
      : [];
  }

  if (message.role === "assistant") {
    const entries: TranscriptEntry[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) {
        entries.push({
          role: "assistant",
          text: part.text,
          timestamp: message.timestamp,
        });
      } else if (part.type === "thinking" && part.thinking.trim()) {
        entries.push({
          role: "thinking",
          text: part.thinking,
          timestamp: message.timestamp,
        });
      } else if (part.type === "toolCall") {
        entries.push({
          role: "tool",
          name: part.name,
          text: safeJson(part.arguments),
          timestamp: message.timestamp,
          ...toolMetadata(part.id, toolTimings),
        });
      }
    }
    return entries;
  }

  if (message.role !== "toolResult") return [];
  const text = message.content
    .map((part) =>
      part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
    )
    .join("\n");
  return [
    {
      role: "toolResult",
      name: message.toolName,
      text,
      isError: message.isError,
      timestamp: message.timestamp,
      ...toolMetadata(message.toolCallId, toolTimings),
    },
  ];
}

/**
 * Apply the transcript's count/byte bounds to a raw (unbounded) entry list:
 * keep the first entry plus the newest ones, cap total bytes, and append a
 * truncation marker when anything was dropped.
 */
function boundTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const selected =
    entries.length <= TRANSCRIPT_MAX_ENTRIES
      ? entries
      : [entries[0], ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
  const bounded: TranscriptEntry[] = [];
  let totalBytes = 0;
  for (const entry of selected) {
    const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(
      entry.text,
      Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
    );
    totalBytes += Buffer.byteLength(text, "utf8");
    bounded.push({
      ...entry,
      text:
        text === entry.text ? text : `${text}\n[transcript entry truncated]`,
    });
  }
  if (bounded.length < entries.length) {
    bounded.push({
      role: "toolResult",
      name: "transcript",
      text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]`,
    });
  }
  return bounded;
}

/**
 * Convert pi messages into a compact, serializable transcript for the UI.
 * Full rescan over `messages`; used for the authoritative final transcript
 * and as the characterization reference for `IncrementalProgressTracker`.
 */
export function transcriptFromMessages(
  messages: AgentMessage[],
  toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map(),
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    entries.push(...entriesForMessage(message, toolTimings));
  }
  return boundTranscriptEntries(entries);
}

/**
 * Fold one message's usage numbers (a no-op for non-assistant messages) into
 * a running total. Shared by the full-rescan `computeUsage()` and
 * `IncrementalProgressTracker` so both agree on what a turn contributes.
 */
function foldAssistantUsage(usage: AgentUsage, message: AgentMessage): void {
  if (message.role !== "assistant") return;
  usage.turns++;
  const u = message.usage;
  if (!u) return;
  usage.input += u.input || 0;
  usage.output += u.output || 0;
  usage.cacheRead += u.cacheRead || 0;
  usage.cacheWrite += u.cacheWrite || 0;
  usage.cost += u.cost?.total || 0;
}

/** Full rescan: total usage across every assistant message in `messages`. */
function computeUsage(messages: AgentMessage[]): AgentUsage {
  const usage = emptyUsage();
  for (const msg of messages) foldAssistantUsage(usage, msg);
  return usage;
}

/**
 * Derive the model/stop info a single assistant message contributes: a
 * response-matched registry model (capacity tracks the model that actually
 * served the response, not just a configured guess) plus any stop reason or
 * error message it carries. Empty fields mean "no update"; callers keep
 * whatever they already had.
 */
function assistantSyncInfo(
  message: Extract<AgentMessage, { role: "assistant" }>,
  sessionModel: WorkflowModel | undefined,
  modelRegistry: ExtensionContext["modelRegistry"],
): {
  modelId?: string;
  contextWindow?: number;
  stopReason?: string;
  errorMessage?: string;
} {
  const responseMatchesSession =
    !sessionModel ||
    (message.provider === sessionModel.provider &&
      message.model === sessionModel.id);
  const reportedId = message.responseModel ?? message.model;
  const reportedModel = responseMatchesSession
    ? modelRegistry.find(message.provider, reportedId)
    : undefined;
  return {
    ...(reportedModel
      ? {
          modelId: reportedModel.id,
          contextWindow: reportedModel.contextWindow,
        }
      : {}),
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
  };
}

/**
 * Incrementally maintains the onProgress-facing slice of agent state (usage,
 * latest model/stop info, preview text, and transcript entries) from newly
 * observed session events, instead of rescanning the full message history on
 * every progress tick.
 *
 * `observeMessage()` folds one newly finalized message in work proportional
 * to that message, not the run's history so far. `patchToolTiming()` refreshes
 * cached tool-call/result entries in place once execution timing becomes
 * known (it always arrives after the entry itself, since tool execution
 * starts only after the assistant message that requested it is finalized).
 *
 * `rebuild()` is the explicit full-rescan escape hatch for events that
 * replace the message history wholesale (compaction, branch replacement): it
 * resets and refolds over the given (already-replaced) message array, using
 * the same per-message logic as `observeMessage()`, so future incremental
 * calls keep working against the new baseline. `runAgent()` still performs
 * one additional authoritative full rescan (`computeUsage`/`finalOutput`/
 * `transcriptFromMessages`) at finalization; this tracker only has to stay
 * correct for the in-flight, human-facing progress stream.
 */
class IncrementalProgressTracker {
  private _usage: AgentUsage = emptyUsage();
  private _modelId?: string;
  private _contextWindow?: number;
  private _stopReason?: string;
  private _errorMessage?: string;
  private _preview = "";
  private _entries: TranscriptEntry[] = [];
  private readonly _toolEntryIndexes = new Map<string, number[]>();

  constructor(modelId?: string, contextWindow?: number) {
    this._modelId = modelId;
    this._contextWindow = contextWindow;
  }

  get usage(): AgentUsage {
    return this._usage;
  }

  get modelId(): string | undefined {
    return this._modelId;
  }

  get contextWindow(): number | undefined {
    return this._contextWindow;
  }

  get stopReason(): string | undefined {
    return this._stopReason;
  }

  get errorMessage(): string | undefined {
    return this._errorMessage;
  }

  get preview(): string {
    return this._preview;
  }

  /** Bounded transcript view (same shape/limits as `transcriptFromMessages`). */
  transcript(): TranscriptEntry[] {
    return boundTranscriptEntries(this._entries);
  }

  /** Overlay the session's live context-window occupancy onto usage/capacity. */
  applyContextUsage(context: ContextUsage | undefined): void {
    if (
      typeof context?.tokens === "number" &&
      Number.isFinite(context.tokens) &&
      context.tokens >= 0
    ) {
      this._usage.contextTokens = context.tokens;
    }
    if (
      typeof context?.contextWindow === "number" &&
      Number.isFinite(context.contextWindow) &&
      context.contextWindow > 0
    ) {
      this._contextWindow = context.contextWindow;
    }
  }

  /** Fold one newly finalized message (any role) into the running state. */
  observeMessage(
    message: AgentMessage,
    sessionModel: WorkflowModel | undefined,
    modelRegistry: ExtensionContext["modelRegistry"],
    toolTimings: ReadonlyMap<string, ToolExecutionTiming>,
  ): void {
    if (message.role === "assistant") {
      foldAssistantUsage(this._usage, message);
      const info = assistantSyncInfo(message, sessionModel, modelRegistry);
      if (info.modelId !== undefined) this._modelId = info.modelId;
      if (info.contextWindow !== undefined) {
        this._contextWindow = info.contextWindow;
      }
      if (info.stopReason !== undefined) this._stopReason = info.stopReason;
      if (info.errorMessage !== undefined) {
        this._errorMessage = info.errorMessage;
      }
      const text = assistantText(message);
      if (text) this._preview = text;
    }
    this.appendEntries(entriesForMessage(message, toolTimings));
  }

  /** Refresh cached timing metadata for an already-recorded tool call/result pair. */
  patchToolTiming(
    toolCallId: string,
    toolTimings: ReadonlyMap<string, ToolExecutionTiming>,
  ): void {
    const indexes = this._toolEntryIndexes.get(toolCallId);
    if (!indexes) return;
    const metadata = toolMetadata(toolCallId, toolTimings);
    for (const index of indexes) {
      const entry = this._entries[index];
      if (entry) this._entries[index] = { ...entry, ...metadata };
    }
  }

  private appendEntries(entries: TranscriptEntry[]): void {
    for (const entry of entries) {
      const index = this._entries.length;
      this._entries.push(entry);
      if (entry.toolCallId) {
        const list = this._toolEntryIndexes.get(entry.toolCallId) ?? [];
        list.push(index);
        this._toolEntryIndexes.set(entry.toolCallId, list);
      }
    }
  }

  /**
   * Reset and refold over a (possibly compacted/replaced) message array.
   * Model/stop-reason/error fields are intentionally left as-is before the
   * refold: a compaction summary carries no assistant message of its own, so
   * if the new history contains none either, the prior "last observed"
   * values remain correct, matching the full-rescan behavior of only
   * overwriting them when a newer assistant message actually supplies one.
   */
  rebuild(
    messages: AgentMessage[],
    toolTimings: ReadonlyMap<string, ToolExecutionTiming>,
    sessionModel: WorkflowModel | undefined,
    modelRegistry: ExtensionContext["modelRegistry"],
  ): void {
    this._usage = emptyUsage();
    this._preview = "";
    this._entries = [];
    this._toolEntryIndexes.clear();
    for (const message of messages) {
      this.observeMessage(message, sessionModel, modelRegistry, toolTimings);
    }
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function formatTimeout(timeoutMs: number) {
  return timeoutMs % 1_000 === 0
    ? `${timeoutMs / 1_000} seconds`
    : `${timeoutMs} ms`;
}

/** Abort a provider call that opens but never emits its first assistant event. */
export function createFirstResponseWatchdog(
  onTimeout: () => Promise<unknown>,
  options: { timeoutMs?: number; model?: string } = {},
) {
  const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      const model = options.model ? ` for ${options.model}` : "";
      reject(
        new Error(
          `Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`,
        ),
      );
      void onTimeout().catch(() => {});
    }, timeoutMs);
    timer.unref?.();
  });

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    markResponse: cancel,
    async waitFor<T>(operation: Promise<T>) {
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        cancel();
      }
    },
  };
}

function isAssistantResponseEvent(event: AgentSessionEvent) {
  return (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "assistant"
  );
}

export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentOutcome> {
  let structured: unknown;
  let customTools: ToolDefinition[] | undefined;
  let session: WorkflowAgentSession | undefined;
  let unsubscribeToolTimeout: (() => void) | undefined;
  const createSession = options.createSession ?? createAgentSession;
  try {
    customTools =
      options.schema !== undefined
        ? [
            makeStructuredOutputTool(options.schema, (value) => {
              structured = value;
            }),
          ]
        : undefined;
    ({ session } = await createSession({
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      resourceLoader: options.loader,
      settingsManager: options.settingsManager,
      sessionManager: SessionManager.inMemory(options.cwd),
      ...(customTools ? { customTools } : {}),
      ...childToolPolicy(),
    }));
    await bindChildSessionExtensions(session);
    unsubscribeToolTimeout = guardWorkflowChildTools(
      session,
      options.toolCallTimeoutMs,
    );
  } catch (error) {
    unsubscribeToolTimeout?.();
    if (session) await shutdownAndDisposeChildSession(session);
    return {
      ok: false,
      output: "",
      error: `Failed to create agent session: ${errorText(error)}`,
      aborted: false,
      usage: emptyUsage(),
      model: options.model?.id,
      contextWindow: options.model?.contextWindow,
      transcript: [],
    };
  }

  const childSession = session;
  let usage = emptyUsage();
  let modelId = childSession.model?.id ?? options.model?.id;
  let contextWindow = childSession.model?.contextWindow;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  const toolTimings = new Map<string, ToolExecutionTiming>();

  const sync = () => {
    const messages = childSession.messages;
    usage = computeUsage(messages);

    const sessionModel = childSession.model;
    modelId = sessionModel?.id ?? modelId;
    contextWindow = sessionModel?.contextWindow ?? contextWindow;
    const context = childSession.getContextUsage();
    if (
      typeof context?.tokens === "number" &&
      Number.isFinite(context.tokens) &&
      context.tokens >= 0
    ) {
      usage.contextTokens = context.tokens;
    }
    if (
      typeof context?.contextWindow === "number" &&
      Number.isFinite(context.contextWindow) &&
      context.contextWindow > 0
    ) {
      contextWindow = context.contextWindow;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      // Some gateways report a concrete fallback model. Prefer its registry
      // metadata when available so capacity tracks the model that served the
      // latest response rather than a hardcoded/configured guess.
      const responseMatchesSession =
        !sessionModel ||
        (msg.provider === sessionModel.provider &&
          msg.model === sessionModel.id);
      const reportedId = msg.responseModel ?? msg.model;
      const reportedModel = responseMatchesSession
        ? options.modelRegistry.find(msg.provider, reportedId)
        : undefined;
      if (reportedModel) {
        modelId = reportedModel.id;
        contextWindow = reportedModel.contextWindow;
      }
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errorMessage = msg.errorMessage;
      break;
    }
  };

  // Incremental progress state for the onProgress hot path only: it folds
  // newly observed events in work proportional to the event, not the run's
  // history so far. The authoritative final usage/model/transcript above
  // still come from one full `sync()` rescan in the `finally` block below,
  // so a subtle incremental bug here can't corrupt the returned outcome.
  const progress = new IncrementalProgressTracker(modelId, contextWindow);
  const applyProgressContextUsage = () => {
    progress.applyContextUsage(childSession.getContextUsage());
  };

  let markFirstResponse = () => {};
  const unsubscribe = childSession.subscribe((event) => {
    if (isAssistantResponseEvent(event)) markFirstResponse();
    const sessionModel = childSession.model;
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      recordToolExecutionTiming(toolTimings, event);
      progress.patchToolTiming(event.toolCallId, toolTimings);
    } else if (event.type === "message_end") {
      progress.observeMessage(
        event.message,
        sessionModel,
        options.modelRegistry,
        toolTimings,
      );
    } else if (event.type === "compaction_end") {
      // The session replaced its whole message array (summary + surviving
      // tail); refold from scratch instead of trusting stale indexes/totals.
      progress.rebuild(
        childSession.messages,
        toolTimings,
        sessionModel,
        options.modelRegistry,
      );
    } else {
      return;
    }
    applyProgressContextUsage();
    options.onProgress?.({
      preview: progress.preview,
      usage: progress.usage,
      model: progress.modelId,
      contextWindow: progress.contextWindow,
      transcript: progress.transcript(),
    });
  });

  let aborted = false;
  let abortPromise: Promise<void> | undefined;
  const onAbort = () => {
    aborted = true;
    abortPromise ??= childSession.abort().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let output = "";
  let transcript: TranscriptEntry[] = [];
  try {
    if (!aborted) {
      const watchdog = createFirstResponseWatchdog(() => childSession.abort(), {
        timeoutMs: options.firstResponseTimeoutMs,
        model: modelId,
      });
      markFirstResponse = watchdog.markResponse;
      await watchdog.waitFor(
        childSession.prompt(buildWorkflowAgentPrompt(options.prompt)),
      );
    }
  } catch (error) {
    errorMessage = errorMessage ?? errorText(error);
    stopReason = stopReason ?? "error";
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (abortPromise) await abortPromise;
    unsubscribe();
    unsubscribeToolTimeout?.();
    sync();
    output = truncateUtf8(
      finalOutput(childSession.messages),
      AGENT_OUTPUT_MAX_BYTES,
    );
    transcript = transcriptFromMessages(childSession.messages, toolTimings);
    await shutdownAndDisposeChildSession(childSession);
  }

  if (aborted || stopReason === "aborted") {
    return {
      ok: false,
      output,
      structured,
      error: "Agent was aborted",
      aborted: true,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  const failed = stopReason === "error" || errorMessage !== undefined;
  if (failed) {
    return {
      ok: false,
      output,
      structured,
      error: errorMessage ?? "Agent failed",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      output,
      error:
        "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  return {
    ok: true,
    output,
    structured,
    aborted: false,
    usage,
    model: modelId,
    contextWindow,
    transcript,
  };
}
