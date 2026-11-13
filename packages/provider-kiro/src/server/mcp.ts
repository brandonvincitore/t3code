import { KiroMcpError, type KiroMcpController, type KiroMcpStatus } from "@t3tools/contracts";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as AcpErrors from "effect-acp/errors";

const resetMethod = "_kiro/mcp/resetServer";
const isRequestError = Schema.is(AcpErrors.AcpRequestError);
const decodeUnknownMethod = Schema.decodeUnknownOption(
  Schema.Struct({ details: Schema.Literal(`Unknown ext method: ${resetMethod}`) }),
);

function unsupportedReset(error: AcpErrors.AcpError) {
  return (
    isRequestError(error) &&
    (error.code === -32601 ||
      (error.code === -32603 && Option.isSome(decodeUnknownMethod(error.data))))
  );
}
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    servers: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        failedAuthorization: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);
const decodeUrl = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "request" | "handleExtRequest" | "handleExtNotification"
>;
type ExtensionContext = Pick<
  AcpAdapterV2ExtensionContext,
  "currentSessionId" | "handleSessionStarted"
> & { readonly runtime: Runtime };
type AttemptInput = Parameters<KiroMcpController["cancelSignIn"]>[0];
interface Attempt {
  readonly attemptId: string;
  readonly serverName: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly ready: Deferred.Deferred<void, KiroMcpError>;
  phase: "waiting_for_url" | "authorization_ready" | "connecting";
  cancelled: boolean;
  claimed: boolean;
  delivered: boolean;
  url: string | undefined;
}
interface RuntimeState {
  readonly runtime: Runtime;
  readonly scope: Scope.Scope;
  readonly snapshots: Map<string, KiroMcpStatus["servers"]>;
  context: ExtensionContext | undefined;
  sessionId: string | undefined;
  supported: boolean;
  closed: boolean;
  quarantined: boolean;
  attempt: Attempt | undefined;
}

