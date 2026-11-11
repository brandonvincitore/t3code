import {
  KiroPowersError,
  type KiroPowersController,
  type KiroPowersState,
} from "@t3tools/contracts";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import type { KiroSettings } from "../settings.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeKiroAcpRuntime } from "./acpSupport.ts";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
const decodeMethods = Schema.decodeUnknownOption(
  Schema.Struct({ kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }) }),
);
const decodePower = Schema.decodeUnknownOption(
  Schema.Struct({
    layer: Schema.String,
    standing: Schema.Struct({ kind: Schema.String }),
    value: Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
  }),
);
const decodeState = Schema.decodeUnknownOption(
  Schema.Struct({
    resources: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        compose: Schema.optional(Schema.String),
        assertions: Schema.optional(
          Schema.Array(Schema.Struct({ compose: Schema.optional(Schema.String) })),
        ),
        items: Schema.Array(Schema.Unknown),
      }),
    ),
  }),
);

export const makeKiroPowers = Effect.fn("KiroPowers.make")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
  onChanged: Effect.Effect<void>,
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* SecureRandom.SecureRandom;
  const mutations = yield* Semaphore.make(1);
  const list = Effect.fn("KiroPowers.list")(
    function* (cwd: string) {
      if (!settings.enabled) return yield* new KiroPowersError({ code: "unavailable" });
      const runtime = yield* makeKiroAcpRuntime({
        settings,
        environment,
        cwd,
        authenticateOnAuthRequired: false,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-code-powers", version: "0.0.0" },
      });
      const initialized = yield* runtime.initialize();
      const methods = Option.getOrUndefined(decodeMethods(initialized.agentCapabilities?._meta))
        ?.kiro.extensionMethods;
      if (!methods?.includes("_kiro/configuration/getState"))
        return yield* new KiroPowersError({ code: "unsupported" });
      const result = yield* runtime.request("_kiro/configuration/getState", {
        observer: "workspace",
        roots: [cwd],
      });
      const state = Option.getOrUndefined(decodeState(result));
      if (state === undefined) return yield* new KiroPowersError({ code: "unsupported" });
      const groups = state.resources.filter((resource) => resource.type === "power");
      const managed = groups.some(
        (group) =>
          group.compose === "locked" ||
          group.assertions?.some((assertion) => assertion.compose === "locked"),
      );
      const powers: Array<KiroPowersState["powers"][number]> = [];
      const seen = new Set<string>();
      for (const group of groups)
        for (const candidate of group.items) {
          const item = Option.getOrUndefined(decodePower(candidate));
          if (item === undefined) continue;
          const name = item.value.name;
          if (
            item.standing.kind !== "active" ||
            !NAME.test(name) ||
            name.length > 128 ||
            seen.has(name) ||
            powers.length >= 256
          )
            continue;
          seen.add(name);
          powers.push({
            name,
            description: item.value.description?.trim().slice(0, 2_048) ?? "",
            scope: item.layer.slice(0, 128),
            canRemove: !managed && item.layer === "user-local",
          });
        }
      return { reported: true, canInstall: !managed, powers };
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new KiroPowersError({ code: "operation_failed" })),
        }),
        Effect.mapError((cause) =>
          cause._tag === "KiroPowersError"
            ? cause
            : new KiroPowersError({ code: "operation_failed", cause }),
        ),
      ),
  );
  const run = Effect.fn("KiroPowers.run")(
    function* (operation: "install" | "uninstall", cwd: string, target: string) {
      const child = yield* spawner.spawn(
        ChildProcess.make(settings.binaryPath || "kiro-cli", ["powers", operation, "--", target], {
          cwd,
          env: { ...environment, KIRO_TRUST_CLASSIFIER_MODE: "off" },
          shell: false,
        }),
      );
      const [exitCode] = yield* Effect.all(
        [
          child.exitCode,
          collectStreamAsString(child.stdout, { maxBytes: 16_384 }),
          collectStreamAsString(child.stderr, { maxBytes: 16_384 }),
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) return yield* new KiroPowersError({ code: "operation_failed" });
      yield* onChanged;
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "60 seconds",
          orElse: () => Effect.fail(new KiroPowersError({ code: "operation_failed" })),
        }),
        Effect.mapError((cause) =>
          cause._tag === "KiroPowersError"
            ? cause
            : new KiroPowersError({ code: "operation_failed", cause }),
        ),
      ),
  );
  const install = Effect.fn("KiroPowers.install")(
    function* ({ cwd, target }: { readonly cwd: string; readonly target: string }) {
      if (
        !target ||
        target !== target.trim() ||
        target.length > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(target) ||
        (!path.isAbsolute(target) && !NAME.test(target)) ||
        target.startsWith("//")
      )
        return yield* new KiroPowersError({ code: "invalid_target" });
      if (!(yield* list(cwd)).canInstall) return yield* new KiroPowersError({ code: "managed" });
      yield* run("install", cwd, target);
    },
    (effect) => mutations.withPermit(effect),
  );
  const remove = Effect.fn("KiroPowers.remove")(
    function* ({ cwd, name }: { readonly cwd: string; readonly name: string }) {
      if (!NAME.test(name) || name.length > 128)
        return yield* new KiroPowersError({ code: "invalid_target" });
      const state = yield* list(cwd);
      const power = state.powers.find((power) => power.name === name);
      if (!power?.canRemove) return yield* new KiroPowersError({ code: "managed" });
      yield* run("uninstall", cwd, name);
    },
    (effect) => mutations.withPermit(effect),
  );
  return { list, install, remove } satisfies KiroPowersController;
});
