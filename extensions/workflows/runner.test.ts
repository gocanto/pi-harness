import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  defineTool,
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChildResources } from "../shared/child-session.ts";
import {
  createFirstResponseWatchdog,
  guardWorkflowChildTools,
  recordToolExecutionTiming,
  runAgent,
  transcriptFromMessages,
  type AgentProgress,
  type CreateWorkflowAgentSession,
  type ToolExecutionTiming,
  type WorkflowModel,
} from "./runner.ts";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function parallelToolMessages(): AgentSession["messages"] {
  return [
    { role: "user", content: "run both", timestamp: 900 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-a",
          name: "first",
          arguments: { value: 1 },
        },
        {
          type: "toolCall",
          id: "call-b",
          name: "second",
          arguments: { value: 2 },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 950,
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "first",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1_040,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "second",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1_041,
    },
  ];
}

test("completed parallel tool calls pair lifecycle timings with calls and results", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    1_000,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "second",
      args: { value: 2 },
    },
    1_002,
  );
  // Parallel calls can finish in a different order than their result messages.
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "second",
      result: { content: [{ type: "text", text: "second result" }] },
      isError: false,
    },
    1_012,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "first",
      result: { content: [{ type: "text", text: "first result" }] },
      isError: false,
    },
    1_030,
  );

  const transcript = transcriptFromMessages(parallelToolMessages(), timings);
  const toolEntries = transcript.filter((entry) => entry.role === "tool");
  const resultEntries = transcript.filter(
    (entry) => entry.role === "toolResult",
  );

  for (const entries of [toolEntries, resultEntries]) {
    assert.deepEqual(
      entries.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
        toolCallId,
        startedAt,
        finishedAt,
        durationMs,
      })),
      [
        {
          toolCallId: "call-a",
          startedAt: 1_000,
          finishedAt: 1_030,
          durationMs: 30,
        },
        {
          toolCallId: "call-b",
          startedAt: 1_002,
          finishedAt: 1_012,
          durationMs: 10,
        },
      ],
    );
  }
});

test("in-flight aborted tool calls retain start timing without completion", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    2_000,
  );

  const transcript = transcriptFromMessages(
    parallelToolMessages().slice(0, 2),
    timings,
  );
  const first = transcript.find((entry) => entry.toolCallId === "call-a");

  assert.equal(first?.startedAt, 2_000);
  assert.equal(first?.finishedAt, undefined);
  assert.equal(first?.durationMs, undefined);
  assert.equal(
    transcript.some((entry) => entry.role === "toolResult"),
    false,
  );
});

test("first-response watchdog aborts a silent provider request", async () => {
  let aborted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /no assistant response event for fixture-model within 10 ms.*stalled/i,
  );
  assert.equal(aborted, true);
});

