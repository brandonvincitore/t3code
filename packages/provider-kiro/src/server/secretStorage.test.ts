import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as NodeUtil from "node:util";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { makeKiroSecretStorage } from "./secretStorage.ts";

describe("makeKiroSecretStorage", () => {
  it.effect("keeps every key when two sessions store at once, in a new 0600 file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const environment = { KIRO_HOME: ` ${path.join(root, "missing", "kiro")} ` };
      const sessions = [
        yield* makeKiroSecretStorage(environment),
        yield* makeKiroSecretStorage(environment),
      ];
      assert.deepStrictEqual(yield* sessions[0]!.get("missing"), { value: null });
      const keys = Array.from({ length: 20 }, (_, index) => `kiro.mcp.${index}.tokens`);
      yield* Effect.forEach(
        keys,
        (key, index) => sessions[index % 2]!.store(key, `{"n":${index}}`),
        { concurrency: "unbounded", discard: true },
      );

      const secretsPath = path.join(root, "missing", "kiro", "secrets.json");
      const stored = JSON.parse(yield* fileSystem.readFileString(secretsPath));
      assert.deepStrictEqual(Object.keys(stored).toSorted(), keys.toSorted());
      // Windows reports every writable file as 0666.
      if ((yield* HostProcess.Platform) !== "win32") {
        assert.strictEqual((yield* fileSystem.stat(secretsPath)).mode & 0o777, 0o600);
      }
      assert.deepStrictEqual(yield* sessions[1]!.get(keys[3]!), { value: '{"n":3}' });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps the stored sign-ins when a write fails partway", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const secretsPath = path.join(root, "secrets.json");
      const original = JSON.stringify({ "kiro.mcp.a.tokens": "A" }, null, 2);
      yield* fileSystem.writeFileString(secretsPath, original);
      // Writes half the text and then fails, like a full disk.
      const failingWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (target, text, options) =>
          fileSystem.writeFileString(target, text.slice(0, text.length / 2), options).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: target,
                }),
              ),
            ),
          ),
      });
      const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingWrites),
      );

      assert.isTrue(Exit.isFailure(yield* Effect.exit(storage.store("kiro.mcp.b.tokens", "B"))));
      assert.strictEqual(yield* fileSystem.readFileString(secretsPath), original);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(root), ["secrets.json"]);
      assert.deepStrictEqual(yield* storage.get("kiro.mcp.a.tokens"), { value: "A" });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps cleanup failures non-fatal and private after successful and failed writes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const secretsPath = path.join(root, "secrets.json");
      const key = "synthetic-secret-key";
      const value = "synthetic-secret-value";
      const cleanupCause = "synthetic-cleanup-cause";
      const logs: Array<unknown> = [];
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      let failWrite = false;
      let cleanupAttempts = 0;
      const failingCleanup = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (target, text, options) =>
          fileSystem.writeFileString(target, text, options).pipe(
            Effect.andThen(() =>
              failWrite
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "writeFileString",
                      pathOrDescriptor: target,
                      cause: new Error(`${key}:${value}`),
                    }),
                  )
                : Effect.void,
            ),
          ),
        remove: (target) =>
          Effect.sync(() => {
            cleanupAttempts += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                  cause: new Error(`${cleanupCause}:${key}:${value}`),
                }),
              ),
            ),
          ),
      });
      const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingCleanup),
      );
      yield* Effect.gen(function* () {
        assert.deepStrictEqual(yield* storage.store(key, value), { success: true });
        const stored = yield* fileSystem.readFileString(secretsPath);
        assert.deepStrictEqual(JSON.parse(stored), { [key]: value });
        failWrite = true;
        const failure = yield* storage.store("synthetic-other-key", value).pipe(Effect.flip);
        assert.strictEqual(failure.message, "Kiro secret storage write failed");
        assert.isUndefined(failure.cause);
        assert.isUndefined(failure.data);
        assert.strictEqual(yield* fileSystem.readFileString(secretsPath), stored);
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(
          Logger.layer(
            [
              Logger.make(({ logLevel, message, cause }) => {
                logs.push({ logLevel, message, cause: Cause.squash(cause) });
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
      assert.strictEqual(cleanupAttempts, 2);
      const recorded = NodeUtil.inspect(
        [
          logs,
          spans.map(({ name, attributes, events, status }) => ({
            name,
            attributes,
            events,
            failure:
              status._tag === "Ended" && Exit.isFailure(status.exit)
                ? status.exit.cause
                : undefined,
          })),
        ],
        { depth: null },
      );
      for (const sentinel of [root, key, value, cleanupCause]) {
        assert.isFalse(recorded.includes(sentinel));
      }
      assert.strictEqual(logs.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("leaves a secrets file it cannot decode untouched", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const secretsPath = path.join(root, "secrets.json");
      const sentinel = "sensitive-sentinel";
      const original = JSON.stringify({ [sentinel]: sentinel, other: { nested: sentinel } });
      yield* fileSystem.writeFileString(secretsPath, original);
      const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root });

      const spans: Array<Tracer.NativeSpan> = [];
      const logs: Array<unknown> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const failures = yield* Effect.all([
        storage.get(sentinel).pipe(Effect.flip),
        storage.store(sentinel, sentinel).pipe(Effect.flip),
        storage.remove(sentinel).pipe(Effect.flip),
      ]).pipe(
        Effect.withTracer(tracer),
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(entry.message);
            }),
          ]),
        ),
      );
      for (const failure of failures) {
        assert.strictEqual(failure._tag, "AcpRequestError");
        assert.strictEqual(failure.message, "Kiro secret storage decode failed");
        assert.isUndefined(failure.cause);
        assert.isUndefined(failure.data);
      }
      const recorded = NodeUtil.inspect(
        [
          failures,
          logs,
          spans.map(({ name, attributes, events, status }) => ({
            name,
            attributes,
            events,
            status,
          })),
        ],
        { depth: null },
      );
      assert.notInclude(recorded, sentinel);
      assert.notInclude(recorded, secretsPath);
      assert.deepStrictEqual(logs, []);
      assert.strictEqual(yield* fileSystem.readFileString(secretsPath), original);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("distinguishes missing secrets from sanitized filesystem failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-secrets-" });
      const secretsPath = path.join(root, "secrets.json");
      const original = JSON.stringify({ present: "unchanged" });
      yield* fileSystem.writeFileString(secretsPath, original);
      const logs: Array<unknown> = [];
      yield* Effect.gen(function* () {
        const storage = yield* makeKiroSecretStorage({ KIRO_HOME: root });
        assert.deepStrictEqual(yield* storage.get("missing"), { value: null });
        assert.deepStrictEqual(yield* storage.get("present"), { value: "unchanged" });
        for (const tag of ["PermissionDenied", "Unknown", "NotFound"] as const) {
          const failingReads = FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: tag,
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: secretsPath,
                  cause: new Error("sensitive-sentinel"),
                }),
              ),
          });
          const failing = yield* makeKiroSecretStorage({ KIRO_HOME: root }).pipe(
            Effect.provideService(FileSystem.FileSystem, failingReads),
          );
          if (tag === "NotFound") {
            assert.deepStrictEqual(yield* failing.get("missing"), { value: null });
          } else {
            const failure = yield* failing.get("sensitive-sentinel").pipe(Effect.flip);
            assert.strictEqual(failure.message, "Kiro secret storage read failed");
            assert.isUndefined(failure.cause);
            assert.isUndefined(failure.data);
            assert.notInclude(NodeUtil.inspect(failure, { depth: null }), "sensitive-sentinel");
            assert.notInclude(NodeUtil.inspect(failure, { depth: null }), secretsPath);
          }
        }
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(entry.message);
            }),
          ]),
        ),
      );
      assert.deepStrictEqual(logs, []);
      assert.strictEqual(yield* fileSystem.readFileString(secretsPath), original);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
