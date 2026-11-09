import {
  KiroMemoryCreate,
  KiroMemoryCreateResult,
  KiroMemoryDeleteResult,
  KiroMemoryError,
  KiroMemoryGetResult,
  KiroMemoryListOptions,
  KiroMemoryListResult,
  KiroMemorySyncStatus,
  KiroMemoryUpdate,
  KiroMemoryUpdateResult,
  type KiroMemoryController,
} from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpErrors from "effect-acp/errors";

import type { KiroSettings } from "../settings.ts";
import { makeKiroAcpRuntime } from "./acpSupport.ts";

type Runtime = Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "initialize" | "request">;
const decodeMethods = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }),
  }),
);
const Identity = Schema.Struct({ id: KiroMemoryUpdate.fields.id });

export const makeKiroMemoryController = Effect.fn("KiroMemory.make")(function* (options: {
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly makeRuntime?: (cwd: string) => Effect.Effect<Runtime, AcpErrors.AcpError, Scope.Scope>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const makeRuntime =
    options.makeRuntime ??
    ((cwd: string) =>
      makeKiroAcpRuntime({
        settings: options.settings,
        environment: options.environment,
        cwd,
        authenticateOnAuthRequired: false,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-code-memory", version: "0.0.0" },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, random),
      ));

  const validate = Effect.fn("KiroMemory.validate")(function* <A, I>(
    schema: Schema.Codec<A, I>,
    input: unknown,
  ) {
    return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(() => new KiroMemoryError({ code: "invalid_input" })),
    );
  });

  const request = Effect.fn("KiroMemory.request")(
    function* <A, I>(cwd: string, method: string, input: unknown, output: Schema.Codec<A, I>) {
      if (!options.settings.enabled)
        return yield* new KiroMemoryError({ code: "provider_unavailable" });
      const runtime = yield* makeRuntime(cwd).pipe(
        Effect.mapError(() => new KiroMemoryError({ code: "operation_failed" })),
      );
      const initialized = yield* runtime
        .initialize()
        .pipe(Effect.mapError(() => new KiroMemoryError({ code: "operation_failed" })));
      const methods =
        Option.getOrUndefined(decodeMethods(initialized.agentCapabilities?._meta))?.kiro
          .extensionMethods ?? [];
      if (!methods.includes(method)) return yield* new KiroMemoryError({ code: "unsupported" });
      const result = yield* runtime
        .request(method, input)
        .pipe(Effect.mapError(() => new KiroMemoryError({ code: "operation_failed" })));
      return yield* Schema.decodeUnknownEffect(output)(result).pipe(
        Effect.mapError(() => new KiroMemoryError({ code: "invalid_response" })),
      );
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new KiroMemoryError({ code: "operation_failed" })),
    }),
  );

  const list: KiroMemoryController["list"] = Effect.fn("KiroMemory.list")(function* ({
    cwd,
    ...input
  }) {
    const validated = yield* validate(KiroMemoryListOptions, input);
    return yield* request(
      cwd,
      "_kiro/memory/list",
      { ...validated, limit: validated.limit ?? 50 },
      KiroMemoryListResult,
    );
  });
  const get: KiroMemoryController["get"] = Effect.fn("KiroMemory.get")(function* ({
    cwd,
    ...input
  }) {
    const validated = yield* validate(Identity, input);
    const result = yield* request(cwd, "_kiro/memory/get", validated, KiroMemoryGetResult);
    if (result.memory.id !== validated.id)
      return yield* new KiroMemoryError({ code: "invalid_response" });
    return result;
  });
  const create: KiroMemoryController["create"] = Effect.fn("KiroMemory.create")(function* ({
    cwd,
    ...input
  }) {
    const validated = yield* validate(KiroMemoryCreate, input);
    return yield* request(cwd, "_kiro/memory/create", validated, KiroMemoryCreateResult);
  });
  const update: KiroMemoryController["update"] = Effect.fn("KiroMemory.update")(function* ({
    cwd,
    ...input
  }) {
    const validated = yield* validate(KiroMemoryUpdate, input);
    if (!Object.entries(validated).some(([key, value]) => key !== "id" && value !== undefined))
      return yield* new KiroMemoryError({ code: "invalid_input" });
    const result = yield* request(cwd, "_kiro/memory/update", validated, KiroMemoryUpdateResult);
    if (result.memory && result.memory.id !== validated.id)
      return yield* new KiroMemoryError({ code: "invalid_response" });
    return result;
  });
  const remove: KiroMemoryController["delete"] = Effect.fn("KiroMemory.delete")(function* ({
    cwd,
    ...input
  }) {
    const validated = yield* validate(Identity, input);
    const result = yield* request(cwd, "_kiro/memory/delete", validated, KiroMemoryDeleteResult);
    if (result.id !== validated.id) return yield* new KiroMemoryError({ code: "invalid_response" });
    return result;
  });
  const getSyncStatus: KiroMemoryController["getSyncStatus"] = Effect.fn(
    "KiroMemory.getSyncStatus",
  )(function ({ cwd }) {
    return request(cwd, "_kiro/memory/getSyncStatus", {}, KiroMemorySyncStatus);
  });
  const sync: KiroMemoryController["sync"] = Effect.fn("KiroMemory.sync")(function ({ cwd }) {
    return request(cwd, "_kiro/memory/sync", {}, KiroMemorySyncStatus);
  });

  return {
    list,
    get,
    create,
    update,
    delete: remove,
    getSyncStatus,
    sync,
  } satisfies KiroMemoryController;
});
