import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { makeKiroNativeTitles, initializeKiroThreadTitle } from "@t3tools/provider-kiro/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpErrors from "effect-acp/errors";
import { makeTurnInput } from "../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownRecord = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeTitle = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);
const renameParams = Schema.decodeUnknownSync(
  Schema.Struct({
    sessionId: Schema.String,
    title: Schema.String,
    sessionSource: Schema.Literal("local"),
  }),
);
const fixture = Effect.fn("test.nativeTitles.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-titles-" });
  const cwd = `${root}/workspace`;
  const nativeHome = `${root}/native`;
  yield* fs.makeDirectory(cwd);
  const bucket = Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(cwd)),
  ).slice(0, 16);
  const sessionId = "native-session";
  const recordPath = `${nativeHome}/sessions/${bucket}/${sessionId}/session.json`;
  const now = DateTime.makeUnsafe("2026-11-13T00:00:00.000Z");
  const instanceId = ProviderInstanceId.make("kiro-test");
  const threadId = ThreadId.make(`thread-${root.split("/").at(-1)}`);
  const providerThread = OrchestrationV2ProviderThread.make({
    id: ProviderThreadId.make("provider-thread-test"),
    driver: ProviderDriverKind.make("kiro"),
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("runtime-test"),
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("kiro"),
      nativeId: sessionId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const turn = makeTurnInput({
    threadId,
    providerThread,
    instanceId,
    runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd },
    now,
  });
  let record = {
    schemaVersion: "1.0.0",
    id: sessionId,
    title: "New Session",
    workspacePaths: [cwd],
    createdAt: DateTime.formatIso(now),
    lastModifiedAt: DateTime.formatIso(now),
    titleSetByUser: false,
  };
  const write = () => writeFileStringAtomically({ filePath: recordPath, contents: encode(record) });
  yield* write();
  let renames = 0;
  let succeed = true;
  let duringRename: (title: string) => Effect.Effect<void, AcpErrors.AcpError> = () => Effect.void;
  const runtime = {
    request: (_method: string, params: unknown) =>
      Effect.gen(function* () {
        assert.equal(_method, "_kiro/session/rename");
        const input = renameParams(params);
        assert.equal(input.sessionId, sessionId);
        renames += 1;
        if (!succeed) return { success: false };
        record = { ...record, title: input.title, titleSetByUser: true };
        yield* write();
        yield* duringRename(input.title);
        return { success: true };
      }),
  } as unknown as Parameters<typeof initializeKiroThreadTitle>[0]["runtime"];
  const session = {
    sessionId,
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { _meta: { kiro: { extensionMethods: ["_kiro/session/rename"] } } },
    },
    sessionSetupResult: { sessionId, _meta: { ...record, source: "local" } },
    modelConfigId: undefined,
  };
  const bind = (support: Effect.Success<ReturnType<typeof makeKiroNativeTitles>>) =>
    support.bindRuntime(runtime, { HOME: `${root}/user`, KIRO_HOME: nativeHome }, cwd);
  let receiptWrite: Effect.Effect<void> = Effect.void;
  const support = yield* makeKiroNativeTitles(instanceId).pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      writeFileString: (...args) =>
        args[0].includes("/kiro-native-title-v1/")
          ? receiptWrite.pipe(Effect.andThen(fs.writeFileString(...args)))
          : fs.writeFileString(...args),
    }),
  );
  const host = yield* ProviderHost.ProviderHost;
  const receiptDirectory = `${host.paths.stateDir}/kiro-native-title-v1`;
  const observe = (title: string, target = support) =>
    target.observe({ runtime, providerThread, title });
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  yield* bind(support).pipe(Scope.provide(scope));
  const initialize = support.initialize({ runtime, session, turn, observedTitle: undefined });
  const sync = (
    title: string,
    options: { current?: boolean; manual?: boolean; nativeId?: string } = {},
    target = support,
  ) =>
    target.synchronize({
      runtime,
      session: { ...session, sessionId: options.nativeId ?? sessionId },
      appThread: { ...turn.appThread, title, titleManuallySet: options.manual ?? false },
      providerThread,
      isCurrent: Effect.succeed(options.current ?? true),
    });
  const title = fs.readFileString(recordPath).pipe(
    Effect.flatMap(decodeTitle),
    Effect.map((record) => record.title),
  );
  const external = (title: string) =>
    Effect.sync(() => {
      record = { ...record, title, titleSetByUser: true };
    }).pipe(Effect.andThen(write));
  return {
    fs,
    root,
    recordPath,
    turn,
    scope,
    bind,
    initialize,
    sync,
    title,
    external,
    observe,
    receiptDirectory,
    setReceiptWrite: (effect: Effect.Effect<void>) => {
      receiptWrite = effect;
    },
    onRename: (callback: typeof duringRename) => {
      duringRename = callback;
    },
    renames: () => renames,
    setSuccess: (value: boolean) => {
      succeed = value;
    },
  };
});

