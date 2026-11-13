import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  NodeId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { makeAssistantStreamingFilter } from "../assistantStreaming.ts";
import { makeProviderEventRoutingState, routeProviderEvent } from "../RunExecutionService.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  knownProviderFailureMessage,
  refusedBeforePrompt,
} from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2ThreadSnapshot,
  ProviderCompactionUnsupportedError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { KiroSettings } from "@t3tools/provider-kiro/settings";
import {
  KIRO_PROVIDER,
  kiroApprovalOptions,
  kiroContextUsageFromSession,
  kiroContextUsageFromSessionUpdate,
  kiroModelContextWindow,
  kiroAutopilotValue,
  type KiroSkills,
  kiroPermissionDisposition,
  makeKiroAdapterV2,
  makeKiroAcpRuntime,
  makeKiroSkills,
} from "@t3tools/provider-kiro/testing";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const SESSION_ID = "sess_abb5e0cf-d4a2-4360-9f03-2f8f0889a707";
const decodeKiroTestSettings = Schema.decodeSync(KiroSettings);
const ENABLED_KIRO_SETTINGS = decodeKiroTestSettings({ enabled: true });

it("reports context windows only for explicit known Kiro models", () => {
  const selection = (model: string): ModelSelection => ({
    instanceId: ProviderInstanceId.make("kiro"),
    model,
  });
  assert.equal(kiroModelContextWindow(selection("claude-opus-5.5")), 1_000_000);
  assert.equal(kiroModelContextWindow(selection("claude-haiku-4.5")), 200_000);
  assert.equal(kiroModelContextWindow(selection("gpt-5.6-sol")), 986_000);
  assert.equal(kiroModelContextWindow(selection("deepseek-3.2")), 164_000);
  assert.equal(kiroModelContextWindow(selection("minimax-m2.5")), 196_000);
  assert.equal(kiroModelContextWindow(selection("minimax-m2.1")), 196_000);
  assert.isUndefined(kiroModelContextWindow(selection("auto")));
  assert.isUndefined(kiroModelContextWindow(selection("default")));
  assert.isUndefined(kiroModelContextWindow(selection("custom-model")));
});

it("maps only valid context telemetry for the model that Kiro loaded", () => {
  const selection = (model: string): ModelSelection => ({
    instanceId: ProviderInstanceId.make("kiro"),
    model,
  });
  const session = (input: {
    readonly model?: string;
    readonly contextUsage: unknown;
  }): AcpSessionRuntime.AcpSessionRuntimeStartResult =>
    ({
      sessionId: SESSION_ID,
      sessionSetupResult: {
        _meta: { contextUsage: input.contextUsage },
        configOptions:
          input.model === undefined
            ? []
            : [
                {
                  type: "select",
                  id: "model",
                  name: "Model",
                  currentValue: input.model,
                  options: [],
                },
              ],
      },
    }) as unknown as AcpSessionRuntime.AcpSessionRuntimeStartResult;

  const loaded = session({
    model: " claude-opus-5.5 ",
    contextUsage: {
      usagePercentage: 29.5217,
      summarizationThreshold: 80,
      truncationThreshold: 95,
    },
  });
  assert.deepEqual(
    kiroContextUsageFromSession({ selection: selection("claude-opus-5.5"), session: loaded }),
    {
      usedTokens: 295_217,
      maxTokens: 1_000_000,
      compactsAutomatically: true,
      autoCompactThreshold: 800_000,
    },
  );
  assert.isNull(
    kiroContextUsageFromSession({ selection: selection("claude-sonnet-4.5"), session: loaded }),
  );
  assert.isNull(kiroContextUsageFromSession({ selection: selection("auto"), session: loaded }));
  assert.isUndefined(
    kiroContextUsageFromSession({
      selection: selection("claude-opus-5.5"),
      session: session({ contextUsage: { usagePercentage: 10 } }),
    }),
  );
  assert.isNull(
    kiroContextUsageFromSession({
      selection: selection("claude-opus-5.5"),
      session: session({ model: "claude-opus-5.5", contextUsage: { usagePercentage: 101 } }),
    }),
  );

  const withoutThreshold = session({
    model: "claude-opus-5.5",
    contextUsage: { usagePercentage: 10, summarizationThreshold: 0 },
  });
  assert.deepEqual(
    kiroContextUsageFromSession({
      selection: selection("claude-opus-5.5"),
      session: withoutThreshold,
    }),
    { usedTokens: 100_000, maxTokens: 1_000_000 },
  );
  assert.isUndefined(
    kiroContextUsageFromSessionUpdate({
      selection: selection("claude-opus-5.5"),
      session: loaded,
      notification: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { kiro: { contextUsage: { usagePercentage: -1 } } },
        },
      } as EffectAcpSchema.SessionNotification,
    }),
  );
});

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>", label = method): Frame => ({
  type: "expect_outbound",
  label,
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown, label = `${method}.result`): Frame => ({
  type: "emit_inbound",
  label,
  frame: { kind: "response", method, result },
});
const update = (sessionUpdate: Record<string, unknown>): Frame => ({
  type: "emit_inbound",
  label: `update.${String(sessionUpdate.sessionUpdate)}`,
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId: SESSION_ID, update: sessionUpdate },
  },
});
const kiroNotification = (method: string, params: unknown): Frame => ({
  type: "emit_inbound",
  label: method,
  frame: { kind: "notification", method, params },
});

/**
 * Kiro CLI 2.27.0 (KAS 0.66.22) `initialize` result, recorded with
 * `kiro-cli acp --agent-engine=v3 --auth-method=cli`. Only the extension
 * method list is shortened and the log paths dropped.
 */
const KIRO_V3_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: {
      list: {},
      close: {},
      delete: {},
      fork: { _meta: { kiro: { messageId: true } } },
    },
    _meta: {
      kiro: {
        checkpoints: true,
        sessionList: true,
        policyNotifications: true,
        extensionMethods: ["_kiro/session/context", "_kiro/session/compact", "_kiro/knowledge"],
        sessionSources: ["local", "remote"],
        sessionListScopes: ["workspace", "user"],
        executionTargets: ["local", "cloud-sandbox"],
        replayMarking: true,
      },
    },
  },
  authMethods: [
    { id: "aws-builder-id", name: "AWS Builder ID" },
    { id: "aws-iam-identity-center", name: "AWS IAM Identity Center" },
  ],
};

/** A deployment that advertises no Kiro extensions at all. */
const KIRO_V3_INITIALIZE_WITHOUT_EXTENSIONS = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
  },
  authMethods: [],
};

const option = (value: string, name = value) => ({ value, name });
const autopilotOption = (currentValue: "on" | "off") => ({
  type: "select",
  id: "autopilot",
  name: "Autopilot",
  currentValue,
  options: [option("on", "Autopilot"), option("off", "Supervised")],
});
const modeOption = {
  type: "select",
  id: "mode",
  name: "Mode",
  category: "mode",
  currentValue: "vibe",
  options: [option("vibe", "Default"), option("spec", "Spec"), option("plan", "Plan")],
};
// Recorded sessions without a signed-in account carry no `model` option; the
// migration guide documents it as `configId: "model"`.
const modelOption = (currentValue: string) => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue,
  options: [option("auto", "Auto"), option("claude-sonnet", "Claude Sonnet")],
});

/**
 * Kiro's `model` option as 2.27.0 advertises it (fixtures/kiro_model_switch),
 * trimmed to three choices. Each choice's `_meta.kiro` names its effort levels.
 */
const kiroModelChoice = (
  value: string,
  name: string,
  effort?: { readonly levels: ReadonlyArray<string>; readonly defaultLevel: string },
) => ({
  value,
  name,
  _meta: {
    kiro:
      effort === undefined
        ? { hasEffort: false, thinkingToggleable: false }
        : {
            hasEffort: true,
            effortSchemaPath: "output_config",
            effortLevels: effort.levels,
            defaultEffortLevel: effort.defaultLevel,
            thinkingToggleable: false,
          },
  },
});
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_4_6_EFFORT_LEVELS = ["low", "medium", "high", "max"];
const kiroModelOption = (currentValue: string) => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue,
  options: [
    kiroModelChoice("auto", "Auto"),
    kiroModelChoice("claude-opus-5.5", "Claude Opus 5.5", {
      levels: CLAUDE_EFFORT_LEVELS,
      defaultLevel: "medium",
    }),
    kiroModelChoice("claude-opus-4.6", "Claude Opus 4.6", {
      levels: CLAUDE_4_6_EFFORT_LEVELS,
      defaultLevel: "high",
    }),
    kiroModelChoice("claude-sonnet-4.5", "Claude Sonnet 4.5"),
  ],
});
/**
 * Kiro's effort option as kiro-cli 2.27.0 advertised it to a direct ACP probe
 * on Claude Opus 5.5: a `thought_level` select with id `effortLevel`, present
 * only while a model with effort runs and starting at that model's default
 * level. No replay fixture records it yet.
 */
const effortOption = (currentValue: string, levels: ReadonlyArray<string>) => ({
  type: "select",
  id: "effortLevel",
  name: "Effort",
  category: "thought_level",
  currentValue,
  options: levels.map((level) => option(level)),
});
const setConfig = (configId: string, value: string) =>
  outbound("session/set_config_option", { sessionId: SESSION_ID, configId, value });
const configResult = (configOptions: ReadonlyArray<unknown>) =>
  answer("session/set_config_option", { configOptions });
const reasoning = (value: string) => [{ id: "reasoningEffort", value }];

/** Kiro's `session/new` result, recorded from 2.27.0 and trimmed to what T3 reads. */
const sessionSetup = (configOptions: ReadonlyArray<unknown>) => ({
  _meta: { schemaVersion: "1.0.0", id: SESSION_ID, agentMode: "vibe", source: "local" },
  sessionId: SESSION_ID,
  modes: {
    currentModeId: "vibe",
    availableModes: [
      { id: "vibe", name: "Default" },
      { id: "spec", name: "Spec" },
      { id: "plan", name: "Plan" },
    ],
  },
  configOptions,
});

/** What Kiro sends right after `initialize` and around `session/new`, all unknown to T3. */
const kiroSessionNoise: ReadonlyArray<Frame> = [
  kiroNotification("_kiro/mcp/status", { sessionId: SESSION_ID, servers: [] }),
  kiroNotification("_kiro/sessions/changed", { upserted: [], deleted: [] }),
];

// Kiro advertises `sessionCapabilities.close`, so T3 closes the session on teardown.
const closeSession: ReadonlyArray<Frame> = [
  outbound("session/close", { sessionId: SESSION_ID }),
  answer("session/close", {}),
];

const turnPrompt = outbound("session/prompt", {
  sessionId: SESSION_ID,
  prompt: "<any>",
});

const openSessionFrames = (input: {
  readonly initialize: unknown;
  readonly configOptions: ReadonlyArray<unknown>;
  readonly sessionMeta?: NonNullable<EffectAcpSchema.NewSessionResponse["_meta"]>;
}): ReadonlyArray<Frame> => [
  outbound("initialize"),
  answer("initialize", input.initialize),
  outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
  ...kiroSessionNoise,
  answer("session/new", {
    ...sessionSetup(input.configOptions),
    ...(input.sessionMeta === undefined ? {} : { _meta: input.sessionMeta }),
  }),
  // Supervised threads run Kiro with Autopilot off, its native ask-first posture.
  outbound("session/set_config_option", {
    sessionId: SESSION_ID,
    configId: "autopilot",
    value: "off",
  }),
  answer("session/set_config_option", {
    configOptions: input.configOptions.map((entry) =>
      (entry as { id: string }).id === "autopilot" ? autopilotOption("off") : entry,
    ),
  }),
];

/** Kiro keys an MCP server's OAuth tokens by a hash of the server; the value is a JSON string. */
const MCP_TOKENS_KEY = "kiro.mcp.4f1c2a9e.tokens";
const MCP_TOKENS = JSON.stringify({ access_token: "stored-token", token_type: "Bearer" });

const kiroSecretRequest = (method: string, params: unknown): Frame => ({
  type: "emit_inbound",
  label: method,
  frame: { kind: "request", method, params },
});
const kiroSecretResponse = (method: string, result: unknown): Frame => ({
  type: "expect_outbound",
  label: `${method}.result`,
  frame: { kind: "response", method, result },
});

/**
 * A temp KIRO_HOME whose `secrets.json` holds `secrets`, the flat map kiro-cli
 * keeps there. HOME points elsewhere so only KIRO_HOME can find the file.
 */
const makeKiroHome = Effect.fn("makeKiroHome")(function* (secrets: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-home-" });
  const kiroHome = path.join(root, "kiro-home");
  const home = path.join(root, "home");
  yield* fileSystem.makeDirectory(kiroHome);
  yield* fileSystem.makeDirectory(home);
  const secretsPath = path.join(kiroHome, "secrets.json");
  yield* fileSystem.writeFileString(secretsPath, JSON.stringify(secrets, null, 2));
  return { secretsPath, environment: { HOME: home, KIRO_HOME: kiroHome } };
});

const runKiroScript = Effect.fn("runKiroScript")(function* (input: {
  readonly scenario: string;
  readonly settings?: Partial<typeof ENABLED_KIRO_SETTINGS>;
  readonly frames: ReadonlyArray<Frame>;
  /** Frames for the runtime a rollback starts, replayed by a second agent process. */
  readonly replacementFrames?: ReadonlyArray<Frame>;
  readonly model?: string;
  readonly initialNativeThreadId?: string;
  readonly defaultModel?: string;
  /** Option selections (e.g. reasoningEffort) for the session and `startTurn`. */
  readonly options?: ModelSelection["options"];
  readonly runtimeMode?: RuntimeMode;
  readonly policyOverrides?: Partial<ProviderAdapterV2RuntimePolicy>;
  readonly expectedOpenFailure?: string;
  readonly inspectRuntime?: (
    input: Parameters<NonNullable<Parameters<typeof makeKiroAdapterV2>[0]["makeRuntime"]>>[0],
  ) => void;
  readonly environment?: NodeJS.ProcessEnv;
  /** Holds the script's inbound frames at labels the test releases. */
  readonly replayGate?: ProviderReplayGate;
  readonly testHooks?: Parameters<typeof makeKiroAdapterV2>[0]["testHooks"];
  readonly onSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => Effect.Effect<void>;
  /** Wraps the runtime's `session/cancel` send. */
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly wrapCancel?: (
    send: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  /** Wraps the runtime's `session/prompt` send. */
  readonly wrapPrompt?: (
    send: AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"];
  /** The user's message text for every turn. */
  readonly text?: string;
  readonly title?: string;
  readonly transformTurn?: (turn: ProviderAdapterV2TurnInput) => ProviderAdapterV2TurnInput;
  /** Where the adapter records advertised skills. */
  readonly skills?: KiroSkills;
  readonly drive: (session: {
    readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
    readonly startTurn: Effect.Effect<void, ProviderAdapterV2Error>;
    readonly readSnapshot: (
      nativeId?: string,
    ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
    /** Starts turn `ordinal` (from 1) on `model`, with `options` if given. */
    readonly startTurnInMode: (
      ordinal: number,
      mode: RuntimeMode,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly startTurnOn: (
      ordinal: number,
      model: string,
      options?: ModelSelection["options"],
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    /** Runs T3's compact action as turn `ordinal`. */
    readonly compact: (ordinal: number) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly interrupt: (
      providerTurnId: ProviderTurnId,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly respond: (
      requestId: RuntimeRequestId,
      decision: ProviderApprovalDecision,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly answerQuestion: (
      requestId: RuntimeRequestId,
      answers?: ProviderUserInputAnswers,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly forceReplacement: (
      policy: Partial<ProviderAdapterV2RuntimePolicy>,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly rollbackToStart: Effect.Effect<void, ProviderAdapterV2Error>;
    readonly disconnect: Effect.Effect<void>;
    readonly ensureTitle: (title: string) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly resume: Effect.Effect<void, ProviderAdapterV2Error>;

    readonly hasPendingBackgroundWork: Effect.Effect<boolean>;
    readonly stopWorkflow: (taskId: string) => Effect.Effect<void, ProviderAdapterV2Error>;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-kiro-${input.scenario}-`,
  });
  const scripts = yield* Effect.forEach(
    [input.frames, ...(input.replacementFrames === undefined ? [] : [input.replacementFrames])],
    (frames, index) =>
      decodeAcpReplayTranscript(
        {
          provider: KIRO_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: input.scenario,
          entries: frames as never,
        },
        KIRO_PROVIDER,
      ).pipe(
        Effect.map((transcript) => ({
          transcript,
          statusPath: path.join(replayDir, `status-${index}.json`),
        })),
      ),
  );
  let runtimesMade = 0;
  let disconnect: Effect.Effect<void> = Effect.die("No replay runtime started");
  const instanceId = ProviderInstanceId.make(`kiro-${input.scenario}`);
  const scriptPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
  );
  const adapter = yield* makeKiroAdapterV2({
    instanceId,
    settings: { ...ENABLED_KIRO_SETTINGS, ...input.settings },
    environment: input.environment ?? {
      HOME: path.join(replayDir, "home"),
      KIRO_HOME: path.join(replayDir, "kiro"),
    },
    selfInvocation: yield* resolveSelfInvocation(),
    ...(input.defaultModel === undefined
      ? {}
      : { defaultModel: Effect.succeed(input.defaultModel) }),
    makeRuntime: (runtimeInput) => {
      input.inspectRuntime?.(runtimeInput);
      const script = scripts[runtimesMade++];
      if (script === undefined) {
        // An unscripted runtime is a retry after the last one failed; report why it failed.
        const last = scripts[scripts.length - 1]!;
        return makeAcpReplayCompletenessAssertion(
          fileSystem,
          last.statusPath,
          last.transcript,
        ).pipe(Effect.andThen(Effect.die(`No replay script for Kiro runtime ${runtimesMade}`)));
      }
      return makeAcpReplayRuntime({
        ...script,
        scriptPath,
        childProcessSpawner: {
          ...childProcessSpawner,
          spawn: (command) =>
            childProcessSpawner.spawn(command).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  disconnect = handle.kill().pipe(Effect.orDie);
                }),
              ),
            ),
        },
        fileSystem,
        ...(input.replayGate === undefined ? {} : { replayGate: input.replayGate }),
      })(runtimeInput).pipe(
        Effect.map((original) => {
          const runtime = input.wrapRuntime?.(original) ?? original;
          return {
            ...runtime,
            handleSessionUpdate: (handler) =>
              runtime.handleSessionUpdate((notification) =>
                handler(notification).pipe(
                  Effect.andThen(input.onSessionUpdate?.(notification) ?? Effect.void),
                ),
              ),
            ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
            ...(input.wrapPrompt === undefined ? {} : { prompt: input.wrapPrompt(runtime.prompt) }),
          };
        }),
      );
    },
    ...(input.testHooks === undefined ? {} : { testHooks: input.testHooks }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
  });
  // Held frames must not outlive a failed drive and wedge teardown.
  yield* Effect.addFinalizer(() => Effect.sync(() => input.replayGate?.releaseAll()));
  const threadId = ThreadId.make(`thread-kiro-${input.scenario}`);
  const modelSelection = {
    instanceId,
    model: input.model ?? "default",
    ...(input.options === undefined ? {} : { options: input.options }),
  };
  let runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: "default",
    cwd: replayDir,
    ...input.policyOverrides,
  });
  yield* Effect.gen(function* () {
    const open = adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-kiro-${input.scenario}`),
      modelSelection,
      runtimePolicy,
      ...(input.initialNativeThreadId === undefined
        ? {}
        : { initialNativeThreadId: input.initialNativeThreadId }),
    });
    if (input.expectedOpenFailure !== undefined) {
      const result = yield* Effect.exit(open);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        assert.include(Cause.pretty(result.cause), input.expectedOpenFailure);
        const guidance = knownProviderFailureMessage(Cause.squash(result.cause));
        assert.include(guidance ?? "", "Native Approve for Me");
        assert.include(guidance ?? "", "Supervised");
      }
      return;
    }
    const session = yield* open;
    let providerThread = yield* session.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    const turnInput = (
      ordinal: number,
      model: string,
      options?: ModelSelection["options"],
      text = input.text ?? "Say hello",
    ): ProviderAdapterV2TurnInput => {
      const suffix = `${threadId}:${ordinal}`;
      const turnSelection = { instanceId, model, ...(options === undefined ? {} : { options }) };
      const turn: ProviderAdapterV2TurnInput = {
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${threadId}`),
          title: input.title ?? "Kiro adapter test",
          providerInstanceId: instanceId,
          modelSelection: turnSelection,
          runtimeMode: runtimePolicy.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make(`run:${suffix}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt:${suffix}`),
        rootNodeId: NodeId.make(`node:${suffix}`),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${suffix}`),
          text,
          attachments: [],
        },
        modelSelection: turnSelection,
        runtimePolicy,
      };
      return input.transformTurn?.(turn) ?? turn;
    };
    const startTurnOn = (ordinal: number, model: string, options?: ModelSelection["options"]) =>
      session.startTurn(turnInput(ordinal, model, options));
    const compact = (ordinal: number) =>
      session.compactThread === undefined
        ? Effect.die("Kiro adapter does not offer compactThread")
        : session.compactThread(
            turnInput(ordinal, modelSelection.model, input.options, "/compact"),
          );
    yield* input.drive({
      events: session.events,
      readSnapshot: (nativeId) =>
        session.readThreadSnapshot({
          providerThread:
            nativeId === undefined
              ? providerThread
              : {
                  ...providerThread,
                  nativeThreadRef: { driver: KIRO_PROVIDER, nativeId, strength: "strong" },
                },
        }),
      startTurn: startTurnOn(1, modelSelection.model, input.options),
      startTurnOn,
      startTurnInMode: (ordinal, mode) =>
        Effect.suspend(() => {
          runtimePolicy = { ...runtimePolicy, runtimeMode: mode };
          return startTurnOn(ordinal, modelSelection.model, input.options);
        }),
      compact,
      interrupt: (providerTurnId) => session.interruptTurn({ providerThread, providerTurnId }),
      respond: (requestId, decision) => session.respondToRuntimeRequest({ requestId, decision }),
      answerQuestion: (requestId, answers) =>
        session.respondToRuntimeRequest({
          requestId,
          ...(answers === undefined ? {} : { answers }),
        }),
      disconnect: Effect.suspend(() => disconnect),
      ensureTitle: (title) =>
        session
          .ensureThread({ threadId, modelSelection, runtimePolicy, title })
          .pipe(Effect.asVoid),
      resume: Effect.suspend(() =>
        session.resumeThread({ providerThread, modelSelection, runtimePolicy }),
      ).pipe(Effect.asVoid),
      forceReplacement: (overrides) =>
        Effect.gen(function* () {
          const nextPolicy = { ...runtimePolicy, ...overrides };
          const replacement = yield* session.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: nextPolicy,
            forceNewNativeThread: true,
          });
          providerThread = replacement;
          runtimePolicy = nextPolicy;
        }),
      rollbackToStart: session
        .rollbackThread({
          providerThread,
          providerThreadTurns: [],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make(`checkpoint-kiro-${input.scenario}`),
            appRunOrdinal: 0,
          },
        })
        .pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              providerThread = snapshot.providerThread;
            }),
          ),
          Effect.asVoid,
        ),

      hasPendingBackgroundWork: session.hasPendingBackgroundWork ?? Effect.succeed(false),
      stopWorkflow: (taskId) =>
        session.stopTask === undefined
          ? Effect.die("Kiro workflow cancellation is unavailable")
          : session.stopTask({ providerThread, taskId }),
    });
  }).pipe(Effect.scoped);
  // Closing the session stops the replay agents; every scripted frame must be used.
  yield* Effect.forEach(
    scripts,
    ({ statusPath, transcript }) =>
      makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
    { discard: true },
  );
});

