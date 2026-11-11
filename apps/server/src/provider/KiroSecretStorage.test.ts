import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as NodeUtil from "node:util";

import { makeKiroSecretStorage } from "../../../../packages/provider-kiro/src/server/secretStorage.ts";

const layer = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));

describe("makeKiroSecretStorage", () => {
  it.effect(
    "isolates owners and homes, preserves concurrent keys and never imports native values",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-owned-" });
        const native = path.join(root, "secrets.json");
        const original = JSON.stringify({ tokens: "native-only", unrelated: "native-owned" });
        yield* fs.writeFileString(native, original);
        const environment = { KIRO_HOME: ` ${root}/nested/.. ` };
        const a = yield* makeKiroSecretStorage(environment, "one");
        assert.deepStrictEqual(yield* a.get("tokens"), { value: null });
        const b = yield* makeKiroSecretStorage({ KIRO_HOME: root }, "one");
        yield* Effect.all(
          [
            a.store("tokens", "registered-verifier-discovery-tokens"),
            b.store("__proto__", "other"),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(yield* b.get("tokens"), {
          value: "registered-verifier-discovery-tokens",
        });
        assert.deepStrictEqual(yield* a.get("__proto__"), { value: "other" });
        const otherOwner = yield* makeKiroSecretStorage(environment, "two");
        const otherHome = yield* makeKiroSecretStorage({ KIRO_HOME: `${root}/other` }, "one");
        assert.deepStrictEqual(yield* otherOwner.get("tokens"), { value: null });
        assert.deepStrictEqual(yield* otherHome.get("tokens"), { value: null });
        yield* b.store("tokens", "refreshed");
        assert.deepStrictEqual(yield* a.get("tokens"), { value: "refreshed" });
        yield* a.remove("tokens");
        const restarted = yield* makeKiroSecretStorage(environment, "one");
        assert.deepStrictEqual(yield* restarted.get("tokens"), { value: null });
        assert.strictEqual(yield* fs.readFileString(native), original);
        yield* fs.writeFileString(native, JSON.stringify({ tokens: "native-new" }));
        assert.deepStrictEqual(yield* restarted.get("tokens"), { value: null });
        assert.deepStrictEqual(yield* restarted.get("__proto__"), { value: "other" });
        const fallback = yield* makeKiroSecretStorage({ KIRO_HOME: "relative", HOME: root }, "one");
        const absolute = yield* makeKiroSecretStorage(
          { KIRO_HOME: path.join(root, ".kiro") },
          "one",
        );
        yield* fallback.store("tokens", "fallback-home");
        assert.deepStrictEqual(yield* absolute.get("tokens"), { value: "fallback-home" });
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("keeps decode failures private in ACP errors and traces", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const storage = yield* makeKiroSecretStorage(
        { KIRO_HOME: "/synthetic-private-home" },
        "one",
      ).pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          credentials: () =>
            Effect.succeed({
              binding: { owner: "t3", key: "opaque" },
              get: Effect.succeedSome(new Uint8Array([255])),
              set: () => Effect.void,
              remove: Effect.void,
            }),
        }),
      );
      const failure = yield* storage
        .get("synthetic-private-key")
        .pipe(Effect.flip, Effect.withTracer(tracer));
      assert.strictEqual(failure.message, "Kiro secret storage decode failed");
      assert.isUndefined(failure.cause);
      assert.isUndefined(failure.data);
      assert.notInclude(NodeUtil.inspect([failure, spans], { depth: null }), "synthetic-private");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("persists separate records across store reconstruction and durable deletion", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const secrets = yield* ServerSecretStore.make;
      const make = (environment: NodeJS.ProcessEnv) =>
        makeKiroSecretStorage(environment, "one").pipe(
          Effect.provideService(ProviderHost.ProviderHost, {
            ...host,
            credentials: (namespace, binding) =>
              ProviderCredentialStore.make(namespace, binding).pipe(
                Effect.map((record) => ({
                  binding: record.binding,
                  get: record.get.pipe(
                    Effect.mapError(
                      (cause) => new ProviderCredentialError({ operation: "get", cause }),
                    ),
                  ),
                  set: (bytes: Uint8Array) =>
                    record
                      .set(bytes)
                      .pipe(
                        Effect.mapError(
                          (cause) => new ProviderCredentialError({ operation: "set", cause }),
                        ),
                      ),
                  remove: record.remove.pipe(
                    Effect.mapError(
                      (cause) => new ProviderCredentialError({ operation: "remove", cause }),
                    ),
                  ),
                })),
                Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
              ),
          }),
        );
      const a = yield* make({ KIRO_HOME: "/synthetic-home" });
      yield* Effect.all([a.store("registration", "client"), a.store("tokens", "grant")], {
        concurrency: "unbounded",
      });
      const b = yield* make({ KIRO_HOME: "/synthetic-home" });
      assert.deepStrictEqual(yield* b.get("registration"), { value: "client" });
      assert.deepStrictEqual(yield* b.get("tokens"), { value: "grant" });
      yield* b.store("tokens", "refresh");
      assert.deepStrictEqual(yield* a.get("tokens"), { value: "refresh" });
      yield* a.remove("tokens");
      const c = yield* make({ KIRO_HOME: "/synthetic-home" });
      assert.deepStrictEqual(yield* c.get("tokens"), { value: null });
      assert.deepStrictEqual(yield* c.get("registration"), { value: "client" });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-kiro-persist-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect(
    "does not acknowledge failed host reads, writes or removals and redacts their causes",
    () =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        const failure = (operation: "get" | "set" | "remove") =>
          Effect.fail(
            new ProviderCredentialError({
              operation,
              cause: new Error("synthetic-private-payload"),
            }),
          );
        const storage = yield* makeKiroSecretStorage({}, "one").pipe(
          Effect.provideService(ProviderHost.ProviderHost, {
            ...host,
            credentials: () =>
              Effect.succeed({
                binding: { owner: "t3", key: "opaque" },
                get: failure("get"),
                set: () => failure("set"),
                remove: failure("remove"),
              }),
          }),
        );
        for (const [operation, category] of [
          [storage.get("key").pipe(Effect.asVoid), "read"],
          [storage.store("key", "value").pipe(Effect.asVoid), "write"],
          [storage.remove("key").pipe(Effect.asVoid), "remove"],
        ] as const) {
          const error = yield* operation.pipe(Effect.flip);
          assert.strictEqual(error.message, `Kiro secret storage ${category} failed`);
          assert.notInclude(NodeUtil.inspect(error, { depth: null }), "synthetic-private-payload");
          assert.isUndefined(error.cause);
          assert.isUndefined(error.data);
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("native writers cannot overwrite a pending T3 store or revive a deleted record", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-race-" });
      const native = path.join(root, "secrets.json");
      yield* fs.writeFileString(native, JSON.stringify({ old: "native" }));
      for (const operation of ["set", "remove"] as const) {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root }, "one").pipe(
          Effect.provideService(ProviderHost.ProviderHost, {
            ...host,
            credentials: (namespace, binding) =>
              host.credentials(namespace, binding).pipe(
                Effect.map((record) => ({
                  ...record,
                  set: (bytes: Uint8Array) =>
                    operation === "set"
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(record.set(bytes)),
                        )
                      : record.set(bytes),
                  remove:
                    operation === "remove"
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(record.remove),
                        )
                      : record.remove,
                })),
              ),
          }),
        );
        const pending = yield* (
          operation === "set" ? storage.store("tokens", "owned") : storage.remove("tokens")
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const nativeBytes = JSON.stringify({
          old: "native",
          unrelated: operation,
          tokens: "native-only",
        });
        yield* fs.writeFileString(native, nativeBytes);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
        assert.strictEqual(yield* fs.readFileString(native), nativeBytes);
        assert.deepStrictEqual(yield* storage.get("tokens"), {
          value: operation === "set" ? "owned" : null,
        });
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
