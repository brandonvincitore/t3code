import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { KiroDriver } from "@t3tools/provider-kiro/server";
import { KiroSettings } from "@t3tools/provider-kiro/settings";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  checkKiroProviderStatus,
  kiroAgentDescriptor,
  kiroDefaultModelId,
} from "@t3tools/provider-kiro/testing";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

interface CliOutput {
  readonly stdout: string;
  readonly code: number;
  /** Holds stdout and the exit back this long, like a CLI slow to answer. */
  readonly delay?: Duration.Input;
}

function processHandle(output: CliOutput) {
  const answered = Effect.sleep(output.delay ?? 0);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_002),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(output.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(
      Effect.as(
        answered,
        output.stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(output.stdout)),
      ),
    ),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const KIRO_ACP_ARGS = "acp --agent-engine=v3 --auth-method=cli";
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Number]),
      method: Schema.String,
      params: Schema.optional(Schema.Unknown),
    }),
  ),
);
const KIRO_SESSION_ID = "sess_kiro-skills";
const KIRO_EXTENSION_METHODS = [
  "_kiro/config/template",
  "_kiro/workflow/new",
  "_kiro/workflow/cancel",
];

/**
 * A `kiro-cli acp` that answers `initialize` and `_kiro/config/template` and
 * fails anything else, so a probe that opened a session would fail. Given
 * `afterSessionNew`, it also opens sessions, sends those updates right after
 * `session/new`, and answers each prompt with one line of text.
 */
const acpProcess = (
  template: unknown,
  templateParams: Array<unknown>,
  extensionMethods: ReadonlyArray<string>,
  afterSessionNew?: ReadonlyArray<unknown>,
  requests: Array<string> = [],
  workspaceState?: () => {
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
  },
) =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const terminate = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
      Effect.andThen(Queue.shutdown(output)),
      Effect.asVoid,
    );
    let pending = "";
    const send = (message: object) =>
      Queue.offer(output, encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
    const sessionUpdate = (update: unknown) =>
      send({
        method: "session/update",
        params: { sessionId: KIRO_SESSION_ID, update },
      });
    const reply = Effect.fnUntraced(function* (line: string) {
      const request = decodeRequest(line);
      requests.push(request.method);
      const sessions = afterSessionNew !== undefined;
      if (sessions && request.method === "session/new") {
        yield* send({ id: request.id, result: { sessionId: KIRO_SESSION_ID } });
        yield* Effect.forEach(afterSessionNew, sessionUpdate);
        return;
      }
      if (sessions && request.method === "session/prompt") {
        yield* sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        });
        yield* send({ id: request.id, result: { stopReason: "end_turn" } });
        return;
      }
      const response =
        request.method === "initialize"
          ? {
              result: {
                protocolVersion: 1,
                agentCapabilities: { _meta: { kiro: { extensionMethods } } },
                authMethods: [],
              },
            }
          : request.method === "_kiro/configuration/getState" && workspaceState !== undefined
            ? workspaceState()
            : request.method === "_kiro/config/template"
              ? (templateParams.push(request.params), { result: template })
              : { error: { code: -32601, message: `${request.method} is not scripted` } };
      yield* send({ id: request.id, ...response });
    });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(900_000_003),
      exitCode: Deferred.await(exited),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
      kill: () => terminate,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((bytes: Uint8Array) => {
        // A prompt can arrive split across writes.
        const lines = (pending + new TextDecoder().decode(bytes)).split("\n");
        pending = lines.pop() ?? "";
        return Effect.forEach(
          lines.filter((line) => line.trim().length > 0),
          reply,
        );
      }),
      stdout: Stream.fromQueue(output),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  });

