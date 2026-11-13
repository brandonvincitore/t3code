import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Operations from "@t3tools/provider-core/server/textGenerationOperations";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { kiroContentCollectionConfig, makeKiroAcpRuntime } from "./acpSupport.ts";
import type { KiroSettings } from "../settings.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

const encodeTitleAgent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeModels = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          model_id: Schema.String,
          rate_multiplier: Schema.optional(Schema.Number),
          rate_unit: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** Cost and availability come from this account, never a catalog or the session default. */
export function cheapestKiroTitleModel(stdout: string): string | undefined {
  const list = Option.getOrUndefined(decodeModels(stdout));
  return list?.models
    .filter(
      (model) =>
        model.model_id !== "auto" &&
        model.model_id !== "default" &&
        model.model_id.trim() === model.model_id &&
        model.model_id.length > 0 &&
        model.model_id.length <= 256 &&
        model.rate_unit === "Credit" &&
        model.rate_multiplier !== undefined &&
        Number.isFinite(model.rate_multiplier) &&
        model.rate_multiplier >= 0,
    )
    .sort(
      (left, right) =>
        left.rate_multiplier! - right.rate_multiplier! ||
        left.model_id.localeCompare(right.model_id),
    )[0]?.model_id;
}

export const makeKiroTextGeneration = Effect.fn("KiroTextGeneration.make")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* SecureRandom.SecureRandom;
  const run: Operations.Runner = Effect.fn("KiroTextGeneration.run")(
    function* (input) {
      const fail = (detail: string) =>
        new TextGenerationError({ operation: input.operation, detail });
      if (!settings.enabled || input.operation !== "generateThreadTitle")
        return yield* fail("Kiro application text generation supports thread titles only.");
      if (environment.ASBX_KIRO_MANDATORY_MCPS?.trim() || environment.KIRO_MANDATORY_MCPS?.trim())
        return yield* fail(
          "Kiro requires tools in this environment. Automatic titles are unavailable.",
        );
      if (input.prompt.length > 32_000)
        return yield* fail("Kiro title input exceeds the size limit.");
      const command = settings.binaryPath || "kiro-cli";
      const spawn = yield* resolveSpawnCommand(
        command,
        ["chat", "--list-models", "--format", "json"],
        { env: { ...environment, KIRO_TRUST_CLASSIFIER_MODE: "off" } },
      );
      const listed = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawn.command, spawn.args, {
          env: { ...environment, KIRO_TRUST_CLASSIFIER_MODE: "off" },
          shell: spawn.shell,
        }),
      );
      const model = listed.code === 0 ? cheapestKiroTitleModel(listed.stdout) : undefined;
      if (model === undefined)
        return yield* fail("Kiro did not advertise an available model with credit pricing.");
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-title-" });
      const config = path.join(root, "config");
      const cwd = path.join(root, "workspace");
      yield* fs.makeDirectory(path.join(config, "agents"), { recursive: true });
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(
        path.join(config, "agents", "t3-title.json"),
        yield* encodeTitleAgent({
          name: "t3-title",
          tools: [],
          resources: [],
          hooks: [],
          mcpServers: {},
          includeMcpJson: false,
          includePowers: false,
          model,
        }),
      );
      let text = "";
      let outputSize = 0;
      let violation = false;
      const runtime = yield* makeKiroAcpRuntime({
        settings: { ...settings, memoryMode: "disabled" },
        cwd,
        environment: {
          ...environment,
          KIRO_HOME: config,
          KIRO_DISABLE_SESSION_TITLE_LLM: "true",
          KIRO_DISABLE_EXPERIMENT_CONFIG: "true",
          KIRO_FEATURE_MODEL_FALLBACK_REFUSAL_ENABLED: "false",
          KIRO_FEATURE_MODEL_FALLBACK_AVAILABILITY_ENABLED: "false",
          KIRO_FEATURE_MODEL_FALLBACK_AUTO_REFUSAL_ENABLED: "false",
        },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-code-title", version: "0.0.0" },
        transformSessionUpdate: (notification) => {
          const update = notification.update;
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk"
          ) {
            if (update.content.type === "text") {
              outputSize += update.content.text.length;
              if (outputSize > 8_192) violation = true;
              else if (update.sessionUpdate === "agent_message_chunk") text += update.content.text;
            }
          } else if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          )
            violation = true;
          if (violation) throw fail("Kiro title generation exceeded its output or tool limits.");
          return notification;
        },
      });
      const initialized = yield* runtime.initialize();
      if (initialized.agentCapabilities?.sessionCapabilities?.delete == null)
        return yield* fail("Kiro cannot clean up temporary title sessions.");
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const started = yield* runtime.start();
      yield* Effect.addFinalizer(() =>
        runtime.deleteSession(started.sessionId).pipe(Effect.timeout("5 seconds"), Effect.ignore),
      );
      yield* runtime.setMode("t3-title");
      yield* runtime.setModel(model);
      for (const { id, value } of kiroContentCollectionConfig(
        settings,
        yield* runtime.getConfigOptions,
      ))
        yield* runtime.setConfigOption(id, value);
      const reply = yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
      if (reply.stopReason !== "end_turn" || violation)
        return yield* fail("Kiro title generation did not complete.");
      return yield* Operations.decodeJsonReply(input, "Kiro", text);
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Kiro title generation timed out.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Kiro title generation failed.",
                cause,
              }),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
      ),
  );
  return Operations.fromRunner("KiroTextGeneration", run) satisfies ProviderTextGeneration;
});