test("first assistant response disarms the watchdog without limiting the run", async () => {
  const watchdog = createFirstResponseWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("workflow children guard structured, normal, and dynamically registered tools", async () => {
  const structuredResult = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };
  const structured = {
    name: "structured_output",
    label: "Structured Output",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return structuredResult;
    },
  } satisfies ToolDefinition;
  const definitions = new Map<string, ToolDefinition>([
    [structured.name, structured],
  ]);
  let listener: AgentSessionEventListener | undefined;
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe(next: AgentSessionEventListener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  const unsubscribe = guardWorkflowChildTools(session, 10);
  assert.equal(await structured.execute(), structuredResult);

  let dynamicSignal: AbortSignal | undefined;
  const dynamic = {
    name: "dynamic_fixture",
    label: "Dynamic Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ) {
      dynamicSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  const originalDynamicExecute = dynamic.execute;
  definitions.set(dynamic.name, dynamic);
  listener?.({ type: "agent_start" });
  assert.notEqual(dynamic.execute, originalDynamicExecute);

  await assert.rejects(
    dynamic.execute("fixture", {}, undefined),
    /Tool call "dynamic_fixture" timed out after 10 ms\./,
  );
  assert.equal(dynamicSignal?.aborted, true);
  unsubscribe();
});

// -- runAgent full-lifecycle coverage ---------------------------------------
//
// runAgent() only ever talks to its AgentSession through the narrow
// WorkflowAgentSession seam (see runner.ts), so these tests inject a fake
// session via RunAgentOptions.createSession instead of driving a real
// provider. Everything else (cwd, resource loader, settings manager, model
// registry) is real, deterministic, and network-free.

type SessionMessage = AgentSession["messages"][number];
type AssistantSessionMessage = Extract<SessionMessage, { role: "assistant" }>;

function fixtureModel(overrides: Partial<WorkflowModel> = {}): WorkflowModel {
  return {
    id: "fixture-model",
    name: "Fixture Model",
    api: "fixture-api",
    provider: "fixture-provider",
    baseUrl: "https://fixture.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

function assistantTextMessage(
  text: string,
  overrides: Partial<AssistantSessionMessage> = {},
): AssistantSessionMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fixture-api",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// SAFETY: neither the production structured_output tool nor the fixture
// tools built for these tests read their ExtensionContext argument. This
// throwaway value only satisfies ToolDefinition.execute's required
// parameter so tests can invoke the real tool objects runAgent registers,
// without modeling a full extension runtime context.
const fixtureExtensionContext = {} as ExtensionContext;

interface FakeSessionControl {
  /** Custom tools passed into session creation (e.g. structured_output). */
  readonly customTools: ToolDefinition[] | undefined;
  appendMessage(message: SessionMessage): void;
  emit(event: AgentSessionEvent): void;
  getToolDefinition(name: string): ToolDefinition | undefined;
  /** Resolves once runAgent calls session.abort() in response to its signal. */
  awaitAbort(): Promise<void>;
}

interface FakeSessionSpec {
  model?: WorkflowModel;
  /** Tool definitions the fake session exposes in addition to customTools. */
  extraTools?: ToolDefinition[];
  /** Drives the "agent": push messages, emit events, react to abort. */
  respond(control: FakeSessionControl): Promise<void>;
  /** Override to simulate a session that fails to bind extensions. */
  bindExtensions?: () => Promise<void>;
}

interface FakeSessionHandle {
  createSession: CreateWorkflowAgentSession;
  disposeCount(): number;
  abortCount(): number;
}

/** Build an injectable session factory around a deterministic fixture script. */
function createFakeSessionHandle(spec: FakeSessionSpec): FakeSessionHandle {
  let disposeCount = 0;
  let abortCount = 0;
  let resolveAbort: (() => void) | undefined;
  const abortSignal = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  const createSession: CreateWorkflowAgentSession = async (creationOptions) => {
    const messages: SessionMessage[] = [];
    const listeners = new Set<AgentSessionEventListener>();
    const tools = new Map<string, ToolDefinition>(
      [...(creationOptions.customTools ?? []), ...(spec.extraTools ?? [])].map(
        (tool) => [tool.name, tool] as const,
      ),
    );

    const control: FakeSessionControl = {
      customTools: creationOptions.customTools,
      appendMessage(message) {
        messages.push(message);
      },
      emit(event) {
        for (const listener of listeners) listener(event);
      },
      getToolDefinition: (name) => tools.get(name),
      awaitAbort: () => abortSignal,
    };

    return {
      session: {
        model: spec.model,
        messages,
        getContextUsage: () => undefined,
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        getToolDefinition: (name) => tools.get(name),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        bindExtensions: spec.bindExtensions ?? (async () => {}),
        prompt: () => spec.respond(control),
        abort: async () => {
          abortCount++;
          resolveAbort?.();
        },
        dispose: () => {
          disposeCount++;
        },
        extensionRunner: {
          hasHandlers: () => false,
          emit: async () => undefined,
        },
      },
    };
  };

  return {
    createSession,
    disposeCount: () => disposeCount,
    abortCount: () => abortCount,
  };
}

let sharedModelRegistry: Promise<ModelRegistry> | undefined;

/** A real, network-free ModelRegistry: no auth file, no bundled models.json read. */
function getFixtureModelRegistry(): Promise<ModelRegistry> {
  sharedModelRegistry ??= ModelRuntime.create({
    authPath: path.join(tmpdir(), "pi-workflow-runner-fixture-auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  }).then((runtime) => new ModelRegistry(runtime));
  return sharedModelRegistry;
}

interface RunAgentEnv {
  cwd: string;
  loader: Awaited<ReturnType<typeof createChildResources>>["loader"];
  settingsManager: Awaited<
    ReturnType<typeof createChildResources>
  >["settingsManager"];
  modelRegistry: ModelRegistry;
}

/** Real, trust-gated resources rooted in a scratch directory; torn down after use. */
async function withRunAgentEnv<T>(
  run: (env: RunAgentEnv) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-workflow-runner-"));
  try {
    const { loader, settingsManager } = await createChildResources({
      cwd,
      agentDir: path.join(cwd, "agent"),
      projectTrusted: false,
    });
    const modelRegistry = await getFixtureModelRegistry();
    return await run({ cwd, loader, settingsManager, modelRegistry });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("runAgent completes a plain prompt, reports progress, and disposes the session once", async () => {
  await withRunAgentEnv(async (env) => {
    const progressUpdates: AgentProgress[] = [];
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      respond: async (control) => {
        control.appendMessage({
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "first", arguments: {} },
          ],
          api: "fixture-api",
          provider: "fixture-provider",
          model: "fixture-model",
          usage: zeroUsage,
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        control.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "first",
          args: {},
        });
        control.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "first",
          content: [{ type: "text", text: "first result" }],
          isError: false,
          timestamp: Date.now(),
        });
        control.emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "first",
          result: { content: [{ type: "text", text: "first result" }] },
          isError: false,
        });
        const final = assistantTextMessage("Hello from the fixture agent.");
        control.appendMessage(final);
        control.emit({ type: "message_end", message: final });
      },
    });

    const outcome = await runAgent({
      prompt: "say hello",
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
      onProgress: (progress) => progressUpdates.push(progress),
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.output, "Hello from the fixture agent.");
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.model, "fixture-model");
    assert.equal(outcome.usage.turns, 2);
    assert.equal(
      outcome.transcript.some(
        (entry) => entry.role === "toolResult" && entry.name === "first",
      ),
      true,
    );

    assert.equal(progressUpdates.length, 3);
    assert.equal(
      progressUpdates[progressUpdates.length - 1]?.preview,
      "Hello from the fixture agent.",
    );

    assert.equal(handle.disposeCount(), 1);
    assert.equal(handle.abortCount(), 0);
  });
});

test("runAgent captures a structured_output payload produced by the real tool", async () => {
  await withRunAgentEnv(async (env) => {
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      respond: async (control) => {
        const structuredTool = control.customTools?.find(
          (tool) => tool.name === "structured_output",
        );
        assert.ok(
          structuredTool,
          "expected runAgent to register a structured_output tool",
        );
        const payload = { headline: "release notes", ok: true };
        const result = await structuredTool.execute(
          "call-1",
          payload,
          undefined,
          undefined,
          fixtureExtensionContext,
        );
        control.appendMessage({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "structured_output",
              arguments: payload,
            },
          ],
          api: "fixture-api",
          provider: "fixture-provider",
          model: "fixture-model",
          usage: zeroUsage,
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        control.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "structured_output",
          content: result.content,
          isError: false,
          timestamp: Date.now(),
        });
        const final = assistantTextMessage("Recorded structured result.");
        control.appendMessage(final);
        control.emit({ type: "message_end", message: final });
      },
    });

    const outcome = await runAgent({
      prompt: "produce json",
      schema: {
        type: "object",
        properties: {
          headline: { type: "string" },
          ok: { type: "boolean" },
        },
        required: ["headline", "ok"],
      },
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.structured, {
      headline: "release notes",
      ok: true,
    });
    assert.equal(handle.disposeCount(), 1);
  });
});

