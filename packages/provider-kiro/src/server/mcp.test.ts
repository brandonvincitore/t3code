import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as AcpErrors from "effect-acp/errors";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import { makeKiroMcpSupport } from "./mcp.ts";

const resetMethod = "_kiro/mcp/resetServer";
const auth = { name: "company", status: "failed", failedAuthorization: true } as const;

const setup = Effect.fn("test.setup")(function* () {
  let randomByte = 0;
  const support = yield* makeKiroMcpSupport().pipe(
    Effect.provideService(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(randomByte++)),
    ),
  );
  const reset = yield* Deferred.make<unknown, AcpErrors.AcpError>();
  const dispatched = yield* Deferred.make<void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<
    string,
    (payload: unknown) => Effect.Effect<unknown, AcpErrors.AcpError>
  >();
  let started: Parameters<AcpAdapterV2ExtensionContext["handleSessionStarted"]>[0] | undefined;
  let current = "first";
  const runtime: Parameters<typeof support.installHandlers>[0] = {
    handleExtNotification: (method, _schema, handler) =>
      Effect.sync(() => {
        handlers.set(method, (payload) => handler(payload as never));
      }),
    handleExtRequest: (method, _schema, handler) =>
      Effect.sync(() => {
        handlers.set(method, (payload) => handler(payload as never, { requestId: "test", method }));
      }),
    request: (method: string, params: unknown) =>
      Effect.gen(function* () {
        requests.push({ method, params });
        yield* Deferred.succeed(dispatched, undefined);
        return yield* Deferred.await(reset);
      }),
  };
  const scope = yield* Scope.make();
  yield* support.installHandlers(runtime).pipe(Scope.provide(scope));
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  yield* support.registerExtensions({
    runtime,
    currentSessionId: Effect.sync(() => current),
    handleSessionStarted: (handler) =>
      Effect.sync(() => {
        started = handler;
      }),
  });
  const activate = (sessionId = "first", methods = [resetMethod]) =>
    Effect.gen(function* () {
      current = sessionId;
      assert.ok(started);
      yield* started({
        sessionId,
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { _meta: { kiro: { extensionMethods: methods } } },
        },
        sessionSetupResult: { sessionId },
        modelConfigId: undefined,
      });
    });
  const emit = (method: string, params: unknown) => {
    const handler = handlers.get(method);
    assert.ok(handler);
    return handler(params);
  };
  const snapshot = (servers: unknown[], sessionId = "first") =>
    emit("_kiro/mcp/status", { sessionId, servers });
  return { support, activate, emit, snapshot, requests, reset, dispatched, scope };
});