/** Answers `kiro-cli` invocations by their arguments and records which ran. */
function kiroCli(
  outputs: Record<string, CliOutput>,
  template?: unknown,
  afterSessionNew?: ReadonlyArray<unknown>,
  extensionMethods: ReadonlyArray<string> = KIRO_EXTENSION_METHODS,
  workspaceState?: (cwd: string | undefined) => {
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
  },
) {
  const invoked: Array<string> = [];
  const environments: Array<ChildProcess.CommandOptions["env"]> = [];
  const templateParams: Array<unknown> = [];
  const requests: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
    invoked.push(args);
    environments.push(ChildProcess.isStandardCommand(command) ? command.options.env : undefined);
    return args === KIRO_ACP_ARGS && (template !== undefined || afterSessionNew !== undefined)
      ? acpProcess(
          template,
          templateParams,
          extensionMethods,
          afterSessionNew,
          requests,
          workspaceState === undefined
            ? undefined
            : () =>
                workspaceState(
                  ChildProcess.isStandardCommand(command) ? command.options.cwd : undefined,
                ),
        )
      : Effect.succeed(processHandle(outputs[args] ?? { stdout: "", code: 127 }));
  });
  return { invoked, environments, templateParams, requests, spawner };
}

const check = (
  outputs: Record<string, CliOutput>,
  options: {
    readonly template?: unknown;
    readonly environment?: NodeJS.ProcessEnv;
    readonly settings?: KiroSettings;
    readonly extensionMethods?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const cli = kiroCli(outputs, options.template, undefined, options.extensionMethods);
    const snapshot = yield* checkKiroProviderStatus(
      options.settings ?? settings,
      options.environment ?? {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner));
    return {
      snapshot,
      invoked: cli.invoked,
      environments: cli.environments,
      templateParams: cli.templateParams,
      requests: cli.requests,
    };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("KiroProvider", () => {
  it.effect.each([
    {
      label: "answers after 6 s",
      delay: "6 seconds",
      status: "ready",
      version: "2.27.0",
      message: undefined,
    },
    {
      label: "never answers",
      delay: "Infinity",
      status: "error",
      version: null,
      message: "Failed to run `kiro-cli --version`.",
    },
  ] as const)("gives `kiro-cli --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const fiber = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0, delay: row.delay },
        "whoami --format json": { stdout: '{"accountType":"ApiKey","email":null}\n', code: 0 },
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const { snapshot } = yield* Fiber.join(fiber);
      assert.equal(snapshot.status, row.status);
      assert.equal(snapshot.version, row.version);
      assert.equal(snapshot.message, row.message);
    }),
  );

  it.effect("reports a CLI whose version probe exits nonzero as failing to run", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 1 },
      });
      assert.equal(snapshot.status, "error");
      assert.isTrue(snapshot.installed);
      assert.equal(snapshot.message, "Kiro CLI is installed but failed to run.");
      assert.isNull(snapshot.version);
      // A broken CLI is not asked for its sign-in.
      assert.deepEqual(invoked, ["--version"]);
    }),
  );

  // `whoami` outputs recorded from Kiro CLI 2.27.0.
  it.effect("asks for kiro-cli login when Kiro is signed out", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"account":null}\n', code: 1 },
      });
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "2.27.0");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "kiro-cli login");
    }),
  );

  it.effect("is ready once Kiro reports a signed-in account", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"ApiKey","email":null}\n', code: 0 },
      });
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      // The version advisory is what the compatibility check and update UI read.
      assert.equal(snapshot.versionAdvisory?.currentVersion, "2.27.0");
      assert.isFalse(snapshot.versionAdvisory?.canUpdate);
    }),
  );

  // Shape of `kiro-cli chat --list-models --format json` on Kiro CLI 2.27.0, trimmed to three models.
  const KIRO_MODEL_LIST = JSON.stringify({
    models: [
      { model_name: "auto", model_id: "auto", description: "Models chosen by task" },
      { model_name: "claude-sonnet-4.5", model_id: "claude-sonnet-4.5" },
      { model_name: "claude-haiku-4.5", model_id: "claude-haiku-4.5" },
    ],
    default_model: "auto",
  });

  it.effect("lists the signed-in account's models with auto as the Kiro default", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": { stdout: `${KIRO_MODEL_LIST}\n`, code: 0 },
      });
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.name, model.isDefault === true]),
        [
          ["default", "auto", true],
          ["claude-sonnet-4.5", "Claude Sonnet 4.5", false],
          ["claude-haiku-4.5", "Claude Haiku 4.5", false],
        ],
      );
    }),
  );

  it.effect("names Kiro default after the model Kiro's list names as its default", () =>
    Effect.gen(function* () {
      const signedIn = {
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
      };
      const listed = yield* check({
        ...signedIn,
        "chat --list-models --format json": {
          stdout: KIRO_MODEL_LIST.replace(
            '"default_model":"auto"',
            '"default_model":"claude-sonnet-4.5"',
          ),
          code: 0,
        },
      });
      assert.deepEqual(
        listed.snapshot.models.map((model) => [model.slug, model.name]),
        [
          ["auto", "auto"],
          ["default", "Claude Sonnet 4.5"],
          ["claude-haiku-4.5", "Claude Haiku 4.5"],
        ],
      );
      assert.equal(kiroDefaultModelId(listed.snapshot.models), "claude-sonnet-4.5");
      // An unparsable list keeps the built-in entry, which falls back to `auto`.
      const unlisted = yield* check({
        ...signedIn,
        "chat --list-models --format json": { stdout: "not json\n", code: 0 },
      });
      assert.equal(unlisted.snapshot.models[0]?.name, "Kiro default");
      assert.equal(kiroDefaultModelId(unlisted.snapshot.models), "auto");
    }),
  );

  it.effect("lists Kiro default even when Kiro's model list leaves its default out", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
        "chat --list-models --format json": {
          stdout: JSON.stringify({ models: [{ model_id: "claude-sonnet-4.5" }] }),
          code: 0,
        },
      });
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.name, model.isDefault === true]),
        [
          ["default", "Kiro default", true],
          ["claude-sonnet-4.5", "Claude Sonnet 4.5", false],
        ],
      );
      assert.equal(kiroDefaultModelId(snapshot.models), "auto");
    }),
  );

  // `--list-models` names no effort levels, so the picker's come from Kiro's ids.
  const KIRO_EFFORT_MODEL_LIST = JSON.stringify({
    models: [
      "auto",
      "claude-fable-5.1",
      "claude-opus-5.5",
      "claude-haiku-5.5",
      "claude-opus-4.6",
      "kimi-k3",
      "claude-sonnet-4.5",
    ].map((id) => ({
      model_name: id,
      model_id: id,
    })),
    default_model: "auto",
  });

  it.effect.each(["auto", "claude-opus-5.5"])(
    "offers static reasoning fallback with default %s",
    (defaultId) =>
      Effect.gen(function* () {
        const { snapshot } = yield* check({
          "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
          "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
          "chat --list-models --format json": {
            stdout: KIRO_EFFORT_MODEL_LIST.replace(
              '"default_model":"auto"',
              JSON.stringify("default_model") + ":" + JSON.stringify(defaultId),
            ),
            code: 0,
          },
        });
        const reasoning = snapshot.models.map((model) => {
          const descriptors = model.capabilities?.optionDescriptors ?? [];
          const reflection = descriptors.find((descriptor) => descriptor.id === "memoryReflection");
          assert.equal(reflection?.type, "select");
          assert.isUndefined(reflection?.currentValue);
          const select = descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
          return select?.type === "select"
            ? {
                slug: model.slug,
                label: select.label,
                levels: select.options.map((choice) => choice.id),
                defaults: select.options.filter((choice) => choice.isDefault).map((c) => c.id),
                currentValue: select.currentValue,
              }
            : {
                slug: model.slug,
                descriptors: descriptors.filter((descriptor) => descriptor.id === "reasoningEffort")
                  .length,
              };
        });
        const expected = [
          // Auto and models without effort get no Reasoning select.
          { slug: "default", descriptors: 0 },
          {
            slug: "claude-fable-5.1",
            label: "Reasoning",
            levels: ["low", "medium", "high", "xhigh", "max"],
            defaults: ["high"],
            currentValue: "high",
          },
          {
            slug: "claude-opus-5.5",
            label: "Reasoning",
            levels: ["low", "medium", "high", "xhigh", "max"],
            defaults: ["medium"],
            currentValue: "medium",
          },
          {
            slug: "claude-haiku-5.5",
            label: "Reasoning",
            levels: ["low", "medium", "high", "xhigh", "max"],
            defaults: ["medium"],
            currentValue: "medium",
          },
          // Opus 4.6 has no xhigh, and Kiro runs it at high by default.
          {
            slug: "claude-opus-4.6",
            label: "Reasoning",
            levels: ["low", "medium", "high", "max"],
            defaults: ["high"],
            currentValue: "high",
          },
          // Kimi K3 skips medium and runs at max by default.
          {
            slug: "kimi-k3",
            label: "Reasoning",
            levels: ["low", "high", "max"],
            defaults: ["max"],
            currentValue: "max",
          },
          { slug: "claude-sonnet-4.5", descriptors: 0 },
        ];
        assert.deepEqual(
          reasoning,
          expected.map((model) => ({
            ...model,
            slug:
              model.slug === "default"
                ? defaultId === "auto"
                  ? "default"
                  : "auto"
                : model.slug === defaultId
                  ? "default"
                  : model.slug,
          })),
        );
      }),
  );

  it.effect.each(["claude-sonnet-5.5", "future-model"])(
    "uses session-free model metadata before the first chat with default %s",
    (defaultId) =>
      Effect.gen(function* () {
        const choices = [
          { value: "default", name: "Internal default" },
          { value: "auto", name: "Auto", _meta: { kiro: { hasEffort: false } } },
          { value: "claude-sonnet-5.5", name: "claude-sonnet-5.5" },
          { value: "claude-haiku-5.5", name: "claude-haiku-5.5" },
          {
            value: "future-model",
            name: "Future model",
            _meta: {
              kiro: {
                hasEffort: true,
                effortLevels: ["medium", "extreme", "medium", "default"],
                defaultEffortLevel: "extreme",
              },
            },
          },
          {
            value: "gpt-6.1-sol",
            name: "gpt-6.1-sol",
            _meta: {
              kiro: {
                hasEffort: true,
                effortLevels: ["low", "high"],
                defaultEffortLevel: "high",
              },
            },
          },
          { value: "kimi-k3", name: "Kimi K3 Premium", _meta: { kiro: { hasEffort: false } } },
          { value: "unknown-custom", name: "My custom model" },
          {
            value: "claude-opus-4.6",
            name: "claude-opus-4.6",
            _meta: {
              kiro: { hasEffort: true, effortLevels: ["default"], defaultEffortLevel: "default" },
            },
          },
          { value: "deepseek-3.2", name: "deepseek-3.2" },
          { value: "minimax-m2.5", name: "minimax-m2.5" },

          {
            value: "claude-opus-5.5",
            name: "claude-opus-5.5",
            _meta: {
              kiro: {
                hasEffort: true,
                effortLevels: [],
                defaultEffortLevel: "broken",
              },
            },
          },
        ];
        const { snapshot, requests } = yield* check(
          {
            "--version": { stdout: "kiro-cli 3.1.0\n", code: 0 },
            "whoami --format json": { stdout: '{"accountType":"ApiKey"}', code: 0 },
            "chat --list-models --format json": {
              stdout: JSON.stringify({
                models: choices
                  .filter((choice) => choice.value !== "default")
                  .map((choice) => ({
                    model_id: choice.value,
                    model_name: choice.value === "future-model" ? choice.value : choice.name,
                  })),
                default_model: defaultId,
              }),
              code: 0,
            },
          },
          {
            template: {
              configOptions: [
                {
                  id: "model",
                  type: "select",
                  category: "model",
                  currentValue: "auto",
                  options: choices,
                },
              ],
            },
          },
        );
        const resolve = (id: string) =>
          snapshot.models.find((model) => model.slug === id || model.aliases?.includes(id));
        const levels = (id: string) => {
          const option = resolve(id)?.capabilities?.optionDescriptors?.find(
            (option) => option.id === "reasoningEffort",
          );
          return option?.type === "select" ? option.options.map((choice) => choice.id) : [];
        };
        assert.deepEqual(levels("claude-sonnet-5.5"), ["low", "medium", "high", "xhigh", "max"]);
        assert.deepEqual(levels("future-model"), ["medium", "extreme"]);
        assert.deepEqual(levels("gpt-6.1-sol"), ["low", "high"]);
        assert.deepEqual(levels("claude-opus-5.5"), ["low", "medium", "high", "xhigh", "max"]);
        assert.deepEqual(levels("kimi-k3"), []);
        assert.deepEqual(levels("unknown-custom"), []);
        assert.deepEqual(levels("claude-opus-4.6"), []);
        assert.equal(resolve("deepseek-3.2")?.name, "DeepSeek 3.2");
        assert.equal(resolve("minimax-m2.5")?.name, "MiniMax M2.5");
        assert.deepEqual(levels("auto"), []);
        assert.equal(resolve("claude-sonnet-5.5")?.name, "Claude Sonnet 5.5");
        assert.equal(resolve("claude-haiku-5.5")?.name, "Claude Haiku 5.5");
        assert.equal(resolve("gpt-6.1-sol")?.name, "GPT-6.1-Sol");
        assert.equal(resolve("future-model")?.name, "Future model");
        assert.equal(resolve("kimi-k3")?.name, "Kimi K3 Premium");
        assert.equal(resolve("unknown-custom")?.name, "My custom model");
        assert.deepEqual(resolve(defaultId)?.aliases, [defaultId]);
        assert.equal(snapshot.models.filter((model) => model.slug === "default").length, 1);
        assert.deepEqual(requests, ["initialize", "_kiro/config/template"]);
      }),
  );

  it.effect("gives every model, custom ones too, the agent picker Kiro's template lists", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check(
        {
          "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
          "whoami --format json": { stdout: '{"accountType":"SocialGitHub"}\n', code: 0 },
          "chat --list-models --format json": { stdout: KIRO_MODEL_LIST, code: 0 },
        },
        {
          template: {
            configOptions: [
              {
                type: "select",
                id: "mode",
                name: "Mode",
                currentValue: "vibe",
                options: [
                  { value: "vibe", name: "Default" },
                  { value: "reviewer", name: "reviewer" },
                ],
              },
            ],
          },
          settings: { ...settings, customModels: ["my-model"] },
        },
      );
      assert.deepEqual(
        snapshot.models.map((model) => [
          model.slug,
          model.capabilities?.optionDescriptors?.flatMap((descriptor) =>
            descriptor.type === "select" && descriptor.id === "mode"
              ? descriptor.options.map((choice) => choice.id)
              : [],
          ),
        ]),
        [
          ["default", ["vibe", "reviewer"]],
          ["claude-sonnet-4.5", ["vibe", "reviewer"]],
          ["claude-haiku-4.5", ["vibe", "reviewer"]],
          ["my-model", ["vibe", "reviewer"]],
        ],
      );
    }),
  );

  it.effect("advertises Kiro's actual workflow launch preference with its native default", () =>
    Effect.gen(function* () {
      const workflowOptions = [
        { value: "when-asked", name: "When asked" },
        { value: "large-tasks", name: "Large tasks only" },
        { value: "delegate-all", name: "Delegate all work" },
      ];
      const environment = Object.freeze({
        MISE_OFFLINE: "0",
        KIRO_PROBE_FIXTURE: "kept",
        KIRO_TRUST_CLASSIFIER_MODE: "enforce",
      });
      const { snapshot, templateParams, environments } = yield* check(
        {
          "--version": { stdout: "kiro-cli 2.32.0\n", code: 0 },
          "whoami --format json": { stdout: '{"accountType":"ApiKey"}\n', code: 0 },
        },
        {
          environment,
          template: {
            configOptions: [
              {
                type: "select",
                id: "workflowLaunch",
                name: "Workflow use",
                currentValue: "when-asked",
                options: workflowOptions,
              },
            ],
          },
        },
      );
      assert.isTrue(environments.length >= 3);
      for (const probeEnvironment of environments) {
        assert.deepEqual(probeEnvironment, {
          ...environment,
          MISE_OFFLINE: "1",
          KIRO_TRUST_CLASSIFIER_MODE: "off",
        });
      }
      assert.equal(environment.MISE_OFFLINE, "0");
      assert.deepEqual(templateParams, [
        { _meta: { kiro: { settings: { workflows: { enabled: true } } } } },
      ]);
      const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "workflowLaunch",
      );
      assert.deepEqual(descriptor, {
        id: "workflowLaunch",
        label: "Workflow use",
        type: "select",
        currentValue: "when-asked",
        options: [
          { id: "when-asked", label: "When asked", isDefault: true },
          { id: "large-tasks", label: "Large tasks only" },
          { id: "delegate-all", label: "Delegate all work" },
        ],
      });
    }),
  );

  it.effect(
    "does not request or advertise workflow preferences without a template capability",
    () =>
      Effect.gen(function* () {
        const { snapshot, templateParams } = yield* check(
          {
            "--version": { stdout: "kiro-cli 2.32.0\n", code: 0 },
            "whoami --format json": { stdout: '{"accountType":"ApiKey"}\n', code: 0 },
          },
          {
            template: {
              configOptions: [
                {
                  type: "select",
                  id: "workflowLaunch",
                  name: "Workflow use",
                  currentValue: "when-asked",
                  options: [
                    { value: "when-asked", name: "When asked" },
                    { value: "delegate-all", name: "Delegate all work" },
                  ],
                },
              ],
            },
            extensionMethods: ["_kiro/workflow/new", "_kiro/workflow/cancel"],
          },
        );
        assert.deepEqual(templateParams, []);
        assert.isUndefined(
          snapshot.models[0]?.capabilities?.optionDescriptors?.find(
            (option) => option.id === "workflowLaunch",
          ),
        );
      }),
  );

  it("offers Kiro's agents from its config template, Default first", () => {
    // `_kiro/config/template` from kiro-cli 2.27.0 with two user agents in
    // `~/.kiro/agents`, trimmed to three bundled agents and the `mode` option.
    const template = {
      modes: { currentModeId: "vibe", availableModes: [] },
      configOptions: [
        {
          type: "select",
          id: "mode",
          name: "Mode",
          category: "mode",
          currentValue: "vibe",
          options: [
            { value: "vibe", name: "Default", description: "General coding assistance" },
            { value: "spec", name: "Spec", description: "Structured feature development" },
            { value: "plan", name: "Plan", description: "Plan-only mode" },
            { value: "global-probe", name: "global-probe", description: "Global probe agent" },
            { value: "planner", name: "planner", description: null },
          ],
        },
        {
          type: "select",
          id: "autopilot",
          name: "Autopilot",
          currentValue: "on",
          options: [{ value: "on", name: "Autopilot" }],
        },
      ],
    };
    const descriptor = kiroAgentDescriptor(template);
    assert.deepEqual(descriptor, {
      id: "mode",
      label: "Agent",
      type: "select",
      currentValue: "vibe",
      options: [
        { id: "vibe", label: "Default", description: "General coding assistance" },
        { id: "spec", label: "Spec", description: "Structured feature development" },
        { id: "plan", label: "Plan", description: "Plan-only mode" },
        { id: "global-probe", label: "global-probe", description: "Global probe agent" },
        { id: "planner", label: "planner" },
      ],
    });
    const onSpec = kiroAgentDescriptor({
      configOptions: [{ ...template.configOptions[0], currentValue: "spec" }],
    });
    assert.equal(onSpec?.type === "select" ? onSpec.currentValue : undefined, "spec");
    const onVibe = kiroAgentDescriptor(template);
    assert.deepEqual(
      onSpec?.type === "select" ? onSpec.options : [],
      onVibe?.type === "select" ? onVibe.options : [],
    );
    // A template without agents to choose between gives no picker.
    assert.isUndefined(kiroAgentDescriptor({ configOptions: [] }));
    assert.isUndefined(kiroAgentDescriptor("not a template"));
  });

  it.effect("never lists models while signed out, where listing would start a browser login", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({
        "--version": { stdout: "kiro-cli 2.27.0\n", code: 0 },
        "whoami --format json": { stdout: '{"account":null}\n', code: 1 },
        "chat --list-models --format json": { stdout: `${KIRO_MODEL_LIST}\n`, code: 0 },
      });
      assert.notInclude(invoked, "chat --list-models --format json");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }),
  );

  // Shaped like kiro-cli 2.37.1's second `available_commands_update` after
  // `session/new` with `~/.kiro/skills/probe-skill/SKILL.md` installed.
  it.effect("scopes session advertisements under native workspace resource authority", () =>
    Effect.gen(function* () {
      const agent = {
        id: "mode",
        name: "Agent",
        type: "select",
        category: "mode",
        currentValue: "cached-agent",
        options: [
          { value: "cached-agent", name: "Cached agent" },
          { value: "native-agent", name: "Native agent" },
        ],
      };
      const model = {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "future-model",
        options: [
          {
            value: "future-model",
            name: "Native future model",
            _meta: {
              kiro: {
                hasEffort: true,
                effortLevels: ["medium", "high"],
                defaultEffortLevel: "medium",
              },
            },
          },
        ],
      };
      const resources = (allowed: ReadonlyArray<string>) => ({
        resources: [
          {
            type: "agent",
            items: ["cached-agent", "native-agent"].map((id) => ({
              layer: "workspace",
              standing: { kind: allowed.includes(id) ? "active" : "blocked" },
              value: { id, name: id },
            })),
          },
        ],
      });
      let state: {
        readonly result?: unknown;
        readonly error?: { readonly code: number; readonly message: string };
      } = { result: {} };
      const methods = [...KIRO_EXTENSION_METHODS, "_kiro/configuration/getState"];
      const cli = kiroCli(
        {
          "--version": { stdout: "kiro-cli 2.37.1\n", code: 0 },
          "whoami --format json": { stdout: '{"accountType":"ApiKey"}\n', code: 0 },
          "chat --list-models --format json": {
            stdout: JSON.stringify({
              models: [{ model_id: "auto", model_name: "Auto" }],
              default_model: "auto",
            }),
            code: 0,
          },
        },
        { configOptions: [agent] },
        [
          {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "probe-skill",
                description: "A probe skill that checks skill discovery over ACP.",
                input: { hint: "optional context" },
                _meta: {
                  kiro: {
                    type: "skill",
                    resource: { resourceType: "skill", source: { origin: "user" } },
                    originalName: "probe-skill",
                  },
                },
              },
            ],
          },
          {
            sessionUpdate: "config_option_update",
            configOptions: [
              agent,
              {
                id: "memoryReflection",
                name: "Memory reflection",
                type: "select",
                currentValue: "off",
                options: [],
              },
              model,
              {
                id: "effortLevel",
                name: "Effort",
                type: "select",
                category: "thought_level",
                currentValue: "high",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ],
          },
        ],
        methods,
        (cwd) => (cwd === "/other-workspace" ? { result: { resources: [] } } : state),
      );
      yield* Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("kiro");
        const instance = yield* KiroDriver.create({
          instanceId,
          displayName: "Kiro",
          accentColor: undefined,
          enabled: true,
          environment: [],
          config: settings,
        });
        yield* instance.snapshot.refresh;
        const prechat = yield* instance.snapshotForCwd!("/workspace");
        assert.equal(
          prechat.models[0]?.capabilities?.optionDescriptors?.find((option) => option.id === "mode")
            ?.currentValue,
          "cached-agent",
        );
        const threadId = ThreadId.make("thread-kiro-skills");
        const modelSelection = { instanceId, model: "future-model" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const session = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-kiro-skills"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-kiro-skills"),
            title: "Kiro skills",
            providerInstanceId: instanceId,
            modelSelection,
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
          runId: RunId.make("run-kiro-skills"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-kiro-skills"),
          rootNodeId: NodeId.make("node-kiro-skills"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-kiro-skills"),
            text: "Say hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshotForCwd!("/workspace");
        const mode = (snapshot: ProviderWorkspaceSnapshot) =>
          snapshot.optionDescriptors?.find((option) => option.id === "mode");
        const choices = (snapshot: ProviderWorkspaceSnapshot) => {
          const agent = mode(snapshot);
          return agent?.type === "select" ? agent.options.map((option) => option.id) : [];
        };
        const assertNativeModel = (snapshot: ProviderWorkspaceSnapshot) => {
          const native = snapshot.models.find((model) => model.slug === "future-model");
          assert.equal(native?.name, "Native future model");
          assert.equal(
            native?.capabilities?.optionDescriptors?.find(
              (option) => option.id === "reasoningEffort",
            )?.currentValue,
            "high",
          );
          for (const model of snapshot.models) {
            assert.deepEqual(
              model.capabilities?.optionDescriptors?.find((option) => option.id === "mode"),
              mode(snapshot),
            );
          }
        };
        for (const descriptors of [
          snapshot.optionDescriptors,
          ...snapshot.models.map((entry) => entry.capabilities?.optionDescriptors),
          ...(snapshot.workspaceModels ?? []).map((entry) => entry.capabilities?.optionDescriptors),
        ]) {
          const reflection = descriptors?.find((option) => option.id === "memoryReflection");
          assert.equal(reflection?.type, "select");
          assert.deepEqual(reflection?.type === "select" ? reflection.options : undefined, []);
        }
        assert.deepEqual(choices(snapshot), ["cached-agent", "native-agent"]);
        assertNativeModel(snapshot);
        for (const result of [
          { resources: [] },
          resources([]),
          resources(["native-agent"]),
          resources(["cached-agent", "native-agent"]),
        ]) {
          state = { result };
          yield* TestClock.adjust("5 seconds");
          const scoped = yield* instance.snapshotForCwd!("/workspace");
          const allowed = result.resources.flatMap((resource) =>
            resource.items
              .filter((item) => item.standing.kind === "active")
              .map((item) => item.value.id),
          );
          assert.deepEqual(choices(scoped), allowed);
          assert.equal(
            mode(scoped)?.currentValue,
            allowed.includes("cached-agent") ? "cached-agent" : undefined,
          );
          assertNativeModel(scoped);
          const other = yield* instance.snapshotForCwd!("/other-workspace");
          assert.deepEqual(choices(other), []);
          assert.isUndefined(other.models.find((model) => model.slug === "future-model"));
        }
        for (const fallback of [
          { result: {} },
          { error: { code: -32601, message: "unsupported" } },
          { error: { code: -32603, message: "failed probe" } },
        ]) {
          state = fallback;
          yield* TestClock.adjust("5 seconds");
          const scoped = yield* instance.snapshotForCwd!("/workspace");
          assert.deepEqual(choices(scoped), ["cached-agent", "native-agent"]);
          assertNativeModel(scoped);
        }
        methods.pop();
        yield* TestClock.adjust("5 seconds");
        const unsupported = yield* instance.snapshotForCwd!("/workspace");
        assert.deepEqual(choices(unsupported), ["cached-agent", "native-agent"]);
        assertNativeModel(unsupported);
        assert.deepEqual(
          snapshot.skills.map(({ name, enabled }) => ({ name, enabled })),
          [{ name: "probe-skill", enabled: true }],
        );
        assert.deepEqual((yield* instance.snapshot.getSnapshot).skills, []);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
        Effect.scoped,
      );
    }).pipe(
      Effect.provide(
        TestProviderHost.layer().pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(IdAllocator.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
      ),
    ),
  );
});