const nativeTitleInitialize = {
  ...KIRO_V3_INITIALIZE,
  agentCapabilities: {
    ...KIRO_V3_INITIALIZE.agentCapabilities,
    sessionCapabilities: {},
    _meta: { kiro: { extensionMethods: ["_kiro/session/rename"] } },
  },
};

const freshNativeTitleMetadata = {
  schemaVersion: "1.0.0",
  id: SESSION_ID,
  title: "New Session",
  source: "local",
  createdAt: "2026-11-13T00:00:00.000Z",
  lastModifiedAt: "2026-11-13T00:00:00.000Z",
};

it.effect.each([
  { title: "  My deliberate name  ", text: "Fix login", expected: "My deliberate name" },
  { title: "Fix login", text: "\n Fix login\nMore details", expected: "Fix login" },
  { title: "x".repeat(76) + "😀abcdef", text: "Fix login", expected: "x".repeat(76) + "..." },
])("initial native title is meaningful and precedes the first prompt: $expected", (row) =>
  runKiroScript({
    scenario: "initial-native-title",
    ...row,
    frames: [
      ...openSessionFrames({
        initialize: nativeTitleInitialize,
        configOptions: [autopilotOption("on")],
        sessionMeta: freshNativeTitleMetadata,
      }),
      outbound("_kiro/session/rename", {
        sessionId: SESSION_ID,
        title: row.expected,
        sessionSource: "local",
      }),
      answer("_kiro/session/rename", { success: true }),
      turnPrompt,
      answer("session/prompt", { stopReason: "end_turn" }),
      turnPrompt,
      answer("session/prompt", { stopReason: "end_turn" }),
    ],
    drive: ({ events, startTurn, startTurnOn, ensureTitle }) =>
      Effect.gen(function* () {
        yield* startTurn;
        assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        yield* ensureTitle("A later generated or manual T3 title");
        yield* startTurnOn(2, "default");
        assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
      }),
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect.each([false, "error", "gone", "malformed"] as const)(
  "initial native title failure %s preserves the prompt without retrying rename",
  (outcome) =>
    runKiroScript({
      scenario: `native-title-${outcome}`,
      title: "Keep task",
      frames: [
        ...openSessionFrames({
          initialize: nativeTitleInitialize,
          configOptions: [autopilotOption("on")],
        }),
        outbound("_kiro/session/rename", {
          sessionId: SESSION_ID,
          title: "Keep task",
          sessionSource: "local",
        }),
        typeof outcome === "boolean" || outcome === "malformed"
          ? answer("_kiro/session/rename", outcome === "malformed" ? {} : { success: outcome })
          : {
              type: "emit_inbound",
              label: "rename.error",
              frame: {
                kind: "response",
                method: "_kiro/session/rename",
                error: {
                  code: outcome === "gone" ? -32601 : -32603,
                  message: "Synthetic rename failure",
                },
              },
            },
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
      drive: ({ events, startTurn, startTurnOn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          yield* startTurnOn(2, "default");
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("initial native title timeout preserves one prompt", () =>
  Effect.gen(function* () {
    const received = yield* Deferred.make<void>();
    yield* runKiroScript({
      scenario: "native-title-timeout",
      title: "Keep task",
      frames: [
        ...openSessionFrames({
          initialize: nativeTitleInitialize,
          configOptions: [autopilotOption("on")],
        }),
        outbound("_kiro/session/rename", {
          sessionId: SESSION_ID,
          title: "Keep task",
          sessionSource: "local",
        }),
        update({ sessionUpdate: "session_info_update", _meta: { fixtureRenameReceived: true } }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
      onSessionUpdate: (notification) =>
        notification.update.sessionUpdate === "session_info_update"
          ? Deferred.succeed(received, undefined).pipe(Effect.asVoid)
          : Effect.void,
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          const starting = yield* startTurn.pipe(Effect.forkScoped);
          yield* Deferred.await(received);
          yield* TestClock.adjust("5 seconds");
          yield* Fiber.join(starting);
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }).pipe(Effect.scoped),
    });
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect.each([
  ...[
    "unadvertised",
    "native-title",
    "native-event",
    "manual-initial-default",
    "initial-default-event",
    "nested-manual-initial-default",
    "wrong-creation-id",
    "changed-creation-time",
    "unknown-creation-time",
    "unknown-creation-schema",
    "unknown-source",
    "remote",
    "blank",
    "unnamed",
  ].map((state) => ({ state, observed: "CLI manual name" })),
  ...["New Session", "New thread", "New chat", "Untitled", " \tNew  thread\n"].flatMap((observed) =>
    ["native-title", "native-nested-title", "native-event"].map((state) => ({ state, observed })),
  ),
])("initial native title preserves $state sessions: $observed", ({ state, observed }) => {
  const frames = openSessionFrames({
    initialize: state === "unadvertised" ? KIRO_V3_INITIALIZE : nativeTitleInitialize,
    configOptions: [autopilotOption("on")],
  }).map((entry) => {
    const frame = entry.frame as { method?: string; result?: ReturnType<typeof sessionSetup> };
    if (frame.method !== "session/new" || frame.result === undefined) return entry;
    return {
      ...entry,
      frame: {
        ...frame,
        result: {
          ...frame.result,
          _meta: {
            ...frame.result._meta,
            ...([
              "manual-initial-default",
              "initial-default-event",
              "nested-manual-initial-default",
              "wrong-creation-id",
              "changed-creation-time",
              "unknown-creation-time",
              "unknown-creation-schema",
            ].includes(state)
              ? freshNativeTitleMetadata
              : {}),
            ...(state === "manual-initial-default" ? { titleSetByUser: true } : {}),
            ...(state === "nested-manual-initial-default"
              ? { kiro: { titleSetByUser: true } }
              : {}),
            ...(state === "wrong-creation-id" ? { id: "another-native-session" } : {}),
            ...(state === "changed-creation-time"
              ? { lastModifiedAt: "2026-11-13T00:01:00.000Z" }
              : {}),
            ...(state === "unknown-creation-time"
              ? { createdAt: "unknown", lastModifiedAt: "unknown" }
              : {}),
            ...(state === "unknown-creation-schema" ? { schemaVersion: "unknown" } : {}),
            ...(state === "native-title" ? { title: observed } : {}),
            ...(state === "native-nested-title" ? { kiro: { title: observed } } : {}),
            ...(state === "unknown-source"
              ? { source: undefined }
              : state === "remote"
                ? { source: "remote" }
                : {}),
          },
        },
      },
    };
  });
  return Effect.gen(function* () {
    const received = yield* Deferred.make<void>();
    const renames: unknown[] = [];
    yield* runKiroScript({
      scenario: `native-title-preserve-${state}`,
      wrapRuntime: (runtime) => ({
        ...runtime,
        request: (method, payload) =>
          method === "_kiro/session/rename"
            ? Effect.sync(() => {
                renames.push(payload);
                return { success: false };
              })
            : runtime.request(method, payload),
      }),
      onSessionUpdate: (notification) =>
        notification.update.sessionUpdate === "session_info_update"
          ? Deferred.succeed(received, undefined).pipe(Effect.asVoid)
          : Effect.void,
      title: state === "blank" || state === "unnamed" ? "New thread" : "App title",
      text: state === "blank" ? "  " : "Fix login",
      frames: [
        ...frames,
        ...(state === "native-event" || state === "initial-default-event"
          ? [
              update({
                sessionUpdate: "session_info_update",
                title: state === "initial-default-event" ? "New Session" : observed,
              }),
            ]
          : []),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...(state === "unadvertised" ? closeSession : []),
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          if (state === "native-event" || state === "initial-default-event")
            yield* Deferred.await(received);
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          assert.deepEqual(renames, []);
        }),
    });
  }).pipe(Effect.provide(testLayer), Effect.scoped);
});

it.effect.each([
  "resume",
  "child",
  "foreign-instance",
  "remote-delegate",
  "sibling",
  "history",
  "fork",
  "replacement",
  "rollback",
] as const)("initial native title permission is withdrawn for %s", (scope) =>
  Effect.gen(function* () {
    const renames: unknown[] = [];
    yield* runKiroScript({
      scenario: `native-title-scope-${scope}`,
      wrapRuntime: (runtime) => ({
        ...runtime,
        request: (method, payload) =>
          method === "_kiro/session/rename"
            ? Effect.sync(() => {
                renames.push(payload);
                return { success: false };
              })
            : runtime.request(method, payload),
      }),
      title: "App title",
      frames: [
        ...openSessionFrames({
          initialize: nativeTitleInitialize,
          configOptions: [autopilotOption("on")],
          sessionMeta: freshNativeTitleMetadata,
        }),
        ...(scope === "replacement" || scope === "rollback"
          ? []
          : scope === "sibling"
            ? [
                outbound("session/load", {
                  sessionId: "sibling-native",
                  cwd: "<workspace>",
                  mcpServers: "<any>",
                }),
                answer("session/load", {
                  configOptions: [],
                  _meta: { source: "local", title: "CLI sibling name" },
                }),
                outbound("session/prompt", { sessionId: "sibling-native", prompt: "<any>" }),
                answer("session/prompt", { stopReason: "end_turn" }),
              ]
            : [turnPrompt, answer("session/prompt", { stopReason: "end_turn" })]),
      ],
      ...(scope === "replacement" || scope === "rollback"
        ? {
            replacementFrames: [
              ...openSessionFrames({
                initialize: nativeTitleInitialize,
                configOptions: [autopilotOption("on")],
                sessionMeta: freshNativeTitleMetadata,
              }),
              turnPrompt,
              answer("session/prompt", { stopReason: "end_turn" }),
            ],
          }
        : {}),
      transformTurn: (turn) => ({
        ...turn,
        ...(scope === "history" ? { nativeThreadHasTurns: true } : {}),
        appThread:
          scope === "remote-delegate"
            ? {
                ...turn.appThread,
                linkOrigin: { sessionId: "linked-session", label: "Remote parent" },
                delegatedFrom: {
                  environmentId: EnvironmentId.make("parent-env"),
                  threadId: ThreadId.make("remote-parent"),
                  title: "Remote parent",
                },
              }
            : scope !== "child"
              ? turn.appThread
              : {
                  ...turn.appThread,
                  lineage: { ...turn.appThread.lineage, parentThreadId: ThreadId.make("parent") },
                },
        providerThread: {
          ...turn.providerThread,
          ...(scope === "foreign-instance"
            ? { providerInstanceId: ProviderInstanceId.make("other-kiro") }
            : {}),
          ...(scope === "sibling"
            ? {
                nativeThreadRef: {
                  driver: KIRO_PROVIDER,
                  nativeId: "sibling-native",
                  strength: "strong" as const,
                },
              }
            : {}),
          ...(scope === "fork" ? { forkedFrom: { providerThreadId: turn.providerThread.id } } : {}),
        },
      }),
      drive: ({ events, startTurn, resume, forceReplacement, rollbackToStart }) =>
        Effect.gen(function* () {
          if (scope === "resume") yield* resume;
          if (scope === "replacement") yield* forceReplacement({});
          if (scope === "rollback") yield* rollbackToStart;
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          assert.deepEqual(renames, []);
        }),
    });
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect.each(["CLI manual name", "New Session"] as const)(
  "initial native title never renames an imported or reconnected native session: %s",
  (title) =>
    runKiroScript({
      scenario: "native-title-import",
      initialNativeThreadId: SESSION_ID,
      title: "Different T3 name",
      frames: [
        outbound("initialize"),
        answer("initialize", nativeTitleInitialize),
        outbound("session/load", {
          sessionId: SESSION_ID,
          cwd: "<workspace>",
          mcpServers: "<any>",
        }),
        answer("session/load", {
          ...sessionSetup([]),
          _meta: { ...freshNativeTitleMetadata, title },
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.live.each([
  {
    renameOutcome: "confirmed",
    observation: "live",
    admission: "ordinary",
    initialObservation: undefined,
  },
  {
    renameOutcome: "confirmed",
    observation: "aba",
    admission: "ordinary",
    initialObservation: undefined,
  },
  {
    renameOutcome: "rejected",
    observation: "aba",
    admission: "ordinary",
    initialObservation: undefined,
  },
  {
    renameOutcome: "confirmed",
    observation: "aba",
    admission: "manual",
    initialObservation: "Native manual name before first rename",
  },
  { renameOutcome: "confirmed", observation: "aba", admission: "null", initialObservation: null },
  { renameOutcome: "confirmed", observation: "aba", admission: "empty", initialObservation: "" },
  {
    renameOutcome: "confirmed",
    observation: "aba",
    admission: "whitespace",
    initialObservation: " \t ",
  },
] as const)(
  "initial native title persists through list, CLI manual rename and process reload: $renameOutcome/$observation/$admission",
  ({ renameOutcome, observation, admission, initialObservation }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kiro-title-persistence-" });
      const host = yield* ProviderHost.ProviderHost;
      const receiptDirectory = path.join(host.paths.stateDir, "kiro-native-title-v1");
      const lookupEntered = yield* Deferred.make<void>();
      const releaseLookup = yield* Deferred.make<void>();
      const milestones: string[] = [];
      let holdFirstLookup = initialObservation !== undefined;
      const titleFileSystem = {
        ...fs,
        lstat: (filePath: string) => {
          const read = fs.lstat(filePath);
          if (!holdFirstLookup || path.dirname(filePath) !== receiptDirectory) return read;
          holdFirstLookup = false;
          milestones.push("first initial receipt lookup held");
          return Deferred.succeed(lookupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLookup)),
            Effect.andThen(read),
          );
        },
      };
      const observationUpdatedAt = "2026-11-13T01:00:00.000Z";
      const normalizedInitial =
        initialObservation === null ? null : initialObservation?.trim() || undefined;
      const meaningfulInitial =
        typeof initialObservation === "string" && initialObservation.trim().length > 0;
      const ownsTitle = renameOutcome === "confirmed" && !meaningfulInitial;
      const evidenceDir = Option.getOrUndefined(
        yield* Config.option(Config.String("T3_KIRO_TITLE_TEST_EVIDENCE_DIR")),
      );
      const outcomeDir =
        evidenceDir === undefined
          ? undefined
          : path.join(evidenceDir, `${renameOutcome}-${observation}-${admission}`);
      const script = path.join(root, "peer.mjs");
      const digest = yield* Digest.Digest;
      const bucket = Hex.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(root)),
      ).slice(0, 16);
      const statePath = path.join(
        root,
        "kiro",
        "sessions",
        bucket,
        "native-fresh-root",
        "session.json",
      );
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      const wirePath = path.join(root, "wire.jsonl");
      yield* fs.writeFileString(
        script,
        `
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const statePath = process.env.TITLE_FIXTURE_STATE;
const wirePath = process.env.TITLE_FIXTURE_WIRE;
const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = state => { writeFileSync(statePath + '.tmp', JSON.stringify(state)); renameSync(statePath + '.tmp', statePath); };
const sessionId = 'native-fresh-root';
let hasReceivedPrompt = false;
const reply = message => {
  appendFileSync(wirePath, JSON.stringify({ direction:'peer', ...message }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc:'2.0', ...message }) + '\\n');
};
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(wirePath, JSON.stringify({ method,
    ...(method === '_kiro/session/rename' ? { params } : {}),
    ...(method === 'session/prompt' ? { sessionId: params.sessionId,
      promptHash: createHash('sha256').update(JSON.stringify(params.prompt)).digest('hex'),
      hasDisplayText: Object.hasOwn(params, 'displayText') } : {})
  }) + '\\n');
  let result = {};
  if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {
    loadSession: true, sessionCapabilities: { list: {} },
    _meta: { kiro: { extensionMethods: ['_kiro/session/rename'] } }
  } };
  else if (method === 'session/new') {
    hasReceivedPrompt = false;
    save({ schemaVersion:'1.0.0', id:sessionId, sessionId, title: 'New Session', workspacePaths:[process.cwd()], createdAt:'2026-11-13T00:00:00.000Z', lastModifiedAt:'2026-11-13T00:00:00.000Z', promptCount: 0, titleModelAttempts: 0 });
    result = { sessionId, _meta: { schemaVersion:'1.0.0', id:sessionId, source:'local', title:'New Session',
      createdAt:'2026-11-13T00:00:00.000Z', lastModifiedAt:'2026-11-13T00:00:00.000Z' }, configOptions: [] };
  } else if (method === '_kiro/session/rename') {
    if (params.sessionId !== sessionId || params.sessionSource !== 'local') throw Error('Wrong binding');
    const state = read();
    const previous = hasReceivedPrompt;
    hasReceivedPrompt = true;
    if (process.env.TITLE_FIXTURE_RENAME === 'rejected') {
      hasReceivedPrompt = previous;
      reply({id, error:{code:-32603,message:'Synthetic strict-persistence refusal'}}); return;
    }
    save({ ...state, title: params.title, titleSetByUser: true });
    appendFileSync(wirePath, JSON.stringify({method:'fixture/title-persisted',titleSetByUser:read().titleSetByUser}) + '\\n');
    reply({method:'session/update',params:{sessionId,update:{sessionUpdate:'session_info_update',title:params.title}}});
    result = { success: true };
  } else if (method === 'session/prompt') {
    const state = read();
    const fallback = !hasReceivedPrompt && !state.titleSetByUser;
    if (fallback) appendFileSync(wirePath, JSON.stringify({method:'fixture/title-model-attempt'}) + '\\n');
    save({ ...state, promptCount: state.promptCount + 1,
      titleModelAttempts: state.titleModelAttempts + Number(fallback),
      title: fallback ? 'Framework/setup-derived fallback' : state.title });
    hasReceivedPrompt = true;
    result = { stopReason: 'end_turn' };
  } else if (method === 'session/list') {
    result = { sessions: [{ sessionId, cwd: process.cwd(), title: read().title }] };
  } else if (method === 'session/load') {
    result = { _meta: { source: 'local', title: read().title, titleSetByUser:read().titleSetByUser }, configOptions: [] };
  } else if (method === '_fixture/observe-title') {
    if (params.persist) save({ ...read(), title:params.title, titleSetByUser:true });
    reply({method:'session/update',params:{sessionId:params.sessionId ?? sessionId,update:{sessionUpdate:'session_info_update',title:params.title,...(params.updatedAt ? {updatedAt:params.updatedAt} : {})}}});
  } else if (method === '_fixture/user-rename') {
    save({ ...read(), title: 'CLI deliberate name', titleSetByUser: true });
  }
  reply({id,result});
});
`,
      );
      const instanceId = ProviderInstanceId.make("kiro-title-persistence");
      const threadId = ThreadId.make("title-persistence");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        cwd: root,
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
      let peer: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const adapter = yield* makeKiroAdapterV2({
        instanceId,
        settings: ENABLED_KIRO_SETTINGS,
        environment: { HOME: `${root}/home`, KIRO_HOME: `${root}/kiro` },
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          AcpSessionRuntime.make({
            ...input,
            spawn: {
              command: process.execPath,
              args: [script],
              cwd: root,
              env: {
                HOME: `${root}/home`,
                KIRO_HOME: `${root}/kiro`,
                TITLE_FIXTURE_STATE: statePath,
                TITLE_FIXTURE_WIRE: wirePath,
                TITLE_FIXTURE_RENAME: renameOutcome,
              },
            },
          }).pipe(
            Effect.tap((runtime) =>
              Effect.sync(() => {
                peer = runtime;
              }),
            ),
          ),
      }).pipe(Effect.provideService(FileSystem.FileSystem, titleFileSystem));
      const now = yield* DateTime.now;
      for (const reloaded of [false, true]) {
        yield* Effect.gen(function* () {
          const session = yield* adapter.openSession({
            threadId,
            modelSelection,
            runtimePolicy,
            providerSessionId: ProviderSessionId.make(`title-process-${reloaded}`),
            ...(reloaded ? { initialNativeThreadId: "native-fresh-root" } : {}),
          });
          const providerThread = yield* session.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            title: "New thread",
          });
          const request = peer!.request;
          const send = (ordinal: number, title: string) => {
            const turn = makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal,
              messageText: "Fix login\nDetails",
            });
            return Effect.gen(function* () {
              const start = session.startTurn({ ...turn, appThread: { ...turn.appThread, title } });
              if (!reloaded && ordinal === 1 && initialObservation !== undefined) {
                const starting = yield* start.pipe(Effect.forkScoped);
                yield* Effect.gen(function* () {
                  yield* Deferred.await(lookupEntered);
                  yield* request("_fixture/observe-title", {
                    title: initialObservation,
                    persist: meaningfulInitial,
                    updatedAt: observationUpdatedAt,
                  });
                  const admitted = yield* session.events.pipe(
                    Stream.filter(
                      (event) =>
                        event.type === "provider_thread.updated" &&
                        event.providerThread.nativeThreadRef?.nativeId === "native-fresh-root" &&
                        event.providerThread.nativeMetadata?.updatedAt === observationUpdatedAt &&
                        event.providerThread.nativeMetadata?.title === normalizedInitial,
                    ),
                    Stream.runHead,
                  );
                  assert.isTrue(Option.isSome(admitted));
                  milestones.push(
                    "native session info processed; admitted title observer or normalized empty completed",
                  );
                }).pipe(Effect.ensuring(Deferred.succeed(releaseLookup, undefined)));
                milestones.push("first initial receipt lookup released");
                yield* Fiber.join(starting);
              } else yield* start;
              assert.equal(terminalStatus(yield* collectTurn(session.events)), "completed");
            });
          };
          yield* send(1, reloaded ? "Different T3 title" : "Fix login");
          if (!reloaded && initialObservation !== undefined) {
            milestones.push("first turn completed");
            const receiptFiles = (yield* fs.exists(receiptDirectory))
              ? yield* fs.readDirectory(receiptDirectory)
              : [];
            const receipts = yield* Effect.forEach(receiptFiles, (name) =>
              fs
                .readFileString(path.join(receiptDirectory, name))
                .pipe(Effect.map((raw) => JSON.parse(raw))),
            );
            const firstWire = (yield* fs.readFileString(wirePath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const admissionState = {
              nativeRenames: firstWire.filter((row) => row.method === "_kiro/session/rename")
                .length,
              ownedReceipts: receipts.filter((receipt) => receipt.owned === true).length,
            };
            if (outcomeDir !== undefined) {
              yield* fs.makeDirectory(outcomeDir, { recursive: true });
              yield* fs.copyFile(wirePath, path.join(outcomeDir, "first-turn-wire.jsonl"));
              yield* fs.copyFile(statePath, path.join(outcomeDir, "first-turn-native-state.json"));
              yield* fs.writeFileString(
                path.join(outcomeDir, "initial-admission.json"),
                JSON.stringify(
                  { initialObservation, milestones, admissionState, receipts },
                  null,
                  2,
                ),
              );
            }
            assert.deepEqual(
              admissionState,
              meaningfulInitial
                ? { nativeRenames: 0, ownedReceipts: 0 }
                : { nativeRenames: 1, ownedReceipts: 1 },
            );
          }
          const list = yield* request("session/list", {});
          assert.deepEqual(list, {
            sessions: [
              {
                sessionId: "native-fresh-root",
                cwd: root,
                title: reloaded
                  ? "CLI deliberate name"
                  : meaningfulInitial
                    ? initialObservation
                    : ownsTitle
                      ? "Fix login"
                      : "Framework/setup-derived fallback",
              },
            ],
          });
          if (!reloaded) {
            const first = JSON.parse(yield* fs.readFileString(statePath));
            assert.equal(first.titleSetByUser === true, ownsTitle || meaningfulInitial);
            assert.equal(first.titleModelAttempts, ownsTitle || meaningfulInitial ? 0 : 1);
            const generated = makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
            });
            const synchronize = (title: string) =>
              session.syncGeneratedTitle?.({
                appThread: { ...generated.appThread, title },
                providerThread,
                isCurrent: Effect.succeed(true),
              }) ?? Effect.void;
            yield* synchronize("Later generated T3 title");
            const afterGenerated = JSON.parse(yield* fs.readFileString(statePath));
            assert.equal(
              afterGenerated.title,
              meaningfulInitial
                ? initialObservation
                : ownsTitle
                  ? "Later generated T3 title"
                  : "Framework/setup-derived fallback",
            );
            const observe = (title: string) =>
              request("_fixture/observe-title", { title }).pipe(
                Effect.andThen(
                  session.events.pipe(
                    Stream.filter(
                      (event) =>
                        event.type === "provider_thread.updated" &&
                        event.providerThread.nativeMetadata?.title === title,
                    ),
                    Stream.runHead,
                  ),
                ),
              );
            yield* request("_fixture/observe-title", {
              title: "Sibling manual title",
              sessionId: "sibling-session",
            });
            yield* observe(afterGenerated.title);
            yield* synchronize(afterGenerated.title);
            yield* observe("Observed manual title");
            if (observation === "aba") yield* observe(afterGenerated.title);
            yield* synchronize("Must not overwrite an observed native edit");
            assert.equal(
              JSON.parse(yield* fs.readFileString(statePath)).title,
              afterGenerated.title,
            );
            yield* request("_fixture/user-rename", {});
            yield* synchronize("Generated after CLI edit");
            yield* send(2, "Later generated T3 title");
            yield* session.resumeThread({ providerThread, modelSelection, runtimePolicy });
            yield* send(3, "Later manual T3 title");
          }
        }).pipe(Effect.scoped);
      }
      const saved = JSON.parse(yield* fs.readFileString(statePath));
      const wire = (yield* fs.readFileString(wirePath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(saved.title, "CLI deliberate name");
      assert.equal(saved.titleSetByUser, true);
      assert.equal(saved.promptCount, 4);
      assert.equal(saved.titleModelAttempts, ownsTitle || meaningfulInitial ? 0 : 1);
      const firstPrompt = wire.findIndex((event) => event.method === "session/prompt");
      const persisted = wire.findIndex((event) => event.method === "fixture/title-persisted");
      const confirmed = wire.findIndex(
        (event) => event.direction === "peer" && event.result?.success === true,
      );
      if (ownsTitle) {
        assert.isTrue(persisted >= 0 && confirmed > persisted && firstPrompt > confirmed);
        assert.isFalse(wire.some((event) => event.method === "fixture/title-model-attempt"));
      } else {
        assert.equal(persisted, -1);
        assert.equal(confirmed, -1);
        assert.equal(
          wire.some((event) => event.direction === "peer" && event.error?.code === -32603),
          renameOutcome === "rejected",
        );
      }
      assert.deepEqual(
        wire.filter((event) => event.method === "_kiro/session/rename"),
        [
          ...(meaningfulInitial
            ? []
            : [
                {
                  method: "_kiro/session/rename",
                  params: {
                    sessionId: "native-fresh-root",
                    title: "Fix login",
                    sessionSource: "local",
                  },
                },
              ]),
          ...(ownsTitle
            ? [
                {
                  method: "_kiro/session/rename",
                  params: {
                    sessionId: "native-fresh-root",
                    title: "Later generated T3 title",
                    sessionSource: "local",
                  },
                },
              ]
            : []),
        ],
      );
      assert.isTrue(
        wire
          .filter((event) => event.method === "session/prompt")
          .every(
            (event) => event.sessionId === "native-fresh-root" && event.hasDisplayText === false,
          ),
      );
      yield* Effect.logInfo("Synthetic native title persistence evidence", { saved, wire });
      if (outcomeDir !== undefined) {
        yield* fs.makeDirectory(outcomeDir, { recursive: true });
        for (const [source, name] of [
          [script, "synthetic-peer.mjs"],
          [statePath, "synthetic-final-state.json"],
          [wirePath, "actual-wire.jsonl"],
        ] as const) {
          yield* fs.copyFile(source, path.join(outcomeDir, name));
        }
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.live.each(["startup", "switch"] as const)(
  "keeps native Kiro history replay during %s load",
  (activation) =>
    Effect.gen(function* () {
      const loadedId = activation === "startup" ? SESSION_ID : "other-native-session";
      const replay = (sessionId: string, sessionUpdate: Record<string, unknown>): Frame => ({
        type: "emit_inbound",
        label: `history.${sessionId}.${String(sessionUpdate.sessionUpdate)}`,
        frame: {
          kind: "notification",
          method: "session/update",
          params: { sessionId, update: sessionUpdate },
        },
      });
      const history: ReadonlyArray<Frame> = [
        replay("unowned-child-session", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "foreign history must stay out" },
        }),
        replay(loadedId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "SYNTHETIC IMPORT USER" },
        }),
        replay(loadedId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "SYNTHETIC THOUGHT CHUNK" },
        }),
        replay(loadedId, {
          sessionUpdate: "agent_thought",
          messageId: "synthetic-whole-thought",
          content: [{ type: "text", text: "SYNTHETIC THOUGHT WHOLE" }],
        }),
        replay(loadedId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "SYNTHETIC REPLY CHUNK" },
        }),
        replay(loadedId, {
          sessionUpdate: "agent_message",
          messageId: "synthetic-whole-reply",
          content: [{ type: "text", text: "SYNTHETIC REPLY WHOLE" }],
        }),
      ];
      const initialize = {
        ...KIRO_V3_INITIALIZE_WITHOUT_EXTENSIONS,
        agentCapabilities: {
          ...KIRO_V3_INITIALIZE_WITHOUT_EXTENSIONS.agentCapabilities,
          sessionCapabilities: { close: {} },
          _meta: { kiro: { replayMarking: true } },
        },
      };
      yield* runKiroScript({
        scenario: `native-history-${activation}`,
        ...(activation === "startup" ? { initialNativeThreadId: loadedId } : {}),
        frames: [
          ...(activation === "startup"
            ? [outbound("initialize"), answer("initialize", initialize)]
            : openSessionFrames({ initialize, configOptions: [autopilotOption("on")] })),
          outbound("session/load", {
            sessionId: loadedId,
            cwd: "<workspace>",
            mcpServers: "<any>",
          }),
          ...history,
          answer("session/load", { configOptions: [autopilotOption("off")] }),
          outbound("session/close", { sessionId: loadedId }),
          answer("session/close", {}),
        ],
        drive: ({ readSnapshot }) =>
          Effect.gen(function* () {
            const snapshot = yield* readSnapshot(loadedId);
            assert.deepEqual(
              snapshot.messages.map((message) => message.text),
              [
                "SYNTHETIC IMPORT USER",
                "SYNTHETIC THOUGHT CHUNK",
                "SYNTHETIC THOUGHT WHOLE",
                "SYNTHETIC REPLY CHUNK",
                "SYNTHETIC REPLY WHOLE",
              ],
            );
            assert.deepEqual(
              snapshot.reasoningMessageIds,
              snapshot.messages.slice(1, 3).map((message) => message.id),
            );
            assert.isTrue(
              snapshot.messages.every(
                (message) =>
                  message.runId === null && message.nodeId === null && !message.streaming,
              ),
            );
            const repeated = yield* readSnapshot(loadedId);
            assert.deepEqual(repeated.messages, snapshot.messages);
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.live.each(["fails", "is interrupted"] as const)(
  "retains active Kiro history when another load %s",
  (ending) =>
    Effect.gen(function* () {
      const b = "other-native-session";
      const milestones = new Map<string, Deferred.Deferred<void>>();
      for (const text of ["B partial thought", "B late reply", "A continued"])
        milestones.set(text, yield* Deferred.make<void>());
      const replayGate = makeProviderReplayGate(["b-result", "late-b", "continue-a"]);
      const chunk = (
        sessionId: string,
        sessionUpdate: string,
        text: string,
        label = text,
      ): Frame => ({
        type: "emit_inbound",
        label,
        frame: {
          kind: "notification",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } },
        },
      });
      const history = (sessionId: string, prefix: string) => [
        chunk(sessionId, "user_message_chunk", `${prefix} user`),
        chunk(sessionId, "agent_message_chunk", `${prefix} reply`),
        chunk(sessionId, "agent_thought_chunk", `${prefix} thought`),
      ];
      const load = (sessionId: string) =>
        outbound("session/load", { sessionId, cwd: "<workspace>", mcpServers: "<any>" });
      const loaded = answer("session/load", { configOptions: [autopilotOption("off")] });
      yield* runKiroScript({
        scenario: `retained-history-${ending.replaceAll(" ", "-")}`,
        initialNativeThreadId: SESSION_ID,
        replayGate,
        onSessionUpdate: ({ update }) => {
          const text =
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk") &&
            update.content.type === "text"
              ? update.content.text
              : undefined;
          const milestone = text === undefined ? undefined : milestones.get(text);
          return milestone === undefined
            ? Effect.void
            : Deferred.succeed(milestone, undefined).pipe(Effect.asVoid);
        },
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          load(SESSION_ID),
          ...history(SESSION_ID, "A"),
          loaded,
          load(b),
          ...history(b, "B partial").slice(1),
          {
            type: "emit_inbound",
            label: "b-result",
            frame: {
              kind: "response",
              method: "session/load",
              error: { code: -32603, message: "Synthetic load failure" },
            },
          },
          chunk(b, "agent_thought_chunk", "B late thought", "late-b"),
          chunk(b, "agent_message_chunk", "B late reply"),
          chunk(SESSION_ID, "agent_thought_chunk", "A continued", "continue-a"),
          load(b),
          ...history(b, "B committed"),
          loaded,
          outbound("session/close", { sessionId: b }),
          answer("session/close", {}),
        ],
        drive: ({ readSnapshot }) =>
          Effect.gen(function* () {
            const a = yield* readSnapshot();
            assert.deepEqual(
              a.messages.map((message) => message.text),
              ["A user", "A reply", "A thought"],
            );
            assert.deepEqual(a.reasoningMessageIds, [a.messages[2]!.id]);
            const pending = yield* readSnapshot(b).pipe(Effect.forkScoped);
            yield* Deferred.await(milestones.get("B partial thought")!);
            if (ending === "is interrupted") yield* Fiber.interrupt(pending);
            replayGate.release("b-result");
            const failed = yield* Fiber.await(pending);
            assert.isTrue(Exit.isFailure(failed));
            assert.equal(Exit.hasInterrupts(failed), ending === "is interrupted");
            const assertRetained = (retained: ProviderAdapterV2ThreadSnapshot) => {
              assert.deepEqual(retained.messages, a.messages);
              assert.deepEqual(retained.reasoningMessageIds, a.reasoningMessageIds);
              assert.deepEqual(retained.providerPayload, a.providerPayload);
            };
            assertRetained(yield* readSnapshot());
            replayGate.release("late-b");
            yield* Deferred.await(milestones.get("B late reply")!);
            assertRetained(yield* readSnapshot());
            replayGate.release("continue-a");
            yield* Deferred.await(milestones.get("A continued")!);
            const continued = yield* readSnapshot();
            assert.deepEqual(
              continued.messages.map((message) => message.text),
              ["A user", "A reply", "A thoughtA continued"],
            );
            assert.deepEqual(
              continued.messages.map((message) => message.id),
              a.messages.map((message) => message.id),
            );
            assert.deepEqual(continued.reasoningMessageIds, a.reasoningMessageIds);
            const committed = yield* readSnapshot(b);
            assert.deepEqual(
              committed.messages.map((message) => message.text),
              ["B committed user", "B committed reply", "B committed thought"],
            );
            assert.deepEqual(committed.reasoningMessageIds, [committed.messages[2]!.id]);
            assert.deepEqual((yield* readSnapshot(b)).messages, committed.messages);
          }).pipe(Effect.scoped),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

const collectTurn = (events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>) =>
  events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
    Effect.map((collected) => Array.from(collected)),
  );

const terminalStatus = (events: ReadonlyArray<ProviderAdapterV2Event>) => {
  const terminal = events.find((event) => event.type === "turn.terminal");
  return terminal?.type === "turn.terminal" ? terminal.status : undefined;
};

describe("Kiro native question callbacks", () => {
  const native = "_kiro/userInput";
  const mcp = "_kiro/mcp/elicitation";
  const cases = [
    {
      name: "free text",
      method: native,
      payload: { question: "Which workspace?" },
      answers: { answer: "the sample workspace" },
      result: { action: "answered", answer: "the sample workspace" },
      choices: [],
    },
    {
      name: "option text",
      method: native,
      payload: {
        question: "Which approach?",
        options: [
          { title: "Small change", description: "Keep the existing flow", recommended: true },
          { title: "Rewrite" },
        ],
      },
      answers: { answer: "Small change" },
      result: { action: "answered", answer: "Small change" },
      choices: ["Small change", "Rewrite"],
    },
    {
      name: "suboption text",
      method: native,
      payload: {
        question: "Where should it run?",
        options: [
          {
            title: "Local",
            subOptionsLabel: "Choose a host",
            subOptions: [{ title: "pop-os", description: "Development host" }, { title: "VPS" }],
          },
        ],
      },
      answers: { answer: "Local: pop-os" },
      result: { action: "answered", answer: "Local: pop-os" },
      choices: ["Local", "Local: pop-os", "Local: VPS"],
    },
    {
      name: "dismissal",
      method: native,
      payload: { question: "Continue?" },
      answers: undefined,
      result: { action: "dismissed" },
      choices: [],
    },
    {
      name: "empty answer",
      method: native,
      payload: { question: "Which workspace?" },
      answers: { answer: "  " },
      result: { action: "dismissed" },
      choices: [],
    },
    {
      name: "unsupported native multiselect",
      method: native,
      payload: { question: "Which workspace?" },
      answers: { answer: ["one", "two"] },
      result: { action: "dismissed" },
      choices: [],
    },
    {
      name: "typed MCP form",
      method: mcp,
      payload: {
        elicitation: {
          mode: "form",
          message: "Configure the sample",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              format: { type: "string", enum: ["json", "text"] },
              areas: { type: "array", items: { type: "string", enum: ["api", "ui"] }, minItems: 1 },
              count: { type: "integer" },
              enabled: { type: "boolean" },
            },
            required: ["name", "format", "areas", "count", "enabled"],
          },
        },
      },
      answers: {
        name: "Sample",
        format: "json",
        areas: ["ui", "api"],
        count: "2",
        enabled: "false",
      },
      result: {
        action: "accept",
        content: { name: "Sample", format: "json", areas: ["ui", "api"], count: 2, enabled: false },
      },
    },
    {
      name: "invalid MCP form answer",
      method: mcp,
      payload: {
        elicitation: {
          mode: "form",
          message: "Choose",
          requestedSchema: {
            type: "object",
            properties: { format: { type: "string", enum: ["json"] } },
            required: ["format"],
          },
        },
      },
      answers: { format: "unsupported" },
      result: { action: "cancel" },
    },
  ];

  it.live.each(["approval-required", "full-access"] as const)(
    "round-trips native questions and typed forms on the original ACP request in %s",
    (runtimeMode) =>
      runKiroScript({
        scenario: `native-questions-${runtimeMode}`,
        runtimeMode,
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          })
            .map((entry) => {
              const frame = entry.frame as Frame;
              return runtimeMode === "full-access" && frame.method === "session/set_config_option"
                ? undefined
                : entry;
            })
            .filter((entry): entry is Frame => entry !== undefined),
          turnPrompt,
          ...cases.flatMap(({ method, payload, result }) => [
            kiroSecretRequest(method, {
              sessionId: SESSION_ID,
              toolCallId: "same-native-tool",
              ...payload,
            }),
            kiroSecretResponse(method, result),
          ]),
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ events, startTurn, answerQuestion }) =>
          Effect.gen(function* () {
            yield* startTurn;
            const ids = new Set<string>();
            let index = 0;
            const turn = yield* collectTurn(
              events.pipe(
                Stream.tap((event) => {
                  if (
                    event.type !== "turn_item.updated" ||
                    event.turnItem.type !== "user_input_request"
                  )
                    return Effect.void;
                  const item = event.turnItem;
                  const expected = cases[index++];
                  assert.ok(expected);
                  assert.isFalse(
                    ids.has(item.id),
                    "repeated tool calls need distinct question identities",
                  );
                  ids.add(item.id);
                  assert.include(item.nativeItemRef?.nativeId, "same-native-tool");
                  assert.equal(item.status, "waiting");
                  if (expected.choices !== undefined) {
                    assert.deepEqual(
                      item.questions[0]?.options.map((choice) => choice.value ?? choice.label),
                      expected.choices,
                    );
                    assert.isUndefined(item.questions[0]?.multiSelect);
                  } else if (expected.name === "typed MCP form") {
                    assert.equal(
                      item.questions.find((question) => question.id === "areas")?.multiSelect,
                      true,
                    );
                  }
                  return answerQuestion(item.requestId, expected.answers);
                }),
              ),
            );
            assert.equal(terminalStatus(turn), "completed");
            assert.equal(index, cases.length);
            assert.isFalse(
              turn.some(
                (event) =>
                  event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
              ),
            );
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["", " \t\n "] as const)(
    "dismisses unknown sessions, idle questions, URL and blank elicitations before a described form (message=%j)",
    (message) => {
      const replayGate = makeProviderReplayGate(["idle-handled"]);
      return runKiroScript({
        replayGate,
        scenario: "native-question-admission",
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          kiroSecretRequest(native, {
            sessionId: SESSION_ID,
            toolCallId: "idle",
            question: "Idle?",
          }),
          kiroSecretResponse(native, { action: "dismissed" }),
          { ...update({ sessionUpdate: "session_info_update" }), label: "idle-handled" },
          turnPrompt,
          kiroSecretRequest(native, {
            sessionId: "foreign",
            toolCallId: "foreign",
            question: "Foreign?",
          }),
          kiroSecretResponse(native, { action: "dismissed" }),
          kiroSecretRequest(mcp, {
            sessionId: SESSION_ID,
            toolCallId: "url",
            elicitation: {
              mode: "url",
              message: "Unsupported URL mode",
              url: "https://example.invalid/",
              elicitationId: "url",
            },
          }),
          kiroSecretResponse(mcp, { action: "cancel" }),
          kiroSecretRequest(mcp, {
            sessionId: SESSION_ID,
            toolCallId: "blank-form",
            elicitation: {
              mode: "form",
              message,
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"],
              },
            },
          }),
          kiroSecretResponse(mcp, { action: "cancel" }),
          kiroSecretRequest(mcp, {
            sessionId: SESSION_ID,
            toolCallId: "described-form",
            elicitation: {
              mode: "form",
              message,
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string", description: "Which project?" } },
                required: ["answer"],
              },
            },
          }),
          kiroSecretResponse(mcp, {
            action: "accept",
            content: { answer: "the sample workspace" },
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ events, startTurn, answerQuestion }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => replayGate.waitForReached("idle-handled"));
            replayGate.release("idle-handled");
            yield* startTurn;
            const turn = yield* collectTurn(
              events.pipe(
                Stream.tap((event) => {
                  if (
                    event.type !== "turn_item.updated" ||
                    event.turnItem.type !== "user_input_request"
                  )
                    return Effect.void;
                  assert.deepEqual(event.turnItem.questions, [
                    { id: "answer", header: "Question 1", question: "Which project?", options: [] },
                  ]);
                  assert.include(event.turnItem.nativeItemRef?.nativeId, "described-form");
                  return answerQuestion(event.turnItem.requestId, {
                    answer: "the sample workspace",
                  });
                }),
              ),
            );
            assert.equal(terminalStatus(turn), "completed");
            assert.lengthOf(
              turn.filter(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "user_input_request",
              ),
              1,
            );
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    },
  );
  it.live.each(["completion", "disconnect", "replacement"] as const)(
    "retires unanswered native questions on %s and rejects late answers",
    (ending) =>
      Effect.gen(function* () {
        const replacementId = `${SESSION_ID}-replacement`;
        const replacementFrame = (frame: Frame): Frame =>
          JSON.parse(JSON.stringify(frame).replaceAll(SESSION_ID, replacementId));
        const questionSeen = yield* Deferred.make<void>();
        const responseWritten = yield* Deferred.make<void>();
        yield* runKiroScript({
          scenario: `native-question-${ending}`,
          testHooks: {
            afterPromptWireSettled: () => Deferred.await(questionSeen),
            onNativeResponseLifecycle: (event) =>
              event.type === "removed"
                ? Deferred.succeed(responseWritten, undefined).pipe(Effect.asVoid)
                : Effect.void,
          },
          frames: [
            ...openSessionFrames({
              initialize: KIRO_V3_INITIALIZE,
              configOptions: [modeOption, autopilotOption("on")],
            }),
            turnPrompt,
            kiroSecretRequest(native, {
              sessionId: SESSION_ID,
              toolCallId: "pending",
              question: "Still waiting?",
            }),
            ...(ending !== "disconnect"
              ? [
                  answer("session/prompt", { stopReason: "end_turn" }, "question-seen"),
                  kiroSecretResponse(native, { action: "dismissed" }),
                  ...(ending === "completion" ? closeSession : []),
                ]
              : []),
          ],
          ...(ending !== "replacement"
            ? {}
            : {
                replacementFrames: [
                  ...openSessionFrames({
                    initialize: KIRO_V3_INITIALIZE,
                    configOptions: [modeOption, autopilotOption("on")],
                  }).map(replacementFrame),
                  replacementFrame(turnPrompt),
                  kiroSecretRequest(native, {
                    sessionId: SESSION_ID,
                    toolCallId: "pending",
                    question: "Stale session?",
                  }),
                  kiroSecretResponse(native, { action: "dismissed" }),
                  kiroSecretRequest(native, {
                    sessionId: replacementId,
                    toolCallId: "pending",
                    question: "Replacement question?",
                  }),
                  kiroSecretResponse(native, { action: "answered", answer: "replacement answer" }),
                  replacementFrame(answer("session/prompt", { stopReason: "end_turn" })),
                  ...closeSession.map(replacementFrame),
                ],
              }),
          drive: ({
            events,
            startTurn,
            disconnect,
            answerQuestion,
            rollbackToStart,
            startTurnOn,
          }) =>
            Effect.gen(function* () {
              yield* startTurn;
              let requestId: RuntimeRequestId | undefined;
              const turn = yield* collectTurn(
                events.pipe(
                  Stream.tap((event) => {
                    if (
                      event.type !== "turn_item.updated" ||
                      event.turnItem.type !== "user_input_request" ||
                      event.turnItem.status !== "waiting"
                    )
                      return Effect.void;
                    requestId = event.turnItem.requestId;
                    return Deferred.succeed(questionSeen, undefined).pipe(
                      Effect.andThen(ending === "disconnect" ? disconnect : Effect.void),
                    );
                  }),
                ),
              );
              assert.equal(terminalStatus(turn), ending === "disconnect" ? "failed" : "completed");
              if (ending !== "disconnect") yield* Deferred.await(responseWritten);
              assert.ok(requestId);
              assert.isTrue(
                turn.some(
                  (event) =>
                    event.type === "runtime_request.updated" &&
                    event.runtimeRequest.id === requestId &&
                    event.runtimeRequest.status === "cancelled",
                ),
              );
              assert.isTrue(
                Exit.isFailure(
                  yield* answerQuestion(requestId, { answer: "late" }).pipe(Effect.exit),
                ),
              );
              if (ending !== "replacement") return;
              yield* rollbackToStart;
              yield* startTurnOn(2, "default");
              let answered = 0;
              const replacement = yield* collectTurn(
                events.pipe(
                  Stream.tap((event) =>
                    Effect.gen(function* () {
                      if (
                        event.type !== "turn_item.updated" ||
                        event.turnItem.type !== "user_input_request" ||
                        event.turnItem.status !== "waiting"
                      )
                        return;
                      assert.equal(event.turnItem.questions[0]?.question, "Replacement question?");
                      assert.notEqual(event.turnItem.requestId, requestId);
                      assert.isTrue(
                        Exit.isFailure(
                          yield* answerQuestion(requestId!, { answer: "late old answer" }).pipe(
                            Effect.exit,
                          ),
                        ),
                      );
                      yield* answerQuestion(event.turnItem.requestId, {
                        answer: "replacement answer",
                      });
                      answered++;
                    }),
                  ),
                ),
              );
              assert.equal(answered, 1);
              assert.equal(terminalStatus(replacement), "completed");
            }),
        });
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([native, mcp])(
    "Stop dismisses %s and leaves a later question answerable",
    (method) =>
      Effect.gen(function* () {
        const payload = (question: string) =>
          method === native
            ? { question }
            : {
                elicitation: {
                  mode: "form",
                  message: question,
                  requestedSchema: {
                    type: "object",
                    properties: { answer: { type: "string" } },
                    required: ["answer"],
                  },
                },
              };
        const nativeResponseWritten = yield* Deferred.make<void>();
        yield* runKiroScript({
          scenario: `native-question-stop-${method === native ? "native" : "mcp"}`,
          testHooks: {
            onNativeResponseLifecycle: (event) =>
              event.type === "removed"
                ? Deferred.succeed(nativeResponseWritten, undefined).pipe(Effect.asVoid)
                : Effect.void,
          },
          wrapCancel: (send) => Deferred.await(nativeResponseWritten).pipe(Effect.andThen(send)),
          frames: [
            ...openSessionFrames({
              initialize: KIRO_V3_INITIALIZE,
              configOptions: [modeOption, autopilotOption("on")],
            }),
            turnPrompt,
            update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Question follows." },
            }),
            kiroSecretRequest(method, {
              sessionId: SESSION_ID,
              toolCallId: "reused",
              ...payload("First question?"),
            }),
            kiroSecretResponse(method, { action: method === native ? "dismissed" : "cancel" }),
            {
              type: "expect_outbound",
              label: "cancel",
              frame: {
                kind: "notification",
                method: "session/cancel",
                params: { sessionId: SESSION_ID },
              },
            },
            answer("session/prompt", { stopReason: "cancelled" }),
            turnPrompt,
            kiroSecretRequest(method, {
              sessionId: SESSION_ID,
              toolCallId: "reused",
              ...payload("Second question?"),
            }),
            kiroSecretResponse(
              method,
              method === native
                ? { action: "answered", answer: "second answer" }
                : { action: "accept", content: { answer: "second answer" } },
            ),
            answer("session/prompt", { stopReason: "end_turn" }),
            ...closeSession,
          ],
          drive: ({ events, startTurn, startTurnOn, interrupt, answerQuestion }) =>
            Effect.gen(function* () {
              yield* startTurn;
              let oldRequestId: RuntimeRequestId | undefined;
              const first = yield* collectTurn(
                events.pipe(
                  Stream.tap((event) => {
                    if (
                      event.type !== "turn_item.updated" ||
                      event.turnItem.type !== "user_input_request" ||
                      event.turnItem.status !== "waiting"
                    )
                      return Effect.void;
                    oldRequestId = event.turnItem.requestId;
                    return interrupt(event.turnItem.providerTurnId!);
                  }),
                ),
              );
              assert.equal(terminalStatus(first), "interrupted");
              assert.ok(oldRequestId);
              yield* startTurnOn(2, "default");
              const second = yield* collectTurn(
                events.pipe(
                  Stream.tap((event) =>
                    Effect.gen(function* () {
                      if (
                        event.type !== "turn_item.updated" ||
                        event.turnItem.type !== "user_input_request" ||
                        event.turnItem.status !== "waiting"
                      )
                        return;
                      assert.notEqual(event.turnItem.requestId, oldRequestId);
                      assert.isTrue(
                        Exit.isFailure(
                          yield* answerQuestion(oldRequestId!, { answer: "late" }).pipe(
                            Effect.exit,
                          ),
                        ),
                      );
                      yield* answerQuestion(event.turnItem.requestId, { answer: "second answer" });
                    }),
                  ),
                ),
              );
              assert.equal(terminalStatus(second), "completed");
            }),
        });
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

it.live.each(["foreground-new", "foreground-load", "shared", "without-optin"] as const)(
  "negotiates the strict Kiro 3.2.1 peer through %s stdio",
  (entry) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kiro-321-contract-" });
      const wirePath = path.join(root, "wire.jsonl");
      const capsPath = path.join(root, "capabilities.json");
      const source = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const wire = process.env.AFM_WIRE;
const caps = process.env.AFM_CAPS;
const sessionId = '${SESSION_ID}';
let offered = false, currentValue = 'files', verified = false, pending;
const config = () => offered ? [{ type: 'select', id: 'approveForMe', name: 'Approve for me', currentValue,
  options: [{value:'files', name:'Follow permission files'}, {value:'on', name:'On'}, {value:'off', name:'Off'}],
  _meta: {kiro: {approveForMe: {files: [], required: false}}} }] : [];
const send = message => { appendFileSync(wire, JSON.stringify({direction:'peer', ...message}) + '\\n');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\\n'); };
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(wire, JSON.stringify({direction:'client', ...request}) + '\\n');
  const {id, method, params} = request;
  if (id === 'uncertain') {
    if (request.result?.outcome?.optionId !== 'deny') throw Error('Original callback was not denied');
    send({id:pending, result:{stopReason:'end_turn'}}); return;
  }
  if (id === undefined) return;
  let result = {};
  if (method === 'initialize') {
    writeFileSync(caps, JSON.stringify(params.clientCapabilities));
    offered = params.clientCapabilities?._meta?.kiro?.approveForMeOption === true && process.env.KIRO_TRUST_CLASSIFIER_MODE === 'enforce';
    result = {protocolVersion:1, agentCapabilities:{loadSession:true, sessionCapabilities:{close:{}}}};
  } else if (method === 'session/new' || method === 'session/load') {
    verified = false;
    result = {sessionId, configOptions:config()};
  } else if (method === 'session/set_config_option') {
    if (typeof params.value !== 'boolean') {
      if (!offered || params.configId !== 'approveForMe' || !['files','on','off'].includes(params.value)) {
        send({id, error:{code:-32602, message:'Invalid native selection'}}); return;
      }
      currentValue = params.value;
      verified = currentValue === 'on';
    }
    result = {configOptions:config()};
  } else if (method === 'session/prompt') {
    if (!offered || !verified || currentValue !== 'on') throw Error('Prompt before verified native activation');
    pending = id;
    send({id:'uncertain', method:'session/request_permission', params:{sessionId,
      toolCall:{toolCallId:'uncertain', title:'Uncertain native action', kind:'execute'},
      options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
    return;
  } else if (method !== 'session/close') throw Error('Unexpected request: ' + method);
  send({id, result});
});
`;
      const binaryPath = writeFakeCli({ directory: root, name: "kiro-contract", source });
      const settings = decodeKiroTestSettings({ enabled: true, binaryPath });
      const environment = { AFM_WIRE: wirePath, AFM_CAPS: capsPath, HOME: root, KIRO_HOME: root };
      const instanceId = ProviderInstanceId.make(`kiro-321-${entry}`);
      const threadId = ThreadId.make(`kiro-321-${entry}`);
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        cwd: root,
        runtimeMode: "auto",
        interactionMode: "default",
      });
      let callbacks = 0;
      if (entry === "shared" || entry === "without-optin") {
        const clientCapabilities = {
          session: { list: {}, configOptions: { boolean: { retained: true } } },
          _meta: {
            other: { retained: true },
            kiro: {
              hooks: { enabled: true, v2: true },
              secretStorage: true,
              userInput: true,
              retained: true,
            },
          },
        };
        const runtime = yield* entry === "shared"
          ? makeKiroAcpRuntime({
              cwd: root,
              clientInfo: { name: "t3-code-test", version: "0" },
              settings,
              environment,
              nativeAuto: true,
              clientCapabilities,
            })
          : AcpSessionRuntime.make({
              cwd: root,
              clientInfo: { name: "t3-code-test", version: "0" },
              clientCapabilities,
              spawn: {
                command: binaryPath,
                args: [],
                cwd: root,
                env: { ...environment, KIRO_TRUST_CLASSIFIER_MODE: "enforce" },
              },
            });
        yield* runtime.handleRequestPermission(() => {
          callbacks++;
          return Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "deny" } });
        });
        yield* runtime.start();
        if (entry === "without-optin") assert.deepEqual(yield* runtime.getConfigOptions, []);
        else {
          const ignored = yield* runtime.request("session/set_config_option", {
            sessionId: SESSION_ID,
            configId: "approveForMe",
            type: "boolean",
            value: true,
          });
          assert.deepEqual(ignored, { configOptions: yield* runtime.getConfigOptions });
          assert.equal((yield* runtime.getConfigOptions)[0]?.currentValue, "files");
          yield* runtime.setConfigOption("approveForMe", "on", { resendCurrentValue: true });
          assert.equal((yield* runtime.getConfigOptions)[0]?.currentValue, "on");
          yield* runtime.prompt(
            { prompt: [{ type: "text", text: "Synthetic contract check" }] },
            {
              admission: {
                sessionId: SESSION_ID,
                configOptions: [{ id: "approveForMe", value: "on" }],
              },
            },
          );
        }
        const caps = JSON.parse(yield* fs.readFileString(capsPath));
        assert.deepEqual(caps._meta, {
          ...clientCapabilities._meta,
          kiro: {
            ...clientCapabilities._meta.kiro,
            ...(entry === "shared" ? { approveForMeOption: true } : {}),
          },
        });
        assert.deepEqual(caps.session, {
          ...clientCapabilities.session,
          notices: {},
          compaction: {},
        });
      } else {
        const adapter = yield* makeKiroAdapterV2({
          instanceId,
          settings,
          environment,
          selfInvocation: yield* resolveSelfInvocation(),
        });
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-${entry}`),
          modelSelection,
          runtimePolicy,
          ...(entry === "foreground-load" ? { initialNativeThreadId: SESSION_ID } : {}),
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turn = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 1,
          messageText: "Synthetic contract check",
        });
        const collected = yield* collectTurn(
          session.events.pipe(
            Stream.tap((event) => {
              if (
                event.type !== "runtime_request.updated" ||
                event.runtimeRequest.status !== "pending"
              )
                return Effect.void;
              callbacks++;
              return session.respondToRuntimeRequest({
                requestId: event.runtimeRequest.id,
                decision: "decline",
              });
            }),
          ),
        ).pipe(Effect.forkChild);
        yield* session.startTurn(turn);
        assert.equal(terminalStatus(yield* Fiber.join(collected)), "completed");
        const caps = JSON.parse(yield* fs.readFileString(capsPath));
        assert.deepEqual(caps._meta.kiro, {
          hooks: { enabled: true, v2: true },
          secretStorage: true,
          openExternalUrl: true,
          userInput: true,
          approveForMeOption: true,
        });
        assert.deepEqual(caps.session.configOptions.boolean, {});
      }
      assert.equal(callbacks, entry === "without-optin" ? 0 : 1);
      const wire = yield* fs.readFileString(wirePath);
      yield* Effect.logInfo("Strict synthetic Kiro 3.2.1 ACP stdio", { entry, wire });
      const evidenceDir = Option.getOrUndefined(
        yield* Config.option(Config.String("T3_KIRO_AFM_TEST_EVIDENCE_DIR")),
      );
      if (evidenceDir) {
        yield* fs.makeDirectory(evidenceDir, { recursive: true });
        yield* fs.writeFileString(path.join(evidenceDir, `${entry}.jsonl`), wire);
        yield* fs.copyFile(capsPath, path.join(evidenceDir, `${entry}-capabilities.json`));
        yield* fs.writeFileString(path.join(evidenceDir, "strict-peer-source.mjs"), source);
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

describe.each(["boolean", "select"] as const)("native Approve for Me %s contract", (contract) => {
  const approveForMeOption = (currentValue: boolean) =>
    contract === "select"
      ? {
          id: "approveForMe",
          name: "Approve for me",
          type: "select",
          currentValue: currentValue ? "on" : "files",
          options: [
            {
              group: "native",
              name: "Native policy",
              options: [
                { value: "files", name: "Follow permission files" },
                { value: "on", name: "On" },
                { value: "off", name: "Off" },
              ],
            },
          ],
        }
      : {
          id: "approveForMe",
          name: "Approve for Me",
          type: "boolean",
          currentValue,
        };
  const activateApproveForMe =
    contract === "select"
      ? setConfig("approveForMe", "on")
      : outbound("session/set_config_option", {
          sessionId: SESSION_ID,
          configId: "approveForMe",
          type: "boolean",
          value: true,
        });

  it.live.each(["new", "load"] as const)(
    "verifies native Approve for Me on %s before prompting",
    (activation) =>
      runKiroScript({
        scenario: `approve-for-me-${activation}`,
        runtimeMode: "auto",
        ...(activation === "load" ? { initialNativeThreadId: SESSION_ID } : {}),
        inspectRuntime: (input) => {
          assert.deepEqual(input.clientCapabilities?.session?.configOptions?.boolean, {});
          assert.equal(input.processEnvironment?.KIRO_TRUST_CLASSIFIER_MODE, "enforce");
        },
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound(activation === "load" ? "session/load" : "session/new", {
            ...(activation === "load" ? { sessionId: SESSION_ID } : {}),
            cwd: "<workspace>",
            mcpServers: "<any>",
          }),
          answer(
            activation === "load" ? "session/load" : "session/new",
            sessionSetup([approveForMeOption(false)]),
          ),
          activateApproveForMe,
          configResult([approveForMeOption(true)]),
          // Reverify even a previously true state before a subsequent prompt.
          activateApproveForMe,
          configResult([approveForMeOption(true)]),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ startTurn, events }) =>
          Effect.gen(function* () {
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("routes native Auto uncertainty to the original user callback", () =>
    runKiroScript({
      scenario: "approve-for-me-uncertain",
      runtimeMode: "auto",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        turnPrompt,
        update({
          sessionUpdate: "tool_call",
          toolCallId: "native-allowed",
          title: "Synthetic native allowed action",
          kind: "read",
          status: "completed",
        }),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "native-denied",
          title: "Synthetic native denied action",
          kind: "execute",
          status: "failed",
        }),
        {
          type: "emit_inbound",
          label: "uncertain",
          frame: {
            kind: "request",
            method: "session/request_permission",
            params: {
              sessionId: SESSION_ID,
              toolCall: { toolCallId: "uncertain", title: "Uncertain command", kind: "execute" },
              options: [
                { optionId: "accept", name: "Allow once", kind: "allow_once" },
                { optionId: "reject", name: "Deny", kind: "reject_once" },
              ],
            },
          },
        },
        {
          type: "expect_outbound",
          label: "original-callback-denied",
          frame: {
            kind: "response",
            method: "session/request_permission",
            result: { outcome: { outcome: "selected", optionId: "reject" } },
          },
        },
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn, respond }) =>
        Effect.gen(function* () {
          const pending = yield* Deferred.make<RuntimeRequestId>();
          const turn = yield* collectTurn(
            events.pipe(
              Stream.tap((event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
                  ? Deferred.succeed(pending, event.runtimeRequest.id)
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild);
          yield* startTurn;
          yield* respond(yield* Deferred.await(pending), "decline");
          assert.equal(terminalStatus(yield* Fiber.join(turn)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["approval-required", "full-access"] as const)(
    "reopens native Auto with classifier off when switching to %s",
    (mode) =>
      runKiroScript({
        scenario: `approve-for-me-switch-${mode}`,
        runtimeMode: "auto",
        inspectRuntime: (input) =>
          assert.equal(
            input.processEnvironment?.KIRO_TRUST_CLASSIFIER_MODE,
            input.runtimePolicy.runtimeMode === "auto" ? "enforce" : "off",
          ),
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", sessionSetup([approveForMeOption(false)])),
          activateApproveForMe,
          configResult([approveForMeOption(true)]),
          activateApproveForMe,
          configResult([approveForMeOption(true)]),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
        ],
        replacementFrames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", sessionSetup([approveForMeOption(true)])),
          outbound("session/load", {
            sessionId: SESSION_ID,
            cwd: "<workspace>",
            mcpServers: "<any>",
          }),
          answer("session/load", sessionSetup([approveForMeOption(true)])),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ startTurn, startTurnInMode, events }) =>
          Effect.gen(function* () {
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
            yield* startTurnInMode(2, mode);
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["approval-required", "full-access"] as const)(
    "reserves forged native approveForMe options in %s",
    (runtimeMode) =>
      runKiroScript({
        scenario: `approve-for-me-forged-${runtimeMode}`,
        runtimeMode,
        options: [{ id: "approveForMe", value: contract === "select" ? "on" : true }],
        policyOverrides: {
          maxRuntimeMode: "approval-required",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        },
        inspectRuntime: (input) =>
          assert.equal(input.processEnvironment?.KIRO_TRUST_CLASSIFIER_MODE, "off"),
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", sessionSetup([approveForMeOption(true)])),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ startTurn, events }) =>
          Effect.gen(function* () {
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["approval-required", "full-access"] as const)(
    "starts an enforce runtime when switching %s into native Auto",
    (runtimeMode) =>
      runKiroScript({
        scenario: `approve-for-me-enter-${runtimeMode}`,
        runtimeMode,
        inspectRuntime: (input) =>
          assert.equal(
            input.processEnvironment?.KIRO_TRUST_CLASSIFIER_MODE,
            input.runtimePolicy.runtimeMode === "auto" ? "enforce" : "off",
          ),
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", sessionSetup([approveForMeOption(true)])),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
        ],
        replacementFrames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", sessionSetup([approveForMeOption(false)])),
          outbound("session/load", {
            sessionId: SESSION_ID,
            cwd: "<workspace>",
            mcpServers: "<any>",
          }),
          answer("session/load", sessionSetup([approveForMeOption(true)])),
          activateApproveForMe,
          configResult([approveForMeOption(true)]),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ startTurn, startTurnInMode, events }) =>
          Effect.gen(function* () {
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
            yield* startTurnInMode(2, "auto");
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("verifies native Auto again on a rollback replacement", () =>
    runKiroScript({
      scenario: "approve-for-me-replacement",
      runtimeMode: "auto",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
      ],
      replacementFrames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ rollbackToStart, startTurn, events }) =>
        Effect.gen(function* () {
          yield* rollbackToStart;
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["false", "off", "missing", "type-flip", "choice-withdrawn", "true"] as const)(
    "admits native Auto at dispatch after preparation observes %s",
    (state) =>
      Effect.gen(function* () {
        const mcp = yield* McpProviderSessions.McpProviderSessions;
        const preparing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const observed = yield* Deferred.make<void>();
        const gate = makeProviderReplayGate(["withdraw-during-preparation"]);
        let writes = 0;
        let held = false;
        yield* runKiroScript({
          scenario: `approve-dispatch-${state}`,
          runtimeMode: "auto",
          replayGate: gate,
          wrapRuntime: (runtime) => ({
            ...runtime,
            setConfigOption: (id, value, options) =>
              runtime.setConfigOption(id, value, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (id === "approveForMe") writes++;
                  }),
                ),
              ),
          }),
          onSessionUpdate: ({ update }) =>
            update.sessionUpdate === "config_option_update"
              ? Deferred.succeed(observed, undefined).pipe(Effect.asVoid)
              : Effect.void,
          frames: [
            outbound("initialize"),
            answer("initialize", KIRO_V3_INITIALIZE),
            outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
            answer("session/new", sessionSetup([approveForMeOption(false)])),
            activateApproveForMe,
            configResult([approveForMeOption(true)]),
            activateApproveForMe,
            configResult([approveForMeOption(true)]),
            {
              ...update({
                sessionUpdate: "config_option_update",
                configOptions:
                  state === "missing"
                    ? []
                    : [
                        state === "type-flip"
                          ? contract === "select"
                            ? {
                                id: "approveForMe",
                                name: "Approve",
                                type: "boolean",
                                currentValue: true,
                              }
                            : {
                                id: "approveForMe",
                                name: "Approve",
                                type: "select",
                                currentValue: "on",
                                options: [{ value: "on", name: "On" }],
                              }
                          : state === "choice-withdrawn" && contract === "select"
                            ? {
                                ...approveForMeOption(true),
                                options: [{ value: "off", name: "Off" }],
                              }
                            : state === "off" && contract === "select"
                              ? { ...approveForMeOption(false), currentValue: "off" }
                              : approveForMeOption(
                                  state === "true" ||
                                    (state === "choice-withdrawn" && contract === "boolean"),
                                ),
                      ],
              }),
              label: "withdraw-during-preparation",
            },
            ...(state === "true" || (state === "choice-withdrawn" && contract === "boolean")
              ? [turnPrompt, answer("session/prompt", { stopReason: "end_turn" })]
              : []),
            ...(state === "false"
              ? [
                  activateApproveForMe,
                  configResult([approveForMeOption(true)]),
                  turnPrompt,
                  answer("session/prompt", { stopReason: "end_turn" }),
                ]
              : []),
            ...closeSession,
          ],
          drive: ({ startTurn, startTurnOn, events, hasPendingBackgroundWork }) =>
            Effect.gen(function* () {
              const terminal = yield* collectTurn(events).pipe(Effect.forkChild);
              const started = yield* Effect.exit(startTurn).pipe(Effect.forkChild);
              yield* Deferred.await(preparing);
              assert.equal(writes, 2);
              gate.release("withdraw-during-preparation");
              yield* Deferred.await(observed);
              yield* Deferred.succeed(release, undefined);
              const result = yield* Fiber.join(started);
              const settled = yield* Fiber.join(terminal);
              assert.equal(
                terminalStatus(settled),
                state === "true" || (state === "choice-withdrawn" && contract === "boolean")
                  ? "completed"
                  : "failed",
              );
              if (state === "true" || (state === "choice-withdrawn" && contract === "boolean"))
                assert.isTrue(Exit.isSuccess(result));
              else {
                assert.isTrue(Exit.isFailure(result));
                if (Exit.isFailure(result)) {
                  const error = Cause.findError(result.cause);
                  assert.isTrue(error._tag === "Success" && refusedBeforePrompt(error.success));
                }
              }
              assert.isFalse(yield* hasPendingBackgroundWork);
              if (state === "false") {
                yield* startTurnOn(2, "default");
                assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
              }
            }),
        }).pipe(
          Effect.provideService(McpProviderSessions.McpProviderSessions, {
            ...mcp,
            read: (threadId) =>
              Effect.suspend(() => {
                if (writes !== 2 || held) return mcp.read(threadId);
                held = true;
                return Deferred.succeed(preparing, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(mcp.read(threadId)),
                );
              }),
          }),
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("admits the incoming Supervised policy before forced native Auto replacement", () => {
    let made = 0;
    return runKiroScript({
      scenario: "approve-replacement-supervised",
      runtimeMode: "auto",
      inspectRuntime: (input) => {
        made++;
        assert.equal(input.runtimePolicy.runtimeMode, made === 1 ? "auto" : "approval-required");
        assert.equal(
          input.processEnvironment?.KIRO_TRUST_CLASSIFIER_MODE,
          made === 1 ? "enforce" : "off",
        );
      },
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
      ],
      replacementFrames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(true)])),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ forceReplacement, startTurnOn, events }) =>
        Effect.gen(function* () {
          yield* forceReplacement({ runtimeMode: "approval-required" });
          yield* startTurnOn(1, "default");
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          assert.equal(made, 2);
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  });

  it.live("retains native Auto ownership after a changed-policy candidate fails startup", () => {
    let made = 0;
    return runKiroScript({
      scenario: "approve-replacement-startup-failure",
      runtimeMode: "auto",
      inspectRuntime: (input) => {
        made++;
        assert.equal(
          input.processEnvironment?.KIRO_TRUST_CLASSIFIER_MODE,
          made === 1 ? "enforce" : "off",
        );
      },
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      replacementFrames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        {
          type: "emit_inbound",
          label: "candidate-startup-error",
          frame: {
            kind: "response",
            method: "session/new",
            error: { code: -32603, message: "Synthetic candidate startup failure" },
          },
        },
      ],
      drive: ({ forceReplacement, startTurn, events }) =>
        Effect.gen(function* () {
          const failed = yield* Effect.exit(forceReplacement({ runtimeMode: "approval-required" }));
          assert.isTrue(Exit.isFailure(failed));
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          assert.equal(made, 2);
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  });

  it.live.each([
    { approvalPolicy: "on-request" },
    { sandboxPolicy: { type: "readOnly" } },
    { interactionMode: "plan" as const },
    { maxRuntimeMode: "approval-required" as const },
  ])("rejects forbidden replacement policy before candidate construction (%j)", (policy) => {
    let made = 0;
    return runKiroScript({
      scenario: `approve-replacement-forbidden-${Object.keys(policy)[0]}`,
      runtimeMode: "auto",
      inspectRuntime: () => {
        made++;
      },
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ forceReplacement, startTurn, events }) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(forceReplacement(policy));
          assert.isTrue(Exit.isFailure(result));
          assert.equal(made, 1);
          if (Exit.isFailure(result)) assert.include(Cause.pretty(result.cause), "cannot enforce");
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          assert.equal(made, 1);
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  });

  it.live("keeps native errors after Auto dispatch classified as sent", () =>
    runKiroScript({
      scenario: "approve-dispatched-native-error",
      runtimeMode: "auto",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(false)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        turnPrompt,
        update({
          sessionUpdate: "config_option_update",
          configOptions: [approveForMeOption(false)],
        }),
        {
          type: "emit_inbound",
          label: "native-prompt-error",
          frame: {
            kind: "response",
            method: "session/prompt",
            error: { code: -32603, message: "Synthetic error after native acceptance" },
          },
        },
        ...closeSession,
      ],
      drive: ({ startTurn, events }) =>
        Effect.gen(function* () {
          yield* startTurn;
          const turn = yield* collectTurn(events);
          assert.equal(terminalStatus(turn), "failed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([false, true])(
    "publishes held ACP text through paragraph filtering only at its boundary (%s)",
    (paragraph) =>
      Effect.gen(function* () {
        const published = yield* Deferred.make<{
          raw: ProviderAdapterV2Event;
          delivered: ProviderAdapterV2Event | null;
        }>();
        const filter = makeAssistantStreamingFilter("paragraph");
        const text = "SCRIPTED waiting for browser cancellation." + (paragraph ? "\n\n" : "");
        yield* runKiroScript({
          scenario: `held-single-chunk-${paragraph}`,
          runtimeMode: "auto",
          frames: [
            outbound("initialize"),
            answer("initialize", KIRO_V3_INITIALIZE),
            outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
            answer("session/new", sessionSetup([approveForMeOption(false)])),
            activateApproveForMe,
            configResult([approveForMeOption(true)]),
            activateApproveForMe,
            configResult([approveForMeOption(true)]),
            turnPrompt,
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
            {
              type: "expect_outbound",
              label: "cancel",
              frame: {
                kind: "notification",
                method: "session/cancel",
                params: { sessionId: SESSION_ID },
              },
            },
            update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "SCRIPTED browser cancellation received." },
            }),
            answer("session/prompt", { stopReason: "cancelled" }),
            ...closeSession,
          ],
          drive: ({ startTurn, events, interrupt }) =>
            Effect.gen(function* () {
              const settled = yield* collectTurn(
                events.pipe(
                  Stream.tap((event) =>
                    event.type === "turn_item.updated" &&
                    event.turnItem.type === "assistant_message" &&
                    event.turnItem.streaming
                      ? Deferred.succeed(published, { raw: event, delivered: filter(event, 0) })
                      : Effect.void,
                  ),
                ),
              ).pipe(Effect.forkChild);
              yield* startTurn;
              const { raw: event, delivered } = yield* Deferred.await(published);
              assert.equal(delivered !== null, paragraph);
              if (
                delivered?.type === "turn_item.updated" &&
                delivered.turnItem.type === "assistant_message"
              )
                assert.equal(delivered.turnItem.text, text);
              assert.equal(event.type, "turn_item.updated");
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message"
              ) {
                assert.equal(event.turnItem.text, text);
                assert.equal(event.turnItem.status, "running");
                yield* interrupt(event.turnItem.providerTurnId!);
              }
              assert.equal(terminalStatus(yield* Fiber.join(settled)), "interrupted");
            }),
        });
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("marks lost native Auto activation as unsent preparation before prompting", () =>
    runKiroScript({
      scenario: "approve-for-me-withdrawn",
      runtimeMode: "auto",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer("session/new", sessionSetup([approveForMeOption(true)])),
        activateApproveForMe,
        configResult([approveForMeOption(true)]),
        activateApproveForMe,
        configResult([approveForMeOption(false)]),
        ...closeSession,
      ],
      drive: ({ startTurn }) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(startTurn);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isFailure(result)) {
            assert.include(Cause.pretty(result.cause), "ProviderAdapterTurnPreparationError");
            assert.include(Cause.pretty(result.cause), "approveForMe is unavailable");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([
    "absent",
    "select",
    "false",
    "off",
    "wrong-type",
    "choice-withdrawn",
    "effective",
    "no-op",
    "organization",
    "error",
  ] as const)("fails closed before prompting when native Approve for Me is %s", (failure) =>
    runKiroScript({
      scenario: `approve-for-me-${failure}`,
      runtimeMode: "auto",
      expectedOpenFailure:
        failure === "organization"
          ? "Organization requires"
          : failure === "error"
            ? "Synthetic native failure"
            : "approveForMe is unavailable",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer(
          "session/new",
          sessionSetup(
            failure === "absent"
              ? []
              : failure === "select"
                ? [
                    {
                      ...autopilotOption("off"),
                      id: "approveForMe",
                      options: [
                        { value: "files", name: "Follow permission files" },
                        { value: "off", name: "Off" },
                      ],
                    },
                  ]
                : [approveForMeOption(false)],
          ),
        ),
        ...(["absent", "select"].includes(failure)
          ? []
          : [
              activateApproveForMe,
              ...(["organization", "error"].includes(failure)
                ? [
                    {
                      type: "emit_inbound",
                      label: "native-rejection",
                      frame: {
                        kind: "response",
                        method: "session/set_config_option",
                        error: {
                          code: -32603,
                          message:
                            failure === "organization"
                              ? "Organization requires supervised permissions"
                              : "Synthetic native failure",
                        },
                      },
                    },
                  ]
                : [
                    ...(failure === "effective"
                      ? [
                          update({
                            sessionUpdate: "config_option_update",
                            configOptions: [approveForMeOption(false)],
                          }),
                        ]
                      : []),
                    configResult(
                      failure === "no-op"
                        ? []
                        : [
                            failure === "off" && contract === "select"
                              ? { ...approveForMeOption(false), currentValue: "off" }
                              : failure === "wrong-type"
                                ? contract === "select"
                                  ? {
                                      id: "approveForMe",
                                      name: "Approve",
                                      type: "boolean",
                                      currentValue: true,
                                    }
                                  : { ...autopilotOption("on"), id: "approveForMe" }
                                : failure === "choice-withdrawn" && contract === "select"
                                  ? {
                                      ...approveForMeOption(true),
                                      options: [
                                        { value: "files", name: "Follow permission files" },
                                      ],
                                    }
                                  : approveForMeOption(failure === "effective"),
                          ],
                    ),
                  ]),
            ]),
      ],
      drive: () => Effect.die("Unavailable native Auto must not open"),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2", () => {
  it.effect.each([true, false])(
    "applies workflow preference only when the session offers it (%s)",
    (offered) => {
      const preference = (currentValue: string) => ({
        type: "select",
        id: "workflowLaunch",
        name: "Workflow use",
        currentValue,
        options: [
          option("when-asked", "When asked"),
          option("large-tasks", "Large tasks only"),
          option("delegate-all", "Delegate all work"),
        ],
      });
      const configs = (autopilot: "on" | "off", value: string) => [
        modeOption,
        autopilotOption(autopilot),
        ...(offered ? [preference(value)] : []),
      ];
      const selection = (value: string) => [{ id: "workflowLaunch", value }];
      return runKiroScript({
        scenario: `workflow-preference-${offered}`,
        options: selection("large-tasks"),
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          ...kiroSessionNoise,
          answer("session/new", sessionSetup(configs("on", "when-asked"))),
          ...(offered
            ? [
                setConfig("workflowLaunch", "large-tasks"),
                configResult(configs("on", "large-tasks")),
              ]
            : []),
          setConfig("autopilot", "off"),
          configResult(configs("off", "large-tasks")),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...(offered
            ? [
                setConfig("workflowLaunch", "delegate-all"),
                configResult(configs("off", "delegate-all")),
              ]
            : []),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ events, startTurn, startTurnOn }) =>
          Effect.gen(function* () {
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
            yield* startTurnOn(2, "default", selection("delegate-all"));
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    },
  );

  it.effect.each(["pending", "running", "paused"] as const)(
    "keeps native workflow steps, approvals and Stop separate from later parent turns (%s member)",
    (unfinishedStatus) => {
      const workflowId = "wf-checks";
      const childSessionId = "wf-step-inspect";
      const secondSessionId = "wf-step-review";
      const retrySessionId = "wf-step-review-retry";
      const otherWorkflowId = "wf-other";
      const otherSessionId = "wf-step-other";
      const nodeTree = [
        { nodeId: "inspect", type: "step", agentName: "general-task-execution" },
        { nodeId: "review", type: "step", agentName: "general-task-execution" },
      ];
      const state = (status: string, sessionId = secondSessionId, memberStatus = status) => ({
        workflowId,
        workflowName: "Check the repository",
        parentSessionId: SESSION_ID,
        status,
        inputs: {},
        artifacts: {},
        capturedOutputs: {},
        root: {
          nodeId: "root",
          type: "sequence",
          status,
          children: [
            { nodeId: "inspect", type: "step", status: "completed", sessionId: childSessionId },
            { nodeId: "review", type: "step", status: memberStatus, sessionId },
          ],
        },
      });
      const workflowEvent = (name: string, params: Record<string, unknown>) =>
        kiroNotification(`_kiro/workflow/${name}`, {
          workflowId,
          parentSessionId: SESSION_ID,
          ...params,
        });
      const childSessionUpdate = (
        sessionId: string,
        sessionUpdate: Record<string, unknown>,
      ): Frame => ({
        type: "emit_inbound",
        label: `child.${sessionId}`,
        frame: {
          kind: "notification",
          method: "session/update",
          params: {
            sessionId,
            update: sessionUpdate,
          },
        },
      });
      const childUpdate = (sessionId: string, text: string) =>
        childSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      const childToolOutput = (sessionId: string, text: string) => [
        childSessionUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "workflow-tool",
          title: "Inspect workflow changes",
          kind: "execute",
          status: "inProgress",
        }),
        childSessionUpdate(sessionId, {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "workflow-tool",
          content: { type: "content", content: { type: "text", text } },
        }),
        childSessionUpdate(sessionId, {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "workflow-tool",
          content: { type: "diff", changes: [], patch: { format: "git_patch", text: "after" } },
        }),
      ];
      const permission = (sessionId: string, toolCallId: string): Frame => ({
        type: "emit_inbound",
        label: `permission.${toolCallId}`,
        frame: {
          kind: "request",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId, title: "Write changes", kind: "edit" },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
          },
        },
      });
      const permissionAccepted: Frame = {
        type: "expect_outbound",
        label: "unrelated.permission.accepted",
        frame: {
          kind: "response",
          method: "session/request_permission",
          result: { outcome: { outcome: "selected", optionId: "allow" } },
        },
      };
      const replayGate = makeProviderReplayGate(["terminal-permission-drained"]);
      return runKiroScript({
        scenario: "native-workflow-background",
        replayGate,
        frames: [
          ...openSessionFrames({
            initialize: {
              ...KIRO_V3_INITIALIZE,
              agentCapabilities: {
                ...KIRO_V3_INITIALIZE.agentCapabilities,
                _meta: {
                  kiro: { extensionMethods: ["_kiro/workflow/cancel", "_kiro/workflow/inspect"] },
                },
              },
            },
            configOptions: [modeOption, autopilotOption("on")],
          }),
          turnPrompt,
          workflowEvent("run_start", {
            workflowName: "Check the repository",
            inputs: {},
            nodeTree: nodeTree.slice(0, 1),
          }),
          workflowEvent("node_start", {
            nodeId: "inspect",
            nodePath: [workflowId, "inspect"],
            type: "step",
          }),
          workflowEvent("node_start", {
            nodeId: "inspect",
            nodePath: [workflowId, "inspect"],
            type: "step",
            sessionId: childSessionId,
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          {
            type: "emit_inbound",
            label: "workflow.permission",
            frame: {
              kind: "request",
              method: "session/request_permission",
              params: {
                sessionId: childSessionId,
                toolCall: { toolCallId: "wf-write", title: "Write inspection", kind: "edit" },
                options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
              },
            },
          },
          {
            type: "expect_outbound",
            label: "workflow.permission.result",
            frame: {
              kind: "response",
              method: "session/request_permission",
              result: { outcome: { outcome: "selected", optionId: "allow" } },
            },
          },
          kiroSecretRequest("_kiro/userInput", {
            sessionId: childSessionId,
            toolCallId: "wf-question",
            question: "Which inspection?",
          }),
          kiroSecretResponse("_kiro/userInput", {
            action: "answered",
            answer: "the focused inspection",
          }),
          turnPrompt,
          ...childToolOutput(childSessionId, "Inspection stdout\n"),
          childSessionUpdate(childSessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "workflow-tool",
            status: "completed",
          }),
          childUpdate(childSessionId, "Inspection complete"),
          workflowEvent("node_complete", {
            nodeId: "inspect",
            nodePath: [workflowId, "inspect"],
            status: "completed",
            capturedOutput: "Inspection complete",
          }),
          workflowEvent("node_start", {
            nodeId: "review",
            nodePath: [workflowId, "review"],
            type: "step",
            sessionId: secondSessionId,
          }),
          childUpdate(secondSessionId, "Review in progress"),
          ...childToolOutput(secondSessionId, "Review stdout\n"),
          workflowEvent("run_start", {
            workflowId: otherWorkflowId,
            workflowName: "Other workflow",
            nodeTree: [{ nodeId: "audit", type: "step" }],
          }),
          workflowEvent("node_start", {
            workflowId: otherWorkflowId,
            nodeId: "audit",
            nodePath: [otherWorkflowId, "audit"],
            type: "step",
            sessionId: otherSessionId,
          }),
          ...childToolOutput(otherSessionId, "Other stdout\n"),
          permission(SESSION_ID, "parent-write"),
          permission(otherSessionId, "other-write"),
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Parent reply" },
          }),
          {
            type: "emit_inbound",
            label: "workflow.review.permission",
            frame: {
              kind: "request",
              method: "session/request_permission",
              params: {
                sessionId: secondSessionId,
                toolCall: { toolCallId: "wf-review-write", title: "Write review", kind: "edit" },
                options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
              },
            },
          },
          workflowEvent("paused", { pauseReason: "Needs another review" }),
          workflowEvent("run_complete", {
            status: "paused",
            finalState: state("paused", secondSessionId, unfinishedStatus),
          }),
          outbound("_kiro/workflow/cancel", { workflowId, initiator: "user" }),
          answer("_kiro/workflow/cancel", { ok: true, previousStatus: "paused" }),
          workflowEvent("run_complete", {
            status: "aborted",
            finalState: state("aborted", secondSessionId, unfinishedStatus),
          }),
          {
            type: "expect_outbound",
            label: "workflow.review.permission.cancelled",
            frame: {
              kind: "response",
              method: "session/request_permission",
              result: { outcome: { outcome: "cancelled" } },
            },
          },
          {
            type: "emit_inbound",
            label: "workflow.terminal.permission",
            frame: {
              kind: "request",
              method: "session/request_permission",
              params: {
                sessionId: secondSessionId,
                toolCall: { toolCallId: "wf-late-write", title: "Late write", kind: "edit" },
                options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
              },
            },
          },
          {
            type: "expect_outbound",
            label: "workflow.terminal.permission.cancelled",
            frame: {
              kind: "response",
              method: "session/request_permission",
              result: { outcome: { outcome: "cancelled" } },
            },
          },
          kiroSecretRequest("_kiro/userInput", {
            sessionId: secondSessionId,
            toolCallId: "wf-late-question",
            question: "Retired step?",
          }),
          kiroSecretResponse("_kiro/userInput", { action: "dismissed" }),
          {
            ...workflowEvent("paused", { pauseReason: "Late duplicate pause" }),
            label: "terminal-permission-drained",
          },
          permissionAccepted,
          permissionAccepted,
          workflowEvent("run_complete", {
            workflowId: otherWorkflowId,
            status: "completed",
            finalState: {
              workflowId: otherWorkflowId,
              workflowName: "Other workflow",
              parentSessionId: SESSION_ID,
              status: "completed",
              root: {
                nodeId: "root",
                type: "sequence",
                status: "completed",
                children: [
                  { nodeId: "audit", type: "step", status: "completed", sessionId: otherSessionId },
                ],
              },
            },
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          turnPrompt,
          workflowEvent("run_start", {
            workflowName: "Check the repository",
            inputs: {},
            nodeTree,
          }),
          outbound("_kiro/workflow/inspect", { workflowId }),
          {
            type: "emit_inbound",
            label: "workflow.retry.permission",
            frame: {
              kind: "request",
              method: "session/request_permission",
              params: {
                sessionId: retrySessionId,
                toolCall: { toolCallId: "wf-retry-write", title: "Write retry", kind: "edit" },
                options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
              },
            },
          },
          answer("_kiro/workflow/inspect", {
            workflowId,
            state: state("running", retrySessionId),
            nodePlan: nodeTree,
          }),
          {
            type: "expect_outbound",
            label: "workflow.retry.permission.result",
            frame: {
              kind: "response",
              method: "session/request_permission",
              result: { outcome: { outcome: "selected", optionId: "allow" } },
            },
          },
          childUpdate(secondSessionId, "Stale prior attempt"),
          ...childToolOutput(retrySessionId, "Retry stdout\n"),
          childUpdate(retrySessionId, "Retry complete"),
          answer("session/prompt", { stopReason: "end_turn" }),
          workflowEvent("run_complete", {
            status: "completed",
            finalState: state("completed", retrySessionId),
          }),
          ...closeSession,
        ],
        drive: ({
          events,
          startTurn,
          startTurnOn,
          respond,
          answerQuestion,
          hasPendingBackgroundWork,
          stopWorkflow,
        }) =>
          Effect.gen(function* () {
            const firstDone = yield* Deferred.make<void>();
            const secondDone = yield* Deferred.make<void>();
            const paused = yield* Deferred.make<void>();
            const cancelled = yield* Deferred.make<void>();
            const workflowQuestion = yield* Deferred.make<RuntimeRequestId>();
            const approval = yield* Deferred.make<{ id: RuntimeRequestId; threadId: ThreadId }>();
            const reviewApproval = yield* Deferred.make<RuntimeRequestId>();
            const retryApproval = yield* Deferred.make<RuntimeRequestId>();
            const parentApproval = yield* Deferred.make<RuntimeRequestId>();
            const otherApproval = yield* Deferred.make<RuntimeRequestId>();
            const requestStates = new Map<RuntimeRequestId, string>();
            const requestOwners = new Map<RuntimeRequestId, ThreadId>();
            const memberStates = new Map<ThreadId, string>();
            const toolStates = new Map<ThreadId, string>();
            let terminalCount = 0;
            const collected = yield* events.pipe(
              Stream.tap((event) => {
                if (event.type === "subagent.updated" && event.subagent.childThreadId !== null) {
                  memberStates.set(event.subagent.childThreadId, event.subagent.status);
                }
                if (event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool") {
                  toolStates.set(event.turnItem.threadId, event.turnItem.status);
                }
                if (event.type === "turn.terminal") {
                  terminalCount += 1;
                  return Deferred.succeed(terminalCount === 1 ? firstDone : secondDone, undefined);
                }
                if (event.type === "runtime_request.updated") {
                  requestStates.set(event.runtimeRequest.id, event.runtimeRequest.status);
                  if (event.threadId !== undefined)
                    requestOwners.set(event.runtimeRequest.id, event.threadId);
                  if (event.runtimeRequest.status !== "pending") return Effect.void;
                  if (event.runtimeRequest.kind === "user_input")
                    return Deferred.succeed(workflowQuestion, event.runtimeRequest.id);
                  if (event.runtimeRequest.nativeRequestRef?.nativeId === "parent-write") {
                    return Deferred.succeed(parentApproval, event.runtimeRequest.id);
                  }
                  if (event.runtimeRequest.nativeRequestRef?.nativeId?.includes("other-write")) {
                    return Deferred.succeed(otherApproval, event.runtimeRequest.id);
                  }
                  if (event.runtimeRequest.nativeRequestRef?.nativeId?.includes("wf-retry-write")) {
                    return Deferred.succeed(retryApproval, event.runtimeRequest.id);
                  }
                  if (
                    event.runtimeRequest.nativeRequestRef?.nativeId?.includes("wf-review-write")
                  ) {
                    return Deferred.succeed(reviewApproval, event.runtimeRequest.id);
                  }
                  return Deferred.succeed(approval, {
                    id: event.runtimeRequest.id,
                    threadId: event.threadId!,
                  });
                }
                if (
                  event.type === "subagent.updated" &&
                  event.subagent.workflow !== undefined &&
                  event.subagent.status === "waiting"
                ) {
                  return Deferred.succeed(paused, undefined);
                }
                if (
                  event.type === "subagent.updated" &&
                  event.subagent.workflow !== undefined &&
                  event.subagent.status === "cancelled"
                ) {
                  return Deferred.succeed(cancelled, undefined);
                }
                return Effect.void;
              }),
              Stream.takeUntil(
                (event) =>
                  event.type === "subagent.updated" &&
                  event.subagent.workflow !== undefined &&
                  event.subagent.nativeTaskRef?.nativeId === workflowId &&
                  event.subagent.status === "completed",
              ),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* startTurn;
            yield* Deferred.await(firstDone);
            assert.isTrue(yield* hasPendingBackgroundWork);
            const request = yield* Deferred.await(approval);
            assert.isDefined(request.threadId);
            assert.notEqual(String(request.threadId), "thread-kiro-native-workflow-background");
            yield* respond(request.id, "accept");
            const questionId = yield* Deferred.await(workflowQuestion);
            assert.equal(requestOwners.get(questionId), request.threadId);
            yield* answerQuestion(questionId, { answer: "the focused inspection" });
            yield* startTurnOn(2, "default");
            yield* Deferred.await(paused);
            const reviewRequestId = yield* Deferred.await(reviewApproval);
            const parentRequestId = yield* Deferred.await(parentApproval);
            const otherRequestId = yield* Deferred.await(otherApproval);
            assert.isTrue(yield* hasPendingBackgroundWork);
            yield* stopWorkflow(workflowId);
            yield* Deferred.await(cancelled);
            assert.equal(requestStates.get(reviewRequestId), "cancelled");
            assert.equal(memberStates.get(request.threadId), "completed");
            assert.equal(toolStates.get(request.threadId), "completed");
            const reviewThreadId = requestOwners.get(reviewRequestId)!;
            assert.equal(memberStates.get(reviewThreadId), "cancelled");
            assert.equal(toolStates.get(reviewThreadId), "interrupted");
            assert.equal(requestStates.get(parentRequestId), "pending");
            assert.equal(requestStates.get(otherRequestId), "pending");
            assert.equal(toolStates.get(requestOwners.get(otherRequestId)!), "running");
            assert.isTrue(yield* hasPendingBackgroundWork);
            assert.equal(
              (yield* Effect.result(respond(reviewRequestId, "accept")))._tag,
              "Failure",
            );
            yield* Effect.promise(() => replayGate.waitForReached("terminal-permission-drained"));
            replayGate.release("terminal-permission-drained");
            yield* respond(parentRequestId, "accept");
            yield* respond(otherRequestId, "accept");
            yield* Deferred.await(secondDone);
            assert.isFalse(yield* hasPendingBackgroundWork);
            yield* startTurnOn(3, "default");
            const retryRequestId = yield* Deferred.await(retryApproval);
            assert.equal(requestOwners.get(retryRequestId), requestOwners.get(reviewRequestId));
            yield* respond(retryRequestId, "accept");
            const recorded = Array.from(yield* Fiber.join(collected));
            const workflows = recorded.flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.workflow !== undefined &&
              event.subagent.nativeTaskRef?.nativeId === workflowId
                ? [event.subagent]
                : [],
            );
            const memberThreadIds = new Set(
              workflows.flatMap((workflow) =>
                (workflow.workflow?.agents ?? []).flatMap((member) =>
                  member.childThreadId === undefined ? [] : [member.childThreadId],
                ),
              ),
            );
            const makeRoute = (providerTurn: OrchestrationV2ProviderTurn) => {
              const identity = {
                threadId: ThreadId.make("thread-kiro-native-workflow-background"),
                runId: RunId.make(
                  `run:thread-kiro-native-workflow-background:${providerTurn.ordinal}`,
                ),
                attemptId: providerTurn.runAttemptId!,
                providerThreadId: providerTurn.providerThreadId,
              };
              return {
                identity,
                state: makeProviderEventRoutingState({ identity, providerTurnId: providerTurn.id }),
              };
            };
            const routes = new Map<number, ReturnType<typeof makeRoute>>();
            for (const event of recorded) {
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.status === "running" &&
                !routes.has(event.providerTurn.ordinal)
              ) {
                routes.set(event.providerTurn.ordinal, makeRoute(event.providerTurn));
              }
              let accepted = false;
              let originalRunAccepted = false;
              for (const [ordinal, route] of routes) {
                const [admitted, next] = routeProviderEvent(event, route.identity, route.state);
                route.state = next;
                accepted ||= admitted;
                if (ordinal === 1) originalRunAccepted = admitted;
              }
              if (event.type === "app_thread.created") {
                assert.isTrue(
                  memberThreadIds.has(event.appThread.id) ? originalRunAccepted : accepted,
                  `must create linked thread ${event.appThread.id} through its owner`,
                );
              }
            }
            assert.isFalse(yield* hasPendingBackgroundWork);
            assert.isFalse(
              recorded.some(
                (event) =>
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.nativeRequestRef?.nativeId?.includes("wf-late-write"),
              ),
            );
            assert.isTrue(workflows.length > 0);
            assert.deepEqual(
              [...new Set(workflows.map((entry) => entry.runId))],
              [RunId.make("run:thread-kiro-native-workflow-background:1")],
            );
            assert.equal(workflows.at(-1)?.workflow?.agents.length, 2);
            assert.isTrue(
              workflows
                .at(-1)
                ?.workflow?.agents.every((member) => member.childThreadId !== undefined),
            );
            const childMessages = recorded.flatMap((event) =>
              event.type === "message.updated" && event.message.role === "assistant"
                ? [event.message]
                : [],
            );
            const parentReply = childMessages.find((message) => message.text === "Parent reply");
            const tools = recorded.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
                ? [event.turnItem]
                : [],
            );
            const inspectionThreadId = childMessages.find(
              (message) => message.text === "Inspection complete",
            )?.threadId;
            const retryThreadId = childMessages.find(
              (message) => message.text === "Retry complete",
            )?.threadId;
            const inspectionTool = tools
              .filter((tool) => tool.threadId === inspectionThreadId)
              .at(-1);
            const retryTool = tools.filter((tool) => tool.threadId === retryThreadId).at(-1);
            const previousAttemptTool = tools.find((tool) => tool.threadId === retryThreadId);
            assert.isDefined(inspectionTool);
            assert.isDefined(retryTool);
            assert.deepEqual(inspectionTool?.output, {
              type: "Text",
              text: "Inspection stdout\nafter",
            });
            assert.deepEqual(retryTool?.output, { type: "Text", text: "Retry stdout\nafter" });
            assert.isDefined(previousAttemptTool);
            assert.notEqual(previousAttemptTool?.id, retryTool?.id);
            assert.notEqual(inspectionTool?.id, retryTool?.id);
            assert.notEqual(inspectionTool?.threadId, retryTool?.threadId);
            assert.notEqual(inspectionTool?.threadId, parentReply?.threadId);
            assert.equal(
              parentReply?.threadId,
              ThreadId.make("thread-kiro-native-workflow-background"),
            );
            assert.isTrue(
              childMessages.some(
                (message) =>
                  message.text === "Inspection complete" &&
                  message.threadId !== parentReply?.threadId,
              ),
            );
            assert.isFalse(
              childMessages.some((message) => message.text.includes("Stale prior attempt")),
            );
            assert.isTrue(childMessages.some((message) => message.text === "Retry complete"));
            assert.deepEqual(
              workflows
                .find((workflow) => workflow.status === "waiting")
                ?.workflow?.agents.map((member) => member.childThreadId),
              workflows.at(-1)?.workflow?.agents.map((member) => member.childThreadId),
            );
            assert.isTrue(
              childMessages.some(
                (message) =>
                  message.text === "Review in progress" &&
                  message.threadId !== parentReply?.threadId,
              ),
            );
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    },
  );

  it.effect.each(["supported", "withdrawn", "changed-type", "absent"])(
    "revalidates per-chat Reflection and provider Content collection against %s native options",
    (availability) => {
      const reflection = {
        id: "memoryReflection",
        name: "Memory reflection",
        type: "select" as const,
        currentValue: "off",
        options:
          availability === "withdrawn"
            ? []
            : [
                { value: "on", name: "On" },
                { value: "off", name: "Off" },
              ],
      };
      const collection = {
        id: "contentCollection",
        name: "Content collection",
        type: "select" as const,
        currentValue: "disabled",
        options:
          availability === "withdrawn"
            ? []
            : [
                { value: "enabled", name: "Enabled" },
                { value: "disabled", name: "Disabled" },
              ],
      };
      const preferences =
        availability === "absent"
          ? []
          : availability === "changed-type"
            ? [reflection, collection].map((option) => ({
                id: option.id,
                name: option.name,
                type: "boolean" as const,
                currentValue: false,
              }))
            : [reflection, collection];
      const configOptions = [modeOption, autopilotOption("on"), ...preferences];
      return runKiroScript({
        scenario: `session-preferences-${availability}`,
        settings: { contentCollection: "enabled" },
        options: [
          { id: "memoryReflection", value: "on" },
          { id: "contentCollection", value: "disabled" },
        ],
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          ...kiroSessionNoise,
          answer("session/new", sessionSetup(configOptions)),
          ...(availability === "supported"
            ? [
                outbound("session/set_config_option", {
                  sessionId: SESSION_ID,
                  configId: "memoryReflection",
                  value: "on",
                }),
                answer("session/set_config_option", {
                  configOptions: [
                    modeOption,
                    autopilotOption("on"),
                    { ...reflection, currentValue: "on" },
                    collection,
                  ],
                }),
                outbound("session/set_config_option", {
                  sessionId: SESSION_ID,
                  configId: "contentCollection",
                  value: "enabled",
                }),
                answer("session/set_config_option", {
                  configOptions: [
                    modeOption,
                    autopilotOption("on"),
                    { ...reflection, currentValue: "on" },
                    { ...collection, currentValue: "enabled" },
                  ],
                }),
              ]
            : []),
          outbound("session/set_config_option", {
            sessionId: SESSION_ID,
            configId: "autopilot",
            value: "off",
          }),
          answer("session/set_config_option", {
            configOptions: [
              modeOption,
              autopilotOption("off"),
              ...preferences.map((option) =>
                availability === "supported"
                  ? {
                      ...option,
                      currentValue: option.id === "contentCollection" ? "enabled" : "on",
                    }
                  : option,
              ),
            ],
          }),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }),
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    },
  );

  it.effect("opens a session and refuses compaction on a deployment with no Kiro extensions", () =>
    runKiroScript({
      scenario: "no-extensions",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE_WITHOUT_EXTENSIONS),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // No autopilot option advertised, so T3 sends no config write.
        answer("session/new", sessionSetup([modeOption])),
        turnPrompt,
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        }),
        answer("session/prompt", { stopReason: "end_turn" }),
      ],
      drive: ({ events, startTurn, compact }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          // `_kiro/session/compact` is not advertised, so T3 must not send it.
          const compacted = yield* Effect.exit(compact(2));
          const error = Exit.isFailure(compacted) ? Cause.squash(compacted.cause) : undefined;
          assert.instanceOf(error, ProviderAdapterTurnStartError);
          assert.instanceOf(
            (error as ProviderAdapterTurnStartError).cause,
            ProviderCompactionUnsupportedError,
          );
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("switches back to Kiro's default model after a named one", () =>
    runKiroScript({
      scenario: "default-after-named",
      frames: [
        ...openSessionFrames({
          initialize: KIRO_V3_INITIALIZE,
          configOptions: [modeOption, modelOption("auto"), autopilotOption("on")],
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        outbound("session/set_config_option", {
          sessionId: SESSION_ID,
          configId: "model",
          value: "claude-sonnet",
        }),
        answer("session/set_config_option", {
          configOptions: [modeOption, modelOption("claude-sonnet"), autopilotOption("off")],
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // "Kiro default" is Kiro's `auto`, so the session leaves the named model.
        outbound("session/set_config_option", {
          sessionId: SESSION_ID,
          configId: "model",
          value: "auto",
        }),
        answer("session/set_config_option", {
          configOptions: [modeOption, modelOption("auto"), autopilotOption("off")],
        }),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          // The session already runs `auto`, so the first default turn sends no write.
          for (const [ordinal, model] of [
            [1, "default"],
            [2, "claude-sonnet"],
            [3, "default"],
          ] as const) {
            yield* startTurnOn(ordinal, model);
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sets the thread's effort once the model write advertises it, and after a switch", () =>
    runKiroScript({
      scenario: "effort-after-model",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // On `auto` Kiro offers no effort option.
        answer(
          "session/new",
          sessionSetup([modeOption, kiroModelOption("auto"), autopilotOption("on")]),
        ),
        // Turn 1: the model write's result is the first to advertise effort,
        // at the model's default, so the chosen level goes out after it.
        setConfig("model", "claude-opus-5.5"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("on"),
          effortOption("medium", CLAUDE_EFFORT_LEVELS),
        ]),
        setConfig("effortLevel", "high"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("on"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 2: same model and effort, so nothing is written.
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 3: a model without effort drops the option; no effort write.
        setConfig("model", "claude-sonnet-4.5"),
        configResult([modeOption, kiroModelOption("claude-sonnet-4.5"), autopilotOption("off")]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 4: back on an effort model, Kiro starts at its default again.
        setConfig("model", "claude-opus-5.5"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
          effortOption("medium", CLAUDE_EFFORT_LEVELS),
        ]),
        setConfig("effortLevel", "high"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      model: "claude-opus-5.5",
      options: reasoning("high"),
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          for (const [ordinal, model] of [
            [1, "claude-opus-5.5"],
            [2, "claude-opus-5.5"],
            [3, "claude-sonnet-4.5"],
            [4, "claude-opus-5.5"],
          ] as const) {
            yield* startTurnOn(ordinal, model, reasoning("high"));
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([
    { label: "default", model: "default", advertised: false, wantsEffort: true },
    { label: "explicit", model: "claude-opus-5.5", advertised: false, wantsEffort: true },
    { label: "advertised-default", model: "default", advertised: true, wantsEffort: true },
    { label: "untouched-default", model: "default", advertised: false, wantsEffort: false },
  ])("honors $label before the first prompt with late model options", (row) =>
    runKiroScript({
      scenario: `first-prompt-${row.label}`,
      model: row.model,
      defaultModel: "claude-opus-5.5",
      ...(row.wantsEffort ? { options: reasoning("high") } : {}),
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer(
          "session/new",
          sessionSetup([
            modeOption,
            ...(row.advertised ? [kiroModelOption("claude-opus-5.5")] : []),
          ]),
        ),
        ...(row.wantsEffort
          ? [
              setConfig("model", "claude-opus-5.5"),
              configResult([
                modeOption,
                kiroModelOption("claude-opus-5.5"),
                effortOption("medium", CLAUDE_EFFORT_LEVELS),
              ]),
              setConfig("effortLevel", "high"),
              configResult([
                modeOption,
                kiroModelOption("claude-opus-5.5"),
                effortOption("high", CLAUDE_EFFORT_LEVELS),
              ]),
            ]
          : []),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("waits for Kiro to advertise the model before setting its effort", () =>
    runKiroScript({
      scenario: "effort-after-advert",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // Kiro 2.27.0 leaves `model` out of `session/new`.
        answer("session/new", sessionSetup([modeOption, autopilotOption("on")])),
        // Written before Kiro advertised anything: the result carries neither
        // the model nor its effort, and an effort write now would be ignored.
        setConfig("model", "claude-opus-5.5"),
        configResult([modeOption, autopilotOption("on")]),
        update({
          sessionUpdate: "config_option_update",
          configOptions: [
            modeOption,
            kiroModelOption("claude-opus-5.5"),
            effortOption("medium", CLAUDE_EFFORT_LEVELS),
            autopilotOption("on"),
          ],
        }),
        setConfig("effortLevel", "high"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
          autopilotOption("on"),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-5.5"),
          effortOption("high", CLAUDE_EFFORT_LEVELS),
          autopilotOption("off"),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      model: "claude-opus-5.5",
      options: reasoning("high"),
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          yield* startTurnOn(1, "claude-opus-5.5", reasoning("high"));
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("never sends an effort level the model does not offer", () =>
    runKiroScript({
      scenario: "effort-not-offered",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer(
          "session/new",
          sessionSetup([modeOption, kiroModelOption("auto"), autopilotOption("on")]),
        ),
        // Turn 1 asks for xhigh, which Opus 4.6 does not offer: no effort
        // write, and the turn runs at Kiro's default.
        setConfig("model", "claude-opus-4.6"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-4.6"),
          autopilotOption("on"),
          effortOption("high", CLAUDE_4_6_EFFORT_LEVELS),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-4.6"),
          autopilotOption("off"),
          effortOption("high", CLAUDE_4_6_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 2 picks max, which it offers.
        setConfig("effortLevel", "max"),
        configResult([
          modeOption,
          kiroModelOption("claude-opus-4.6"),
          autopilotOption("off"),
          effortOption("max", CLAUDE_4_6_EFFORT_LEVELS),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      model: "claude-opus-4.6",
      options: reasoning("xhigh"),
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          for (const [ordinal, effort] of [
            [1, "xhigh"],
            [2, "max"],
          ] as const) {
            yield* startTurnOn(ordinal, "claude-opus-4.6", reasoning(effort));
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          }
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("answers a stale 'this session' approval with Kiro's allow_once", () =>
    runKiroScript({
      scenario: "stale-session-approval",
      frames: [
        ...openSessionFrames({
          initialize: KIRO_V3_INITIALIZE,
          configOptions: [modeOption, autopilotOption("on")],
        }),
        turnPrompt,
        {
          type: "emit_inbound",
          label: "session/request_permission",
          frame: {
            kind: "request",
            method: "session/request_permission",
            // Kiro 2.27's options for a write (kiro_supervised_transcript.ndjson).
            params: {
              sessionId: SESSION_ID,
              toolCall: { toolCallId: "call-1", title: "Write File", kind: "edit" },
              options: [
                { optionId: "accept", name: "Allow", kind: "allow_once" },
                { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
                { optionId: "reject", name: "Deny", kind: "reject_once" },
              ],
            },
          },
        },
        // The card offered no "this session" choice, so the answer is one-time
        // rather than Kiro's workspace-wide `allow_always`.
        {
          type: "expect_outbound",
          label: "session/request_permission.result",
          frame: {
            kind: "response",
            method: "session/request_permission",
            result: { outcome: { outcome: "selected", optionId: "accept" } },
          },
        },
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn, respond }) =>
        Effect.gen(function* () {
          const pending = yield* Deferred.make<RuntimeRequestId>();
          const turn = yield* collectTurn(
            events.pipe(
              Stream.tap((event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
                  ? Deferred.succeed(pending, event.runtimeRequest.id)
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild);
          yield* startTurn;
          yield* respond(yield* Deferred.await(pending), "acceptForSession");
          assert.equal(terminalStatus(yield* Fiber.join(turn)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("advertises secret storage without importing native credentials", () =>
    Effect.gen(function* () {
      const kiroHome = yield* makeKiroHome({ [MCP_TOKENS_KEY]: MCP_TOKENS });
      yield* runKiroScript({
        scenario: "secret-get",
        environment: kiroHome.environment,
        frames: [
          // Kiro reads stored MCP OAuth tokens from the client only when it opts in.
          outbound("initialize", {
            protocolVersion: "<any>",
            info: "<any>",
            capabilities: "<any>",
            clientCapabilities: {
              fs: "<any>",
              terminal: "<any>",
              session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
              elicitation: "<any>",
              _meta: {
                kiro: {
                  hooks: { enabled: true, v2: true },
                  secretStorage: true,
                  openExternalUrl: true,
                  userInput: true,
                  approveForMeOption: true,
                },
              },
            },
            clientInfo: "<any>",
          }),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          kiroSecretRequest("_kiro/secret/get", { key: MCP_TOKENS_KEY }),
          kiroSecretResponse("_kiro/secret/get", { value: null }),
          kiroSecretRequest("_kiro/secret/get", { key: "kiro.mcp.missing.tokens" }),
          kiroSecretResponse("_kiro/secret/get", { value: null }),
          answer("session/new", sessionSetup([modeOption])),
          ...closeSession,
        ],
        drive: () => Effect.void,
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("answers Kiro's secret reads on the runtime a rollback starts", () =>
    Effect.gen(function* () {
      const kiroHome = yield* makeKiroHome({ [MCP_TOKENS_KEY]: MCP_TOKENS });
      const openFrames = [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
      ];
      yield* runKiroScript({
        scenario: "secret-get-after-rollback",
        environment: kiroHome.environment,
        // Rollback stops this runtime's process without `session/close`.
        frames: [...openFrames, answer("session/new", sessionSetup([modeOption]))],
        // The replacement `session/new` reconnects MCP servers, which reads their tokens.
        replacementFrames: [
          ...openFrames,
          kiroSecretRequest("_kiro/secret/get", { key: MCP_TOKENS_KEY }),
          kiroSecretResponse("_kiro/secret/get", { value: null }),
          answer("session/new", sessionSetup([modeOption])),
          ...closeSession,
        ],
        drive: ({ rollbackToStart }) => rollbackToStart,
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("stores and deletes Kiro secrets without mutating native credentials", () =>
    Effect.gen(function* () {
      const kiroHome = yield* makeKiroHome({ [MCP_TOKENS_KEY]: MCP_TOKENS });
      const refreshed = JSON.stringify({ access_token: "refreshed", token_type: "Bearer" });
      const otherKey = "kiro.mcp.other.tokens";
      yield* runKiroScript({
        scenario: "secret-store-delete",
        environment: kiroHome.environment,
        frames: [
          outbound("initialize"),
          answer("initialize", KIRO_V3_INITIALIZE),
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          kiroSecretRequest("_kiro/secret/store", { key: otherKey, value: refreshed }),
          kiroSecretResponse("_kiro/secret/store", { success: true }),
          kiroSecretRequest("_kiro/secret/get", { key: otherKey }),
          kiroSecretResponse("_kiro/secret/get", { value: refreshed }),
          kiroSecretRequest("_kiro/secret/delete", { key: MCP_TOKENS_KEY }),
          kiroSecretResponse("_kiro/secret/delete", { success: true }),
          kiroSecretRequest("_kiro/secret/get", { key: MCP_TOKENS_KEY }),
          kiroSecretResponse("_kiro/secret/get", { value: null }),
          answer("session/new", sessionSetup([modeOption])),
          ...closeSession,
        ],
        drive: () => Effect.void,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      assert.deepStrictEqual(
        JSON.parse(yield* fileSystem.readFileString(kiroHome.secretsPath)),
        { [MCP_TOKENS_KEY]: MCP_TOKENS },
        "Native credentials must remain unchanged",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sends a model Kiro does not list, and fails with Kiro's own message", () =>
    runKiroScript({
      scenario: "unlisted-model",
      model: "claude-opus-9",
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // Kiro has already listed its models, without the thread's custom one.
        answer(
          "session/new",
          sessionSetup([modeOption, modelOption("auto"), autopilotOption("on")]),
        ),
        // Shapes from kiro-cli 2.27.0, probed live with this id: Kiro takes
        // the write and fails the prompt.
        setConfig("model", "claude-opus-9"),
        configResult([modeOption, modelOption("claude-opus-9"), autopilotOption("on")]),
        setConfig("autopilot", "off"),
        configResult([modeOption, modelOption("claude-opus-9"), autopilotOption("off")]),
        turnPrompt,
        {
          type: "emit_inbound",
          label: "session/prompt.error",
          frame: {
            kind: "response",
            method: "session/prompt",
            error: {
              code: -32000,
              message:
                "The model 'claude-opus-9' is not available. Please select a different model and try again.",
              data: { errorType: "InvalidModelError", retryErrorType: "CLIENT_ERROR" },
            },
          },
        },
        ...closeSession,
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          const terminal = (yield* collectTurn(events)).find(
            (event) => event.type === "turn.terminal",
          );
          if (terminal?.type !== "turn.terminal" || terminal.status !== "failed") {
            return yield* Effect.die("the unavailable model must fail its turn");
          }
          assert.include(terminal.failure.message, "'claude-opus-9' is not available");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2 skills", () => {
  const userSkill = (name: string) => ({
    name,
    description: "A probe skill that checks skill discovery over ACP.",
    input: { hint: "optional context" },
    _meta: {
      kiro: {
        type: "skill",
        resource: { resourceType: "skill", source: { origin: "user" } },
        originalName: name,
      },
    },
  });
  // Shaped like kiro-cli 2.37.1's second `available_commands_update` after
  // `session/new` with `~/.kiro/skills/probe-skill/SKILL.md` installed.
  const skillCommands = update({
    sessionUpdate: "available_commands_update",
    availableCommands: [userSkill("probe-skill")],
  });

  const recordPrompts = (sent: Array<string>) =>
    ((send) => (payload, options) => {
      for (const block of payload.prompt) {
        if (block.type === "text") sent.push(block.text);
      }
      return send(payload, options);
    }) satisfies NonNullable<Parameters<typeof runKiroScript>[0]["wrapPrompt"]>;

  // The store holds the session's updates in order, so seeing `name` means every earlier one landed.
  const awaitSkill = (skills: KiroSkills, name: string) =>
    SubscriptionRef.changes(skills).pipe(
      Stream.takeUntil((current) =>
        [...current.values()].some((entries) => entries.some((skill) => skill.name === name)),
      ),
      Stream.runDrain,
    );

  // Kiro runs a command only from a leading `/name`; T3's `$` picker inserts `$name`.
  it.effect("sends a $ skill mention as the /command Kiro runs", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const skills = yield* makeKiroSkills();
      yield* runKiroScript({
        scenario: "skill-mention",
        text: "$probe-skill rest",
        skills,
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          skillCommands,
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        wrapPrompt: recordPrompts(sent),
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            yield* awaitSkill(skills, "probe-skill");
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
            assert.deepEqual(sent, ["/probe-skill rest"]);
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  // Kiro also sends updates without skills, such as a session's first, agents-only one.
  it.effect("keeps advertised skills through an update without skills", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const skills = yield* makeKiroSkills();
      yield* runKiroScript({
        scenario: "skill-mention-after-agents-update",
        text: "$probe-skill rest",
        skills,
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          skillCommands,
          update({
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "reviewer",
                description: "Reviews changes",
                _meta: { kiro: { type: "custom-agent" } },
              },
            ],
          }),
          // Changes the store after the agents-only update, so the test can see it was handled.
          update({
            sessionUpdate: "available_commands_update",
            availableCommands: [userSkill("probe-skill"), userSkill("later-skill")],
          }),
          turnPrompt,
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        wrapPrompt: recordPrompts(sent),
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            yield* awaitSkill(skills, "later-skill");
            yield* startTurn;
            assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
            assert.deepEqual(sent, ["/probe-skill rest"]);
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2 agents", () => {
  // A user agent from `~/.kiro/agents` whose config sets `"model": "claude-sonnet-4.5"`.
  const agentModeOption = (currentValue: string) => ({
    ...modeOption,
    currentValue,
    options: [...modeOption.options, option("reviewer", "reviewer")],
  });
  const agent = (value: string) => [{ id: "mode", value }];

  it.effect("selects the thread's agent before its model, which the agent would replace", () =>
    runKiroScript({
      scenario: "agent-then-model",
      model: "claude-opus-5.5",
      options: agent("reviewer"),
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        answer(
          "session/new",
          sessionSetup([agentModeOption("vibe"), kiroModelOption("auto"), autopilotOption("on")]),
        ),
        // Shapes from kiro-cli 2.27.0, probed live: switching to an agent runs
        // the agent's own model.
        setConfig("mode", "reviewer"),
        configResult([
          agentModeOption("reviewer"),
          kiroModelOption("claude-sonnet-4.5"),
          autopilotOption("on"),
        ]),
        setConfig("model", "claude-opus-5.5"),
        configResult([
          agentModeOption("reviewer"),
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("on"),
        ]),
        setConfig("autopilot", "off"),
        configResult([
          agentModeOption("reviewer"),
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        // Turn 2 picks Spec; its model is the thread's again.
        setConfig("mode", "spec"),
        configResult([
          agentModeOption("spec"),
          kiroModelOption("claude-opus-5.5"),
          autopilotOption("off"),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurnOn }) =>
        Effect.gen(function* () {
          yield* startTurnOn(1, "claude-opus-5.5", agent("reviewer"));
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
          yield* startTurnOn(2, "claude-opus-5.5", agent("spec"));
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("puts Kiro default back after an agent switch moved the session off it", () =>
    runKiroScript({
      scenario: "agent-then-default-model",
      options: agent("reviewer"),
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // A new session has not advertised `model` yet.
        answer("session/new", sessionSetup([agentModeOption("vibe"), autopilotOption("on")])),
        setConfig("mode", "reviewer"),
        configResult([
          agentModeOption("reviewer"),
          kiroModelOption("claude-sonnet-4.5"),
          autopilotOption("on"),
        ]),
        setConfig("model", "auto"),
        configResult([agentModeOption("reviewer"), kiroModelOption("auto"), autopilotOption("on")]),
        setConfig("autopilot", "off"),
        configResult([
          agentModeOption("reviewer"),
          kiroModelOption("auto"),
          autopilotOption("off"),
        ]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps the session's agent when the thread's agent no longer exists", () =>
    runKiroScript({
      scenario: "agent-removed",
      options: agent("deleted-agent"),
      frames: [
        outbound("initialize"),
        answer("initialize", KIRO_V3_INITIALIZE),
        outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
        // No `mode` write: the replay agent fails on any frame not scripted here.
        answer(
          "session/new",
          sessionSetup([agentModeOption("vibe"), kiroModelOption("auto"), autopilotOption("on")]),
        ),
        setConfig("autopilot", "off"),
        configResult([agentModeOption("vibe"), kiroModelOption("auto"), autopilotOption("off")]),
        turnPrompt,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          assert.equal(terminalStatus(yield* collectTurn(events)), "completed");
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2 early Stop", () => {
  // Stop holds its cancel until Kiro starts the prompt, for at most 2 s.
  // Replay gates hold Kiro's frames until Stop is holding; reaching a gate's
  // label means every frame before it was handled. The test clock moves only
  // where a test adjusts it, so the 2 s bound releases a cancel nowhere else.
  const kiroInfo = (label: string, kiro: Record<string, unknown>): Frame => ({
    ...update({ sessionUpdate: "session_info_update", _meta: { kiro } }),
    label,
  });
  // Shapes recorded from Kiro 2.27 (fixtures/queued_turn/kiro_transcript.ndjson).
  const messageIdEcho = kiroInfo("message-id", {
    userMessageId: "message-2",
    kind: "user_message_id_assigned",
  });
  const turnStart = kiroInfo("turn-start", {
    turnStart: true,
    kind: "turn_start",
    messageId: "message-2-turn-start",
  });
  const cancel: Frame = {
    type: "expect_outbound",
    label: "session/cancel",
    frame: { kind: "notification", method: "session/cancel", params: { sessionId: SESSION_ID } },
  };
  const cancelled = answer("session/prompt", { stopReason: "cancelled" });
  const runningProviderTurnId = (event: ProviderAdapterV2Event) =>
    event.type === "provider_turn.updated" && event.providerTurn.status === "running"
      ? event.providerTurn.id
      : undefined;

  /**
   * Runs a Kiro turn and presses Stop as soon as it runs. Once Stop holds its
   * cancel, `drive` gets the replay gate, a receipt for the cancel T3 sends,
   * and Stop's exit.
   */
  const earlyStop = (input: {
    readonly frames: ReadonlyArray<Frame>;
    readonly gates: ReadonlyArray<string>;
    readonly drive: (stop: {
      readonly replayGate: ProviderReplayGate;
      readonly cancelSent: Deferred.Deferred<void>;
      /** Completed once the cancel was written, right before Stop's acknowledgement wait. */
      readonly cancelWritten: Deferred.Deferred<void>;
      readonly stopFiber: Fiber.Fiber<Exit.Exit<void, ProviderAdapterV2Error>>;
    }) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const replayGate = makeProviderReplayGate(input.gates);
      const cancelHeld = yield* Deferred.make<void>();
      const cancelSent = yield* Deferred.make<void>();
      const cancelWritten = yield* Deferred.make<void>();
      yield* runKiroScript({
        scenario: "early-stop",
        replayGate,
        testHooks: {
          onCancelHeld: () => Deferred.succeed(cancelHeld, undefined).pipe(Effect.asVoid),
        },
        // `cancelSent` marks the decision to cancel, `cancelWritten` the write.
        wrapCancel: (send) =>
          Deferred.succeed(cancelSent, undefined).pipe(
            Effect.andThen(send),
            Effect.andThen(Deferred.succeed(cancelWritten, undefined)),
            Effect.asVoid,
          ),
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          turnPrompt,
          ...input.frames,
          ...closeSession,
        ],
        drive: ({ events, startTurn, interrupt }) =>
          Effect.gen(function* () {
            const running = yield* Deferred.make<ProviderTurnId>();
            const turn = yield* collectTurn(
              events.pipe(
                Stream.tap((event) => {
                  const providerTurnId = runningProviderTurnId(event);
                  return providerTurnId === undefined
                    ? Effect.void
                    : Deferred.succeed(running, providerTurnId);
                }),
              ),
            ).pipe(Effect.forkChild);
            yield* startTurn;
            const stop = yield* interrupt(yield* Deferred.await(running)).pipe(
              Effect.exit,
              Effect.forkChild,
            );
            yield* Deferred.await(cancelHeld);
            yield* input.drive({ replayGate, cancelSent, cancelWritten, stopFiber: stop });
            // Stop decides the run's outcome. A Stop Kiro never acknowledges leaves the
            // turn open, since Kiro may still be working, for the user to Force stop.
            if (Exit.isSuccess(yield* Fiber.join(stop))) {
              assert.equal(terminalStatus(yield* Fiber.join(turn)), "interrupted");
            } else {
              assert.isUndefined(turn.pollUnsafe());
            }
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped);

  /**
   * Lets Kiro's frames through one gate at a time. No cancel may go out
   * before the last gate's frame, and Stop must succeed.
   */
  const releaseInOrder = (input: {
    readonly frames: ReadonlyArray<Frame>;
    readonly gates: ReadonlyArray<string>;
    readonly expectCancel: boolean;
  }) =>
    earlyStop({
      frames: input.frames,
      gates: input.gates,
      drive: ({ replayGate, cancelSent, stopFiber }) =>
        Effect.gen(function* () {
          for (const [index, label] of input.gates.entries()) {
            replayGate.release(label);
            const next = input.gates[index + 1];
            if (next === undefined) continue;
            yield* Effect.promise(() => replayGate.waitForReached(next));
            assert.isFalse(
              yield* Deferred.isDone(cancelSent),
              `Stop must still hold its cancel after ${label}`,
            );
          }
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(stopFiber)));
          assert.equal(yield* Deferred.isDone(cancelSent), input.expectCancel);
        }),
    });

  it.effect("holds Stop past Kiro's message-id echo until its turn_start", () =>
    releaseInOrder({
      gates: ["message-id", "turn-start"],
      expectCancel: true,
      frames: [
        messageIdEcho,
        kiroInfo("focus", {
          focus: { status: "in_progress" },
          kind: "focus_update",
          status: "in_progress",
        }),
        turnStart,
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("does not take the previous prompt's late context usage as the start", () =>
    releaseInOrder({
      // Kiro reports the finished prompt's context usage after answering it,
      // so it can arrive once the next `session/prompt` went out.
      gates: ["previous-context-usage", "turn-start"],
      expectCancel: true,
      frames: [
        kiroInfo("previous-context-usage", {
          contextUsage: { usagePercentage: 8.8 },
          kind: "context_usage",
          usagePercentage: 8.8,
        }),
        turnStart,
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("does not take Kiro's background cloud-config fetch as the start", () =>
    releaseInOrder({
      // Kiro 2.31 fetches an Identity Center account's cloud config as a tool
      // call of its own, which can arrive once `session/prompt` went out
      // (frames reported by @hstern; the tool call id is invented).
      gates: ["cloud-config", "cloud-config-done", "turn-start"],
      expectCancel: true,
      frames: [
        {
          ...update({
            sessionUpdate: "tool_call",
            toolCallId: "tooluse_cloud_config",
            title: "Fetching your cloud config",
            kind: "other",
            status: "in_progress",
            _meta: { kiro: { toolId: "fetch_cloud_config" } },
          }),
          label: "cloud-config",
        },
        messageIdEcho,
        {
          ...update({
            sessionUpdate: "tool_call_update",
            toolCallId: "tooluse_cloud_config",
            status: "completed",
            rawOutput: { kind: "upToDate" },
          }),
          label: "cloud-config-done",
        },
        turnStart,
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("cancels on Kiro's first reply text when it sends no turn_start", () =>
    releaseInOrder({
      gates: ["message-id", "reply"],
      expectCancel: true,
      frames: [
        messageIdEcho,
        {
          ...update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "On it" },
          }),
          label: "reply",
        },
        cancel,
        cancelled,
      ],
    }),
  );

  it.effect("cancels 2 s after the prompt when Kiro shows nothing but the echo", () =>
    earlyStop({
      gates: ["message-id", "focus"],
      frames: [
        messageIdEcho,
        kiroInfo("focus", {
          focus: { status: "in_progress" },
          kind: "focus_update",
          status: "in_progress",
        }),
        cancel,
        cancelled,
      ],
      drive: ({ replayGate, cancelSent, stopFiber }) =>
        Effect.gen(function* () {
          replayGate.release("message-id");
          yield* Effect.promise(() => replayGate.waitForReached("focus"));
          yield* TestClock.adjust("1999 millis");
          assert.isFalse(yield* Deferred.isDone(cancelSent), "the echo must not release Stop");
          yield* TestClock.adjust("1 millis");
          yield* Deferred.await(cancelSent);
          // Kiro acknowledges, and Stop still has its own time to see it.
          replayGate.release("focus");
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(stopFiber)));
        }),
    }),
  );

  it.effect("fails a Stop Kiro never acknowledges after the 10 s wait and keeps the turn", () =>
    earlyStop({
      gates: [],
      // Kiro never starts the prompt and never answers it.
      frames: [messageIdEcho, cancel],
      drive: ({ cancelWritten, stopFiber }) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.await(cancelWritten);
          // The acknowledgement wait gets its full 10 s after the cancel.
          yield* TestClock.adjust("9999 millis");
          assert.isUndefined(stopFiber.pollUnsafe(), "Stop must still wait for Kiro's answer");
          yield* TestClock.adjust("1 millis");
          const error = Exit.findErrorOption(yield* Fiber.join(stopFiber));
          assert.equal(Option.getOrUndefined(error)?._tag, "ProviderAdapterInterruptTimeoutError");
        }),
    }),
  );

  it.effect("sends no cancel when Kiro finishes the prompt before starting it", () =>
    releaseInOrder({
      gates: ["session/prompt.result"],
      expectCancel: false,
      frames: [answer("session/prompt", { stopReason: "end_turn" })],
    }),
  );
});

describe("KiroAdapterV2 MCP tools", () => {
  // Probed live on Kiro 2.33.1 against a stdio MCP server named t3-code, without
  // the permission round trip. Kiro titles the call "@t3-code/html_render", names
  // it in `tool_id`, and keeps only the result's text.
  it.effect("shows T3's html_render as T3's tool with the page T3 published", () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const toolCallId = "tooluse_4N3LnlI9PRlphUtzdBQGDD";
      const args = { html: "<p>hi</p>", title: "Probe", height: 120 };
      const rawInput = { tool_id: "t3-code::html_render", arguments: args };
      const kiroMeta = { kiro: { serverName: "t3-code", toolOrigin: "default" } };
      const page = { attachmentId: "kiro-mcp-html-render-page", title: "Probe", height: 120 };
      yield* runKiroScript({
        scenario: "mcp-html-render",
        frames: [
          ...openSessionFrames({
            initialize: KIRO_V3_INITIALIZE,
            configOptions: [modeOption, autopilotOption("on")],
          }),
          turnPrompt,
          update({
            sessionUpdate: "tool_call",
            toolCallId,
            title: "@t3-code/html_render",
            kind: "other",
            status: "pending",
            rawInput,
            _meta: kiroMeta,
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            rawInput,
            _meta: kiroMeta,
          }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            title: "@t3-code/html_render",
            rawInput,
            rawOutput: { response: "Rendered.", imageBase64Urls: [], message: "Rendered." },
            content: [{ type: "content", content: { type: "text", text: "Rendered." } }],
            _meta: kiroMeta,
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          ...closeSession,
        ],
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            // T3's MCP server records the page when Kiro calls html_render.
            yield* mcpSessions.recordHtmlRender(
              ThreadId.make("thread-kiro-mcp-html-render"),
              args,
              page,
            );
            yield* startTurn;
            const turn = yield* collectTurn(events);
            const items = turn.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === toolCallId
                ? [event.turnItem]
                : [],
            );
            const completed = items.at(-1);
            assert.deepEqual(
              items.map((item) => item.toolName),
              items.map(() => "t3-code.html_render"),
            );
            assert.equal(completed?.status, "completed");
            assert.deepEqual(completed?.input, args);
            assert.deepEqual(
              completed === undefined ? undefined : htmlRenderFromToolItem(completed),
              page,
            );
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2 steering note", () => {
  // Frame shapes from the Kiro 2.33.1 recording in fixtures/kiro_message_steering.
  const kiroInfo = (kiro: Record<string, unknown>) =>
    update({ sessionUpdate: "session_info_update", _meta: { kiro } });
  const steerId = "steer-00000000-0000-4000-9000-000000000003";
  const steeringInjected = kiroInfo({
    kind: "steering_injected",
    messageId: steerId,
    content: "Answer differently",
  });
  const turnEnd = kiroInfo({
    turnEnd: { stopReason: "end_turn" },
    kind: "turn_end",
    stopReason: "end_turn",
  });
  const steeringCleared = kiroInfo({ kind: "steering_cleared", messageIds: [steerId] });
  const chunk = (text: string) =>
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const readFile = [
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-read",
      title: "Read file",
      kind: "read",
      status: "pending",
      rawInput: { path: "README.md" },
    }),
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-read",
      status: "completed",
      rawOutput: "ok",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    }),
  ];

  it.effect.each([
    {
      label: "at the end of the turn",
      reply: [chunk("Fill in the blank: x = [")],
      messages: ["Fill in the blank: x = ["],
    },
    {
      label: "before a tool call",
      reply: [chunk("Checking the list ["), ...readFile, chunk("All good.")],
      messages: ["Checking the list [", "All good."],
    },
  ])("keeps a steered reply's trailing '[' in place $label", ({ label, reply, messages }) =>
    runKiroScript({
      scenario: `steering-bracket-${label.replaceAll(" ", "-")}`,
      frames: [
        ...openSessionFrames({
          initialize: KIRO_V3_INITIALIZE,
          configOptions: [modeOption, autopilotOption("on")],
        }),
        turnPrompt,
        steeringInjected,
        ...reply,
        turnEnd,
        steeringCleared,
        answer("session/prompt", { stopReason: "end_turn" }),
        ...closeSession,
      ],
      drive: ({ events, startTurn }) =>
        Effect.gen(function* () {
          yield* startTurn;
          const texts = new Map<string, string>();
          for (const event of yield* collectTurn(events)) {
            if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
              texts.set(event.turnItem.id, event.turnItem.text);
            }
          }
          assert.deepEqual([...texts.values()], messages);
        }),
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("KiroAdapterV2 unknown model", () => {
  // Recorded live from Kiro 2.27.0 with the thread on a model id the account
  // lacks. Kiro has not advertised `model` yet, so T3 sends the id; Kiro
  // accepts it and fails the prompt with its own explanation.
  it.effect("fails the turn with Kiro's own unavailable-model message", () =>
    Effect.gen(function* () {
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/kiro_unknown_model/kiro_transcript.ndjson", import.meta.url),
      );
      const firstPromptAnswer = recorded.entries.findIndex(
        (entry) =>
          entry.type === "emit_inbound" &&
          (entry.frame as { kind?: unknown; method?: unknown }).kind === "response" &&
          (entry.frame as { method?: unknown }).method === "session/prompt",
      );
      const frames = recorded.entries.slice(0, firstPromptAnswer + 1).map((entry) => {
        const frame = entry.type === "runtime_exit" ? undefined : (entry.frame as Frame);
        return (frame?.method === "session/prompt" || frame?.method === "initialize") &&
          frame.kind === "request"
          ? { ...entry, frame: { ...frame, params: "<any>" } }
          : entry;
      });
      const sessionId = recorded.entries.flatMap((entry) => {
        const frame = entry.type === "runtime_exit" ? undefined : (entry.frame as Frame);
        const result = frame?.result as { sessionId?: unknown } | undefined;
        return frame?.method === "session/new" && typeof result?.sessionId === "string"
          ? [result.sessionId]
          : [];
      })[0];
      yield* runKiroScript({
        scenario: "unknown-model",
        model: "not-a-kiro-model",
        // As recorded: Kiro already runs on Autopilot, so T3 writes only the model.
        runtimeMode: "full-access",
        frames: [
          ...(frames as ReadonlyArray<Frame>),
          outbound("session/close", { sessionId }),
          answer("session/close", {}),
        ],
        drive: ({ events, startTurn }) =>
          Effect.gen(function* () {
            yield* startTurn;
            const turn = yield* collectTurn(events);
            const terminal = turn.find((event) => event.type === "turn.terminal");
            if (terminal?.type !== "turn.terminal" || terminal.status !== "failed") {
              return yield* Effect.die("the unknown model must fail its turn");
            }
            assert.include(terminal.failure.message, "not-a-kiro-model");
            assert.include(terminal.failure.message, "is not available");
            assert.equal(terminal.failure.code, "-32000");
          }),
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("Kiro permission policy", () => {
  const policy = (input: {
    readonly runtimeMode: RuntimeMode;
    readonly approvalPolicy?: unknown;
    readonly sandboxPolicy?: unknown;
  }) =>
    ProviderAdapterV2RuntimePolicy.make({
      interactionMode: "default",
      cwd: "/workspace",
      ...input,
    });

  it("keeps Autopilot on only for an unrestricted Full access thread", () => {
    assert.equal(kiroAutopilotValue(policy({ runtimeMode: "full-access" })), "on");
    assert.equal(kiroAutopilotValue(policy({ runtimeMode: "approval-required" })), "off");
    // An explicit override restricts Full access, so Kiro's review stays on.
    assert.equal(
      kiroAutopilotValue(policy({ runtimeMode: "full-access", approvalPolicy: "on-request" })),
      "off",
    );
    assert.equal(
      kiroAutopilotValue(
        policy({ runtimeMode: "full-access", sandboxPolicy: { type: "readOnly" } }),
      ),
      "off",
    );
  });

  const writeRequest = (
    options: EffectAcpSchema.RequestPermissionRequest["options"],
  ): EffectAcpSchema.RequestPermissionRequest => ({
    sessionId: "session-1",
    toolCall: { toolCallId: "call-1", title: "Write File", kind: "edit" },
    options,
  });

  it("never lets a policy approval persist Kiro's workspace-wide allow_always", () => {
    const fullAccess = policy({ runtimeMode: "full-access" });
    assert.equal(
      kiroPermissionDisposition(
        policy({ runtimeMode: "auto" }),
        writeRequest([{ optionId: "accept", name: "Allow", kind: "allow_once" }]),
      ),
      "ask",
    );
    assert.equal(
      kiroPermissionDisposition(
        fullAccess,
        writeRequest([
          { optionId: "accept", name: "Allow", kind: "allow_once" },
          { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
        ]),
      ),
      "allow",
    );
    // With no one-time choice, approving would save a rule beyond the thread,
    // so the request goes to the user, whose card can still allow it.
    const alwaysOnly = writeRequest([
      { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Deny", kind: "reject_once" },
    ]);
    assert.equal(kiroPermissionDisposition(fullAccess, alwaysOnly), "ask");
    assert.deepEqual(
      kiroApprovalOptions(alwaysOnly).map((option) => option.decision),
      ["acceptForSession", "decline", "cancel"],
    );
  });
});