describe("Kiro MCP sessions", () => {
  it.effect(
    "replaces complete snapshots, ignores malformed and foreign reports, and gates optional reset",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.snapshot([auth]);
        yield* h.activate("first", []);
        assert.deepEqual((yield* h.support.getStatus("first", "owner")).servers, [auth]);
        yield* h.snapshot([{ name: "other", status: "connected" }], "unowned");
        yield* h.emit("_kiro/mcp/status", { sessionId: "first", servers: "broken" });
        assert.equal((yield* h.support.getStatus("first", "owner")).servers.length, 1);
        yield* h.snapshot([{ ...auth, status: "pending" }]);
        const result = yield* h.support
          .beginSignIn({ sessionId: "first", serverName: "company", ownerId: "owner" })
          .pipe(Effect.flip);
        assert.equal(result.code, "server_unavailable");
        assert.equal(h.requests.length, 0);
        yield* h.snapshot([]);
        assert.deepEqual((yield* h.support.getStatus("first", "owner")).servers, []);
      }).pipe(Effect.scoped),
  );

  it.effect.each([{ methods: [resetMethod] }, { methods: [] }])(
    "routes fresh user-requested URLs with advertised methods $methods to the owner once",
    ({ methods }) =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.activate("first", methods);
        assert.equal(h.requests.length, 0);
        assert.isTrue((yield* h.support.getStatus("first", "owner")).canSignIn);
        yield* h.snapshot([auth]);
        const { attemptId } = yield* h.support.beginSignIn({
          sessionId: "first",
          serverName: "company",
          ownerId: "owner",
        });
        yield* Deferred.await(h.dispatched);
        assert.deepEqual(h.requests, [
          {
            method: resetMethod,
            params: { sessionId: "first", serverName: "company", startOAuth: true },
          },
        ]);
        assert.equal((yield* h.support.getStatus("first", "different-owner")).attempt, null);
        const wrong = yield* h.support
          .takeAuthorizationUrl({ sessionId: "first", attemptId, ownerId: "different-owner" })
          .pipe(Effect.flip);
        assert.equal(wrong.code, "attempt_unavailable");
        const url = "https://login.example.test/authorize?state=private-value";
        yield* h.emit("_kiro/openExternalUrl", { url });
        assert.ok(
          !JSON.stringify(yield* h.support.getStatus("first", "owner")).includes("private-value"),
        );
        assert.deepEqual(
          yield* h.support.takeAuthorizationUrl({
            sessionId: "first",
            attemptId,
            ownerId: "owner",
          }),
          { url },
        );
        assert.equal(
          (yield* h.support
            .takeAuthorizationUrl({ sessionId: "first", attemptId, ownerId: "owner" })
            .pipe(Effect.flip)).code,
          "attempt_unavailable",
        );
        assert.equal(
          (yield* h.emit("_kiro/openExternalUrl", { url }).pipe(Effect.asVoid, Effect.flip))._tag,
          "AcpRequestError",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("fails closed when an unadvertised reset is unsupported or never supplies a URL", () =>
    Effect.gen(function* () {
      for (const failure of ["unsupported", "unknown-extension", "denied", "timeout"] as const) {
        const h = yield* setup();
        yield* h.activate("first", []);
        yield* h.snapshot([auth]);
        const { attemptId } = yield* h.support.beginSignIn({
          sessionId: "first",
          serverName: "company",
          ownerId: "owner",
        });
        yield* Deferred.await(h.dispatched);
        const waiting = yield* h.support
          .takeAuthorizationUrl({ sessionId: "first", attemptId, ownerId: "owner" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        if (failure !== "timeout") {
          yield* Deferred.fail(
            h.reset,
            new AcpErrors.AcpRequestError({
              method: resetMethod,
              code: failure === "unsupported" ? -32601 : -32603,
              errorMessage: failure === "denied" ? "Internal error" : "Method not found",
              data: {
                details:
                  failure === "denied"
                    ? "MCP governance is disabled by your organization"
                    : `Unknown ext method: ${resetMethod}`,
              },
            }),
          );
        } else {
          yield* TestClock.adjust("30 seconds");
        }
        const outcome = yield* Fiber.join(waiting);
        assert.equal(
          outcome.code,
          failure === "unsupported" || failure === "unknown-extension"
            ? "unsupported"
            : "connection_failed",
        );
        assert.isFalse((yield* h.support.getStatus("first", "owner")).canSignIn);
        assert.equal(
          (yield* h
            .emit("_kiro/openExternalUrl", { url: "https://login.example.test/late" })
            .pipe(Effect.asVoid, Effect.flip))._tag,
          "AcpRequestError",
        );
        assert.equal(h.requests.length, 1);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("dismisses the local flow without reassigning a late callback to another session", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.activate();
      yield* h.snapshot([auth]);
      const { attemptId } = yield* h.support.beginSignIn({
        sessionId: "first",
        serverName: "company",
        ownerId: "owner",
      });
      yield* Deferred.await(h.dispatched);
      const waiting = yield* h.support
        .takeAuthorizationUrl({ sessionId: "first", attemptId, ownerId: "owner" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* h.support.cancelSignIn({ sessionId: "first", attemptId, ownerId: "owner" });
      assert.equal((yield* Fiber.join(waiting)).code, "cancelled");
      yield* h.activate("second");
      yield* h.snapshot([auth], "second");
      assert.equal(
        (yield* h.support
          .beginSignIn({ sessionId: "second", serverName: "company", ownerId: "next-owner" })
          .pipe(Effect.flip)).code,
        "busy",
      );
      assert.equal(
        (yield* h
          .emit("_kiro/openExternalUrl", { url: "https://login.example.test/old" })
          .pipe(Effect.asVoid, Effect.flip))._tag,
        "AcpRequestError",
      );
      yield* Deferred.succeed(h.reset, {});
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects ownerless and unsafe callbacks and expires a flow when its runtime closes",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.activate();
        yield* h.snapshot([auth]);
        assert.equal(
          (yield* h
            .emit("_kiro/openExternalUrl", { url: "https://login.example.test" })
            .pipe(Effect.asVoid, Effect.flip))._tag,
          "AcpRequestError",
        );
        const { attemptId } = yield* h.support.beginSignIn({
          sessionId: "first",
          serverName: "company",
          ownerId: "owner",
        });
        yield* Deferred.await(h.dispatched);
        for (const url of [
          "javascript:alert(1)",
          "file:///secret",
          "https://user:password@example.test",
          "https://example.test/\n",
        ]) {
          assert.equal(
            (yield* h.emit("_kiro/openExternalUrl", { url }).pipe(Effect.asVoid, Effect.flip))._tag,
            "AcpRequestError",
          );
        }
        yield* Scope.close(h.scope, Exit.void);
        assert.equal(
          (yield* h.support.getStatus("first", "owner").pipe(Effect.flip)).code,
          "session_unavailable",
        );
        assert.equal(
          (yield* h.support
            .takeAuthorizationUrl({ sessionId: "first", attemptId, ownerId: "owner" })
            .pipe(Effect.flip)).code,
          "session_unavailable",
        );
      }).pipe(Effect.scoped),
  );
});