test("runAgent fails when a schema is supplied but structured_output is never called", async () => {
  await withRunAgentEnv(async (env) => {
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      respond: async (control) => {
        const final = assistantTextMessage("I did not call the tool.");
        control.appendMessage(final);
        control.emit({ type: "message_end", message: final });
      },
    });

    const outcome = await runAgent({
      prompt: "produce json",
      schema: { type: "object", properties: {} },
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.structured, undefined);
    assert.match(
      outcome.error ?? "",
      /finished without calling structured_output/,
    );
    assert.equal(handle.disposeCount(), 1);
  });
});

test("runAgent reports a provider/session error without throwing", async () => {
  await withRunAgentEnv(async (env) => {
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      respond: async (control) => {
        const errored = assistantTextMessage("", {
          content: [],
          stopReason: "error",
          errorMessage: "The upstream provider returned a 500.",
        });
        control.appendMessage(errored);
        control.emit({ type: "message_end", message: errored });
      },
    });

    const outcome = await runAgent({
      prompt: "say hello",
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.error, "The upstream provider returned a 500.");
    assert.equal(handle.disposeCount(), 1);
  });
});

test("runAgent settles as aborted and cleans up when its signal fires mid-request", async () => {
  await withRunAgentEnv(async (env) => {
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      respond: async (control) => {
        await control.awaitAbort();
      },
    });
    const controller = new AbortController();

    const runPromise = runAgent({
      prompt: "say hello",
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const outcome = await runPromise;

    assert.equal(outcome.ok, false);
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.error, "Agent was aborted");
    assert.equal(handle.abortCount(), 1);
    assert.equal(handle.disposeCount(), 1);
  });
});