it.effect(
  "forwards generated titles from a durable receipt and permanently retires observed native divergence",
  () =>
    Effect.gen(function* () {
      for (const divergence of ["disk", "live", "aba"]) {
        const h = yield* fixture();
        h.onRename((title) => h.observe(title));
        yield* h.initialize;
        assert.equal(yield* h.title, h.turn.appThread.title);
        yield* h.sync("Generated title");
        assert.equal(yield* h.title, "Generated title");
        yield* h.sync("Manual T3 title", { manual: true });
        assert.equal(yield* h.title, "Generated title");
        assert.equal(h.renames(), 2);
        const restarted = yield* makeKiroNativeTitles(h.turn.providerThread.providerInstanceId);
        yield* h.bind(restarted);
        yield* Scope.close(h.scope, Exit.void);
        yield* h.observe("Late old-runtime manual title");
        yield* h.observe("Generated title", restarted);
        h.onRename((title) => h.observe(title, restarted));
        yield* h.sync("Later generated title", {}, restarted);
        assert.equal(yield* h.title, "Later generated title");
        if (divergence === "disk") yield* h.external("Manual native title");
        else {
          const persisted = yield* h.fs.readFileString(h.recordPath);
          if (divergence === "live") yield* h.fs.remove(h.recordPath);
          yield* h.observe("Manual native title", restarted);
          if (divergence === "live") yield* h.fs.writeFileString(h.recordPath, persisted);
          if (divergence === "aba") yield* h.observe("Later generated title", restarted);
        }
        yield* h.sync("Must stay in T3", {}, restarted);
        assert.equal(
          yield* h.title,
          divergence === "disk" ? "Manual native title" : "Later generated title",
        );
        yield* h.external("Later generated title");
        const reconstructed = yield* makeKiroNativeTitles(h.turn.providerThread.providerInstanceId);
        yield* h.bind(reconstructed);
        yield* h.sync("Still must stay in T3", {}, reconstructed);
        assert.equal(yield* h.title, "Later generated title");
        assert.equal(h.renames(), 3);
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "skips unknown ownership, stale work, failed writes, unsafe metadata and closed runtimes",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* h.sync("No receipt");
      assert.equal(h.renames(), 0);
      yield* h.initialize;
      yield* h.sync("Stale job", { current: false });
      yield* h.sync("Unsafe native id", { nativeId: "../native-session" });
      const original = yield* h.fs.readFileString(h.recordPath);
      const valid = yield* decodeUnknownRecord(original);
      for (const invalid of [
        { ...valid, id: "another-session" },
        { ...valid, workspacePaths: [h.root] },
        { ...valid, parentSessionId: "parent" },
        { ...valid, createdAt: "invalid" },
      ]) {
        yield* h.fs.writeFileString(h.recordPath, encode(invalid));
        yield* h.sync("Invalid metadata must skip");
      }
      yield* h.fs.writeFileString(h.recordPath, "invalid-json");
      yield* h.sync("Malformed metadata must skip");
      yield* h.fs.writeFileString(h.recordPath, original);

      yield* h.fs.rename(h.recordPath, `${h.recordPath}.real`);
      yield* h.fs.symlink(`${h.recordPath}.real`, h.recordPath);
      yield* h.sync("Symlink must skip");
      yield* h.fs.remove(h.recordPath);
      yield* h.fs.rename(`${h.recordPath}.real`, h.recordPath);
      assert.equal(h.renames(), 1);
      h.setSuccess(false);
      yield* h.sync("Rejected native write");
      assert.equal(yield* h.title, h.turn.appThread.title);
      h.setSuccess(true);
      yield* h.sync("Retry confirmed");
      assert.equal(yield* h.title, "Retry confirmed");
      yield* Scope.close(h.scope, Exit.void);
      yield* h.sync("Closed runtime");
      assert.equal(h.renames(), 3);
      yield* h.sync("Manual T3 title", { manual: true });
      yield* h.sync("Generated while runtime remains closed");
      assert.equal(yield* h.title, "Retry confirmed");

      const racing = yield* fixture();
      yield* racing.initialize;
      racing.onRename((title) =>
        racing.observe("Manual during rename").pipe(Effect.andThen(racing.observe(title))),
      );
      yield* racing.sync("In-flight generated title");
      const reconstructed = yield* makeKiroNativeTitles(
        racing.turn.providerThread.providerInstanceId,
      );
      yield* racing.bind(reconstructed);
      yield* racing.sync("Cannot revive a retired receipt", {}, reconstructed);
      assert.equal(racing.renames(), 2);

      const interrupted = yield* fixture();
      yield* interrupted.initialize;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      interrupted.setReceiptWrite(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const retirement = yield* interrupted.observe("Manual before close").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const cancel = yield* Fiber.interrupt(retirement).pipe(Effect.forkScoped);
      yield* Scope.close(interrupted.scope, Exit.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancel);
      const afterClose = yield* makeKiroNativeTitles(
        interrupted.turn.providerThread.providerInstanceId,
      );
      yield* interrupted.bind(afterClose);
      yield* interrupted.sync("Cannot revive after cancellation", {}, afterClose);
      assert.equal(interrupted.renames(), 1);

      const failed = yield* fixture();
      yield* failed.initialize;
      yield* failed.fs.rename(failed.receiptDirectory, `${failed.receiptDirectory}.backup`);
      yield* failed.fs.writeFileString(failed.receiptDirectory, "Synthetic persistence failure");
      const error = yield* failed.observe("Manual with unavailable persistence").pipe(Effect.flip);
      assert.equal(error._tag, "AcpTransportError");
      yield* failed.fs.remove(failed.receiptDirectory);
      yield* failed.fs.rename(`${failed.receiptDirectory}.backup`, failed.receiptDirectory);
      yield* failed.sync("Retirement must remain latched");
      const afterFailure = yield* makeKiroNativeTitles(
        failed.turn.providerThread.providerInstanceId,
      );
      yield* failed.bind(afterFailure);
      yield* failed.sync("Still cannot revive", {}, afterFailure);
      assert.equal(failed.renames(), 1);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