function safeUrl(value: string) {
  if (value.length > 16_384 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export const makeKiroMcpSupport = Effect.fn("KiroMcp.make")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const runtimes = new WeakMap<object, RuntimeState>();
  const sessions = new Map<string, RuntimeState>();

  const dismiss = Effect.fn("KiroMcp.dismiss")(function* (attempt: Attempt) {
    attempt.cancelled = true;
    attempt.url = undefined;
    yield* Deferred.fail(attempt.ready, new KiroMcpError({ code: "cancelled" }));
  });

  const stateFor = Effect.fn("KiroMcp.stateFor")(function* (sessionId: string) {
    const state = sessions.get(sessionId);
    if (
      !state ||
      state.closed ||
      !state.context ||
      (yield* state.context.currentSessionId) !== sessionId
    ) {
      return yield* new KiroMcpError({ code: "session_unavailable" });
    }
    return state;
  });

  const attemptFor = Effect.fn("KiroMcp.attemptFor")(function* (input: AttemptInput) {
    const state = yield* stateFor(input.sessionId);
    const attempt = state.attempt;
    if (
      !attempt ||
      attempt.sessionId !== input.sessionId ||
      attempt.attemptId !== input.attemptId ||
      attempt.ownerId !== input.ownerId
    ) {
      return yield* new KiroMcpError({ code: "attempt_unavailable" });
    }
    if (attempt.cancelled) return yield* new KiroMcpError({ code: "cancelled" });
    return { state, attempt };
  });

  const installHandlers = Effect.fn("KiroMcp.installHandlers")(function* (runtime: Runtime) {
    if (runtimes.has(runtime)) return;
    const state: RuntimeState = {
      runtime,
      scope: yield* Scope.Scope,
      snapshots: new Map(),
      context: undefined,
      sessionId: undefined,
      supported: false,
      closed: false,
      quarantined: false,
      attempt: undefined,
    };
    runtimes.set(runtime, state);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        state.closed = true;
        if (state.attempt) yield* dismiss(state.attempt);
        state.attempt = undefined;
        state.snapshots.clear();
        for (const [sessionId, owner] of sessions) if (owner === state) sessions.delete(sessionId);
      }),
    );
    yield* runtime.handleExtNotification("_kiro/mcp/status", Schema.Unknown, (payload) =>
      Effect.sync(() => {
        const snapshot = Option.getOrUndefined(decodeSnapshot(payload));
        if (!snapshot || state.closed || snapshot.servers.length > 64) return;
        const next = new Map<string, KiroMcpStatus["servers"][number]>();
        for (const server of snapshot.servers) {
          if (
            !server.name.trim() ||
            server.name.length > 128 ||
            /[\u0000-\u001f\u007f]|https?:\/\//i.test(server.name)
          )
            continue;
          const status =
            server.status === "connected" ||
            server.status === "failed" ||
            server.status === "disabled"
              ? server.status
              : "pending";
          next.set(server.name, {
            name: server.name,
            status,
            failedAuthorization: server.failedAuthorization === true,
          });
        }
        if (!state.snapshots.has(snapshot.sessionId) && state.snapshots.size >= 64) return;
        state.snapshots.set(snapshot.sessionId, [...next.values()]);
      }),
    );
    yield* runtime.handleExtRequest("_kiro/openExternalUrl", Schema.Unknown, (payload) =>
      Effect.gen(function* () {
        const attempt = state.attempt;
        const url = Option.getOrUndefined(decodeUrl(payload))?.url;
        if (
          !attempt ||
          attempt.cancelled ||
          attempt.delivered ||
          attempt.url !== undefined ||
          state.closed ||
          !state.context ||
          (yield* state.context.currentSessionId) !== attempt.sessionId ||
          !url ||
          !safeUrl(url)
        ) {
          return yield* new AcpErrors.AcpRequestError({
            method: "_kiro/openExternalUrl",
            code: -32000,
            errorMessage: "No active user-owned MCP sign-in can accept this URL.",
          });
        }
        attempt.url = url;
        attempt.phase = "authorization_ready";
        yield* Deferred.succeed(attempt.ready, undefined);
        return { success: true };
      }),
    );
  });

  const registerExtensions = Effect.fn("KiroMcp.registerExtensions")(function* (
    context: ExtensionContext,
  ) {
    const state = runtimes.get(context.runtime);
    if (!state || state.closed) return;
    state.context = context;
    yield* context.handleSessionStarted(
      Effect.fn("KiroMcp.sessionStarted")(function* (started) {
        if (state.closed) return;
        if (state.attempt && state.attempt.sessionId !== started.sessionId)
          yield* dismiss(state.attempt);
        if (
          state.sessionId &&
          state.sessionId !== started.sessionId &&
          sessions.get(state.sessionId) === state
        )
          sessions.delete(state.sessionId);
        const previous = sessions.get(started.sessionId);
        if (previous && previous !== state && previous.attempt) yield* dismiss(previous.attempt);
        state.sessionId = started.sessionId;
        // Kiro 3.2.1 implements resetServer but omits it from its advertised methods.
        state.supported = true;
        sessions.set(started.sessionId, state);
      }),
    );
  });

  const getStatus: KiroMcpController["getStatus"] = Effect.fn("KiroMcp.getStatus")(
    function* (sessionId, ownerId) {
      const state = yield* stateFor(sessionId);
      const attempt = state.attempt;
      return {
        reported: state.snapshots.has(sessionId),
        canSignIn: state.supported && !state.quarantined,
        busy: attempt !== undefined,
        servers: state.snapshots.get(sessionId) ?? [],
        attempt:
          attempt &&
          !attempt.cancelled &&
          attempt.ownerId === ownerId &&
          attempt.sessionId === sessionId
            ? {
                attemptId: attempt.attemptId,
                serverName: attempt.serverName,
                phase: attempt.phase,
              }
            : null,
      };
    },
  );

  const beginSignIn: KiroMcpController["beginSignIn"] = Effect.fn("KiroMcp.beginSignIn")(
    function* (input) {
      const state = yield* stateFor(input.sessionId);
      if (!state.supported || state.quarantined)
        return yield* new KiroMcpError({ code: "unsupported" });
      if (state.attempt) return yield* new KiroMcpError({ code: "busy" });
      const server = state.snapshots
        .get(input.sessionId)
        ?.find((entry) => entry.name === input.serverName);
      if (!server?.failedAuthorization || server.status !== "failed")
        return yield* new KiroMcpError({ code: "server_unavailable" });
      const attempt: Attempt = {
        ...input,
        attemptId: yield* random.uuidV4(),
        ready: yield* Deferred.make<void, KiroMcpError>(),
        phase: "waiting_for_url",
        cancelled: false,
        claimed: false,
        delivered: false,
        url: undefined,
      };
      // No yield between checking and claiming: a URL has no session or server attribution.
      if (state.attempt) return yield* new KiroMcpError({ code: "busy" });
      state.attempt = attempt;
      yield* state.runtime
        .request(resetMethod, {
          sessionId: input.sessionId,
          serverName: input.serverName,
          startOAuth: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              state.quarantined = true;
              attempt.cancelled = true;
              attempt.url = undefined;
              const unsupported = unsupportedReset(error);
              if (unsupported) state.supported = false;
              yield* Deferred.fail(
                attempt.ready,
                new KiroMcpError({ code: unsupported ? "unsupported" : "connection_failed" }),
              );
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              attempt.url = undefined;
              yield* Deferred.fail(attempt.ready, new KiroMcpError({ code: "connection_failed" }));
              if (state.attempt === attempt) state.attempt = undefined;
            }),
          ),
          Effect.forkIn(state.scope),
        );
      return { attemptId: attempt.attemptId };
    },
  );

  const takeAuthorizationUrl: KiroMcpController["takeAuthorizationUrl"] = Effect.fn(
    "KiroMcp.takeAuthorizationUrl",
  )(function* (input) {
    const { state, attempt } = yield* attemptFor(input);
    if (attempt.claimed) return yield* new KiroMcpError({ code: "attempt_unavailable" });
    attempt.claimed = true;
    const ready = yield* Deferred.await(attempt.ready).pipe(Effect.timeoutOption("30 seconds"));
    if (Option.isNone(ready)) {
      state.quarantined = true;
      yield* dismiss(attempt);
      return yield* new KiroMcpError({ code: "connection_failed" });
    }
    const current = yield* attemptFor(input);
    const url = current.attempt.url;
    current.attempt.url = undefined;
    current.attempt.delivered = true;
    if (!url) return yield* new KiroMcpError({ code: "attempt_unavailable" });
    current.attempt.phase = "connecting";
    return { url };
  });

  const cancelSignIn: KiroMcpController["cancelSignIn"] = Effect.fn("KiroMcp.cancelSignIn")(
    function* (input) {
      const { attempt } = yield* attemptFor(input);
      // Hold attribution until reset settles; this is a local dismissal, never a protocol cancel.
      yield* dismiss(attempt);
    },
  );

  return {
    installHandlers,
    registerExtensions,
    getStatus,
    beginSignIn,
    takeAuthorizationUrl,
    cancelSignIn,
  };
});