test("runAgent enforces the per-tool call timeout on tools the session exposes", async () => {
  await withRunAgentEnv(async (env) => {
    const slowTool = defineTool({
      name: "slow_tool",
      label: "Slow Tool",
      description: "fixture tool that never resolves",
      parameters: Type.Object({}),
      async execute() {
        return new Promise<never>(() => {});
      },
    });
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      extraTools: [slowTool],
      respond: async (control) => {
        const guarded = control.getToolDefinition("slow_tool");
        assert.ok(guarded, "expected the timeout guard to preserve the tool");
        await assert.rejects(
          guarded.execute(
            "call-1",
            {},
            undefined,
            undefined,
            fixtureExtensionContext,
          ),
          /Tool call "slow_tool" timed out after 5 ms\./,
        );
        control.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "slow_tool",
          content: [
            {
              type: "text",
              text: 'Tool call "slow_tool" timed out after 5 ms.',
            },
          ],
          isError: true,
          timestamp: Date.now(),
        });
        const final = assistantTextMessage("Continuing without the slow tool.");
        control.appendMessage(final);
        control.emit({ type: "message_end", message: final });
      },
    });

    const outcome = await runAgent({
      prompt: "use the slow tool",
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
      toolCallTimeoutMs: 5,
    });

    assert.equal(outcome.ok, true);
    assert.equal(
      outcome.transcript.some(
        (entry) =>
          entry.role === "toolResult" &&
          entry.isError === true &&
          /timed out after 5 ms/.test(entry.text),
      ),
      true,
    );
    assert.equal(handle.disposeCount(), 1);
  });
});

test("runAgent reports session-creation failure without throwing or leaking a session", async () => {
  await withRunAgentEnv(async (env) => {
    const failingCreateSession: CreateWorkflowAgentSession = async () => {
      throw new Error("no auth configured for fixture-provider");
    };

    const outcome = await runAgent({
      prompt: "say hello",
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: failingCreateSession,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.aborted, false);
    assert.match(
      outcome.error ?? "",
      /Failed to create agent session: no auth configured for fixture-provider/,
    );
    assert.deepEqual(outcome.transcript, []);
  });
});

test("runAgent disposes a session that fails to bind extensions during setup", async () => {
  await withRunAgentEnv(async (env) => {
    const handle = createFakeSessionHandle({
      model: fixtureModel(),
      bindExtensions: async () => {
        throw new Error("extension bind exploded");
      },
      respond: async () => {},
    });

    const outcome = await runAgent({
      prompt: "say hello",
      cwd: env.cwd,
      loader: env.loader,
      settingsManager: env.settingsManager,
      modelRegistry: env.modelRegistry,
      createSession: handle.createSession,
    });

    assert.equal(outcome.ok, false);
    assert.match(
      outcome.error ?? "",
      /Failed to create agent session: extension bind exploded/,
    );
    assert.equal(handle.disposeCount(), 1);
  });
});
