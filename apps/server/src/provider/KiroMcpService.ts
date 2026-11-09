import {
  KiroMcpError,
  type KiroMcpAttemptInput,
  type KiroMcpAuthorizationResult,
  type KiroMcpBeginSignInInput,
  type KiroMcpBeginSignInResult,
  type KiroMcpStatus,
  type KiroMcpStatusInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

export class KiroMcpService extends Context.Service<
  KiroMcpService,
  {
    readonly getStatus: (
      input: KiroMcpStatusInput,
      ownerSessionId: string,
    ) => Effect.Effect<KiroMcpStatus, KiroMcpError>;
    readonly beginSignIn: (
      input: KiroMcpBeginSignInInput,
      ownerSessionId: string,
    ) => Effect.Effect<KiroMcpBeginSignInResult, KiroMcpError>;
    readonly takeAuthorizationUrl: (
      input: KiroMcpAttemptInput,
      ownerSessionId: string,
    ) => Effect.Effect<KiroMcpAuthorizationResult, KiroMcpError>;
    readonly cancelSignIn: (
      input: KiroMcpAttemptInput,
      ownerSessionId: string,
    ) => Effect.Effect<void, KiroMcpError>;
  }
>()("t3/provider/KiroMcpService") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const resolve = Effect.fn("KiroMcpService.resolve")(function* (input: KiroMcpStatusInput) {
    const projection = yield* projections
      .getThreadRecords(input.threadId, ["thread", "providerThreads", "providerSessions"])
      .pipe(Effect.mapError(() => new KiroMcpError({ code: "session_unavailable" })));
    const thread = projection.providerThreads.find(
      (entry) => entry.id === projection.thread?.activeProviderThreadId,
    );
    const session = projection.providerSessions.find(
      (entry) => entry.id === thread?.providerSessionId,
    );
    const sessionId = thread?.nativeThreadRef?.nativeId;
    if (
      !thread ||
      thread.appThreadId !== input.threadId ||
      thread.ownerNodeId !== null ||
      thread.driver !== "kiro" ||
      !sessionId ||
      !session ||
      session.providerInstanceId !== thread.providerInstanceId ||
      session.status === "stopped" ||
      session.status === "error"
    ) {
      return yield* new KiroMcpError({ code: "session_unavailable" });
    }
    const instance = yield* registry.getInstance(thread.providerInstanceId);
    if (!instance?.kiroMcp || instance.driverKind !== "kiro")
      return yield* new KiroMcpError({ code: "session_unavailable" });
    return { controller: instance.kiroMcp, sessionId };
  });

  const getStatus = Effect.fn("KiroMcpService.getStatus")(function* (
    input: KiroMcpStatusInput,
    ownerSessionId: string,
  ) {
    const { controller, sessionId } = yield* resolve(input);
    return yield* controller.getStatus(sessionId, ownerSessionId);
  });
  const beginSignIn = Effect.fn("KiroMcpService.beginSignIn")(function* (
    input: KiroMcpBeginSignInInput,
    ownerSessionId: string,
  ) {
    const { controller, sessionId } = yield* resolve(input);
    return yield* controller.beginSignIn({
      sessionId,
      serverName: input.serverName,
      ownerId: ownerSessionId,
    });
  });
  const takeAuthorizationUrl = Effect.fn("KiroMcpService.takeAuthorizationUrl")(function* (
    input: KiroMcpAttemptInput,
    ownerSessionId: string,
  ) {
    const { controller, sessionId } = yield* resolve(input);
    return yield* controller.takeAuthorizationUrl({
      sessionId,
      attemptId: input.attemptId,
      ownerId: ownerSessionId,
    });
  });
  const cancelSignIn = Effect.fn("KiroMcpService.cancelSignIn")(function* (
    input: KiroMcpAttemptInput,
    ownerSessionId: string,
  ) {
    const { controller, sessionId } = yield* resolve(input);
    yield* controller.cancelSignIn({
      sessionId,
      attemptId: input.attemptId,
      ownerId: ownerSessionId,
    });
  });

  return KiroMcpService.of({ getStatus, beginSignIn, takeAuthorizationUrl, cancelSignIn });
});

export const layer = Layer.effect(KiroMcpService, make);
