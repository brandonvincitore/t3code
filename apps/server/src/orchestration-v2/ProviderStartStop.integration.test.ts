import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

it.effect.each([
  "succeeded",
  "pending-ingestion",
  "accepted-start-error",
  "goal-activation-error",
  "identity-force-shared",
  "identity-force-shared-replaced",
  "identity-force-shared-unsent",
  "handoff-force-shared-inline",
  "handoff-force-shared-injected",
  "ingestion-force-shared",
  "ingestion-force-shared-racing",
  "queued-promotion",
  "before-ownership",
  "superseded-native",
  "failed-scope-close",
  "interrupt-error",
  "interrupt-timeout",
  "identity-timeout",
  "identity-timeout-force",
  "unsupported-compact",
  "prompt-refusal",
  "preparation-refusal",
  "attachment-refusal",
  "manager-release",
  "manager-release-interrupt",
  "provider-stopped",
  "stream-ended",
  "released-before-subscribe",
  "released-during-subscribe",
] as const)("Stop crosses native start: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const cwd = yield* checkpointWorkspace(`start-stop-${scenario}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      const entered = yield* Deferred.make<void>();
      const accept = yield* Deferred.make<void>();
      const nativeAccepted = yield* Deferred.make<void>();
      const callerCancelled = yield* Deferred.make<void>();
      const releaseIdentity = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const snapshotted = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const ingestionHeld = yield* Deferred.make<void>();
      const releaseIngestion = yield* Deferred.make<void>();
      const cleanupGuardRead = yield* Deferred.make<void>();
      const handoffHeld = yield* Deferred.make<void>();
      const releaseHandoff = yield* Deferred.make<void>();
      const wrapperSettled =
        yield* Deferred.make<Exit.Exit<void, ProviderAdapter.ProviderAdapterV2Error>>();
      const releaseIngestFailure = yield* Deferred.make<void>();
      const firstInterruptFailure = yield* Deferred.make<void>();
      const releaseFirstInterrupt = yield* Deferred.make<void>();
      const secondInterruptAck = yield* Deferred.make<void>();
      const ingestionExited = yield* Deferred.make<void>();
      const failureFinalized = yield* Deferred.make<void>();
      const nativeSourceClosed = yield* Deferred.make<void>();
      const exactTerminalSeen = yield* Deferred.make<void>();
      const discardedTailSeen = yield* Deferred.make<void>();
      const lateOldTerminalSeen = yield* Deferred.make<void>();
      const interruptCalled = yield* Deferred.make<void>();
      const interruptCancelled = yield* Deferred.make<void>();
      const releaseTerminal = yield* Deferred.make<void>();
      const ownedWait = yield* Deferred.make<void>();
      const beforeOwnership = yield* Deferred.make<void>();
      const closeHeld = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      const lateSubscribed = yield* Deferred.make<void>();
      const lateSubscriptionClosed = yield* Deferred.make<void>();
      const lateSubscription =
        scenario === "released-before-subscribe" || scenario === "released-during-subscribe";
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "synthetic" };
      const threadId = ThreadId.make(`thread:start-stop:${scenario}`);
      const interrupts: ProviderTurnId[] = [];
      const siblingId = ThreadId.make(`${threadId}:sibling`);
      let sibling: OrchestrationV2ProviderTurn | undefined;
      let closed = false;
      let opens = 0;
      const shared = scenario.startsWith("identity-force-shared");
      const handoff = scenario.startsWith("handoff-force-shared");
      const ingestionFailure = scenario.startsWith("ingestion-force-shared");
      const liveness = handoff || ingestionFailure;
      const racing = scenario === "ingestion-force-shared-racing";
      const unsent = scenario === "identity-force-shared-unsent";
      const replaced = scenario === "identity-force-shared-replaced";
      const milestones: string[] = [];
      let active: OrchestrationV2ProviderTurn | undefined;
      let starts = 0;
      const nativeTexts: string[] = [];
      let previousNativeTurn: OrchestrationV2ProviderTurn | undefined;
      let refused = false;
      let enterCommandLock: (operation: string) => Effect.Effect<void> = () => Effect.void;
      const startPending =
        scenario !== "succeeded" &&
        scenario !== "queued-promotion" &&
        scenario !== "accepted-start-error" &&
        scenario !== "goal-activation-error" &&
        !ingestionFailure &&
        scenario !== "superseded-native";
      const identityDelayed =
        scenario === "identity-timeout" || scenario === "identity-timeout-force" || shared;
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            opens++;
            yield* Effect.addFinalizer(() =>
              scenario === "failed-scope-close"
                ? Effect.die(new Error("synthetic scope close failure"))
                : Effect.sync(() => {
                    active = undefined;
                    sibling = undefined;
                    closed = true;
                  }),
            );
            if (scenario === "released-during-subscribe")
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(closeHeld, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseClose)),
                ),
              );
            const now = yield* DateTime.now;
            const startTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (
              turn,
            ) =>
              Effect.gen(function* () {
                if (turn.threadId === siblingId) {
                  sibling = {
                    id: ProviderTurnId.make(`native-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  };
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: sibling,
                  });
                  return;
                }
                if (
                  scenario === "prompt-refusal" ||
                  scenario === "attachment-refusal" ||
                  scenario === "preparation-refusal"
                ) {
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause:
                      scenario === "preparation-refusal"
                        ? new ProviderAdapter.ProviderAdapterTurnPreparationError({
                            driver,
                            cause: "synthetic pre-prompt configuration",
                          })
                        : scenario === "attachment-refusal"
                          ? new ProviderAdapter.ProviderAdapterProtocolError({
                              driver,
                              reason: "attachment_unreadable",
                              detail: "Synthetic unreadable attachment before prompt delivery",
                            })
                          : {
                              _tag: "ClaudeAppendSystemPromptFileError",
                              path: "/task-owned/missing-file",
                            },
                  });
                }
                yield* enterCommandLock(`start-${starts}`);
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(accept);
                if (unsent && !refused) {
                  refused = true;
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause: new ProviderAdapter.ProviderAdapterTurnPreparationError({
                      driver,
                      cause: "synthetic pre-prompt refusal after revocation",
                    }),
                  });
                }
                assert.isUndefined(active, "native turns must never overlap");
                starts++;
                nativeTexts.push(turn.message.text);
                active = {
                  id: ProviderTurnId.make(`native-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                };
                milestones.push(`accepted:${active.id}`);
                yield* Deferred.succeed(nativeAccepted, undefined);
                if (identityDelayed && starts === 1) yield* Deferred.await(releaseIdentity);
                // Another attempt and a sibling on this same session cannot supply our identity.
                if (starts === 1) {
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      ...active,
                      id: ProviderTurnId.make("foreign:old"),
                      runAttemptId: RunAttemptId.make("foreign:old"),
                    },
                  });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      ...active,
                      id: ProviderTurnId.make("foreign:sibling"),
                      providerThreadId: ProviderThreadId.make("foreign:sibling"),
                      runAttemptId: RunAttemptId.make("foreign:sibling"),
                    },
                  });
                }
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: active,
                });
                if (scenario === "goal-activation-error" && starts === 1) {
                  yield* Deferred.await(ingestionHeld);
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause: {
                      _tag: "CodexAppServerRequestError",
                      method: "thread/goal/set",
                      code: -32600,
                      errorMessage: "synthetic post-start activation rejection",
                    },
                  });
                }
                if (scenario === "accepted-start-error" && starts === 1)
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause: "synthetic lost start response after acceptance",
                  });
                if (startPending && starts === 1) yield* Deferred.await(releaseStart);
              });
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: "synthetic",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ...(handoff
                ? {
                    injectHistory: () =>
                      Deferred.succeed(handoffHeld, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseHandoff)),
                        Effect.as(scenario.endsWith("injected")),
                      ),
                  }
                : {}),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: shared || liveness ? `synthetic:${threadId}` : "synthetic-thread",
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
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn,
              compactThread: startTurn,
              interruptTurn: (target) =>
                Effect.gen(function* () {
                  yield* enterCommandLock(`interrupt-${interrupts.length}`);
                  interrupts.push(target.providerTurnId);
                  assert.equal(
                    target.providerTurnId,
                    active?.id,
                    "interrupt must target the accepted native identity",
                  );
                  assert.isTrue(target.requestRuntimeRestart);
                  milestones.push(`interrupt:${target.providerTurnId}`);
                  yield* Deferred.succeed(interruptCalled, undefined);
                  if (ingestionFailure) {
                    if (interrupts.length === 1) {
                      yield* Deferred.succeed(firstInterruptFailure, undefined);
                      yield* Deferred.await(releaseFirstInterrupt);
                      return yield* new ProviderAdapter.ProviderAdapterInterruptError({
                        driver,
                        providerThreadId: target.providerThread.id,
                        providerTurnId: target.providerTurnId,
                        cause: "synthetic failed automatic interrupt",
                      });
                    }
                    yield* Deferred.succeed(secondInterruptAck, undefined);
                    return;
                  }
                  if (scenario === "interrupt-error")
                    return yield* new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: target.providerThread.id,
                      providerTurnId: target.providerTurnId,
                      cause: "synthetic interrupt rejection",
                    });
                  if (scenario === "interrupt-timeout")
                    return yield* Effect.never.pipe(
                      Effect.ensuring(Deferred.succeed(interruptCancelled, undefined)),
                    );
                  yield* Deferred.await(releaseTerminal);
                  const turn = active!;
                  active = undefined;
                  const completedAt = yield* DateTime.now;
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: { ...turn, status: "interrupted", completedAt },
                  });
                  yield* Queue.offer(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turn.providerThreadId,
                    providerTurnId: turn.id,
                    runOrdinal: 1,
                    status: "interrupted",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const databaseLayer = SqlitePersistence.layerMemory;
      const base = Layer.mergeAll(
        ProviderReplayHarness.layerWithRegistry(
          { name: `start-stop-${scenario}` },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer },
        ),
        ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
        EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
        CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer)),
        ServerSettings.layerTest(),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        enterCommandLock = (operation) =>
          orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`lock:${operation}`),
              threadId,
              title: `Synthetic native I/O ${operation}`,
            })
            .pipe(Effect.asVoid, Effect.orDie);
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const execution = yield* RunExecutionService.RunExecutionServiceV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        let rejectIngestion = ingestionFailure;
        const originalFinalWrite = sink.writeIfRunCurrent;
        using _failedWrite = ingestionFailure
          ? vi
              .spyOn(sink, "writeIfRunCurrent")
              .mockImplementation((input) =>
                originalFinalWrite(input).pipe(
                  Effect.tap(() =>
                    input.events.some(
                      (event) =>
                        event.type === "run.updated" &&
                        event.threadId === threadId &&
                        event.payload.status === "failed",
                    )
                      ? Deferred.succeed(failureFinalized, undefined)
                      : Effect.void,
                  ),
                ),
              )
          : undefined;
        const originalRecords = store.getThreadRecords;
        using _cleanupGuard = replaced
          ? vi
              .spyOn(store, "getThreadRecords")
              .mockImplementation((...args) =>
                originalRecords(...args).pipe(
                  Effect.tap(() =>
                    replaced &&
                    args[0] === threadId &&
                    args[1].length === 2 &&
                    args[1].includes("providerThreads") &&
                    args[1].includes("providerTurns")
                      ? Deferred.succeed(cleanupGuardRead, undefined)
                      : Effect.void,
                  ),
                ),
              )
          : undefined;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:start-stop"),
          title: "Synthetic acceptance race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const send = (id: string, queued = false) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text: queued ? "/goal ship it" : id,
            attachments: [],
            dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        const originalStart = execution.startRootRun;
        let staleInput: RunExecutionService.RunExecutionServiceV2StartRootRunInput | undefined;
        using _beforeOwnership = vi.spyOn(execution, "startRootRun").mockImplementation((input) => {
          if (lateSubscription)
            return Effect.gen(function* () {
              const released = yield* manager
                .release({ providerSessionId: input.providerSessionId, reason: "manual_shutdown" })
                .pipe(Effect.orDie, Effect.forkIn(scope));
              if (scenario === "released-before-subscribe") yield* Fiber.join(released);
              else yield* Deferred.await(closeHeld);
              const startup = yield* originalStart({
                ...input,
                session: {
                  ...input.session,
                  subscribeEvents: input.session.subscribeEvents!.pipe(
                    Effect.map((subscription) => ({
                      ...subscription,
                      close: subscription.close.pipe(
                        Effect.tap(() => Deferred.succeed(lateSubscriptionClosed, undefined)),
                      ),
                    })),
                    Effect.tap(() => Deferred.succeed(lateSubscribed, undefined)),
                  ),
                },
              }).pipe(Effect.forkIn(scope));
              yield* Deferred.await(lateSubscribed);
              yield* Deferred.succeed(releaseClose, undefined);
              yield* Fiber.join(released);
              yield* Fiber.join(startup);
            });
          if (scenario === "unsupported-compact") {
            const session = { ...input.session };
            delete session.compactThread;
            return originalStart({
              ...input,
              message: { ...input.message, text: "/compact" },
              session,
            });
          }
          if (scenario !== "before-ownership") {
            staleInput = input;
            if (liveness && input.run.threadId === threadId)
              return originalStart({
                ...input,
                session: {
                  ...input.session,
                  startTurn: (turn) =>
                    input.session
                      .startTurn(turn)
                      .pipe(Effect.onExit((exit) => Deferred.succeed(wrapperSettled, exit))),
                  subscribeEvents: input.session.subscribeEvents!.pipe(
                    Effect.map((subscription) => ({
                      ...subscription,
                      close: subscription.close.pipe(
                        Effect.tap(() => Deferred.succeed(nativeSourceClosed, undefined)),
                      ),
                      events: subscription.events.pipe(
                        Stream.tap((event) =>
                          Effect.gen(function* () {
                            if (
                              event.type !== "turn.terminal" ||
                              event.providerThreadId !== input.providerThread.id
                            )
                              return;
                            if (event.providerTurnId === ProviderTurnId.make("stale:discard:127"))
                              yield* Deferred.succeed(discardedTailSeen, undefined);
                            if (
                              event.providerTurnId ===
                              ProviderTurnId.make(`native-turn:${input.attemptId}`)
                            )
                              yield* Deferred.succeed(exactTerminalSeen, undefined);
                            if (
                              input.run.ordinal === 2 &&
                              event.providerTurnId === previousNativeTurn?.id
                            )
                              yield* Deferred.succeed(lateOldTerminalSeen, undefined);
                          }),
                        ),
                      ),
                    })),
                  ),
                },
              }).pipe(Effect.onInterrupt(() => Deferred.succeed(callerCancelled, undefined)));
            return originalStart(
              scenario === "goal-activation-error"
                ? {
                    ...input,
                    session: {
                      ...input.session,
                      subscribeEvents: input.session.subscribeEvents!.pipe(
                        Effect.map((subscription) => ({
                          ...subscription,
                          events: subscription.events.pipe(
                            Stream.tap((event) =>
                              event.type === "provider_turn.updated" &&
                              event.providerTurn.runAttemptId === input.attemptId &&
                              event.providerTurn.status === "running" &&
                              starts === 1
                                ? Deferred.succeed(ingestionHeld, undefined).pipe(
                                    Effect.andThen(Deferred.await(releaseIngestion)),
                                  )
                                : Effect.void,
                            ),
                          ),
                        })),
                      ),
                    },
                  }
                : input,
            ).pipe(Effect.onInterrupt(() => Deferred.succeed(callerCancelled, undefined)));
          }
          staleInput = input;
          return Deferred.succeed(beforeOwnership, undefined).pipe(Effect.andThen(Effect.never));
        });
        const originalWrite = sink.write;
        using _ingestion = vi.spyOn(sink, "write").mockImplementation((input) => {
          if (
            rejectIngestion &&
            input.events.some(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.threadId === threadId &&
                event.payload.status === "running" &&
                event.payload.runAttemptId === active?.runAttemptId,
            )
          ) {
            rejectIngestion = false;
            return Deferred.succeed(ingestionHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseIngestFailure)),
              Effect.andThen(
                Effect.fail(
                  new EventSink.EventSinkWriteError({
                    eventCount: input.events.length,
                    cause: new Error("synthetic consumer-local persistence failure"),
                  }),
                ),
              ),
              Effect.ensuring(Deferred.succeed(ingestionExited, undefined)),
            );
          }
          return originalWrite(input);
        });
        const originalConsume = sink.consumeProviderEvents;
        using _pendingIngestion =
          scenario === "pending-ingestion"
            ? vi
                .spyOn(sink, "consumeProviderEvents")
                .mockImplementation((source, ...args) =>
                  originalConsume(
                    source.pipe(
                      Stream.tap((event) =>
                        event.type === "provider_turn.updated" &&
                        "providerTurn" in event &&
                        event.providerTurn === active
                          ? Deferred.succeed(ingestionHeld, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseIngestion)),
                            )
                          : Effect.void,
                      ),
                    ),
                    ...args,
                  ),
                )
            : undefined;
        yield* send("first");
        if (handoff) {
          const pending = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          assert.isNotNull(pending.providerThreadId);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("manual-handoff"),
                type: "context-handoff.updated",
                threadId,
                runId: pending.id,
                occurredAt: now,
                payload: {
                  id: ContextHandoffId.make("manual-handoff"),
                  threadId,
                  targetRunId: pending.id,
                  fromProviderThreadIds: [],
                  toProviderThreadId: pending.providerThreadId!,
                  coveredRunOrdinals: { from: 1, to: 1 },
                  strategy: "manual_context",
                  status: "ready",
                  summaryMessageId: null,
                  summaryText: "SYNTHETIC MANUAL CONTEXT",
                  createdByProviderInstanceId: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const startup = yield* worker.drain(1).pipe(Effect.forkScoped);
        if (
          scenario === "unsupported-compact" ||
          scenario === "prompt-refusal" ||
          scenario === "preparation-refusal" ||
          scenario === "attachment-refusal" ||
          lateSubscription
        ) {
          yield* Fiber.join(startup);
          const failed = yield* orchestrator.getThreadProjection(threadId);
          const run = failed.runs[0]!;
          assert.equal(run.status, "failed");
          assert.equal(failed.attempts[0]?.status, "failed");
          assert.equal(failed.nodes.find((node) => node.id === run.rootNodeId)?.status, "failed");
          assert.isTrue(
            Option.isNone(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          assert.equal(starts, 0);
          assert.deepEqual(interrupts, []);
          if (lateSubscription) assert.isTrue(yield* Deferred.isDone(lateSubscriptionClosed));
          return;
        }
        if (scenario === "before-ownership") {
          yield* Deferred.await(beforeOwnership);
          const pending = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          const missing = yield* execution
            .interruptOwnedStart({
              threadId,
              runId: pending.id,
              attemptId: pending.activeAttemptId!,
            })
            .pipe(Effect.flip);
          assert.isFalse(missing.unresponsive);
          assert.nestedPropertyVal(missing, "cause._tag", "NativeStartOwnershipError");
          assert.nestedPropertyVal(missing, "cause.state", "missing");
          assert.nestedPropertyVal(missing, "cause.threadId", threadId);
          assert.nestedPropertyVal(missing, "cause.runId", pending.id);
          assert.nestedPropertyVal(missing, "cause.attemptId", pending.activeAttemptId);
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop"),
            threadId,
          });
          yield* Fiber.join(startup);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "interrupted",
          );
          yield* originalStart(staleInput!);
          assert.equal(starts, 0);
          return;
        }
        yield* handoff ? Deferred.await(handoffHeld) : Deferred.await(entered);
        milestones.push("entered");
        if (scenario === "queued-promotion") yield* send("promoted", true);
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs.find((run) => run.status === "running")!;
        if (liveness) {
          if (ingestionFailure) {
            yield* Deferred.succeed(accept, undefined);
            yield* Deferred.await(nativeAccepted);
            previousNativeTurn = active!;
            yield* Deferred.await(ingestionHeld);
            yield* Fiber.join(startup);
          }
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-sibling"),
            threadId: siblingId,
            projectId: ProjectId.make("project:start-stop"),
            title: "working sibling",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("sibling-start"),
            threadId: siblingId,
            messageId: MessageId.make("sibling-start"),
            text: "sibling",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(1);
          assert.isDefined(sibling);
          assert.equal(opens, 1);
          if (ingestionFailure) {
            for (let ordinal = 0; ordinal < 128; ordinal++)
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: active!.providerThreadId,
                providerTurnId: ProviderTurnId.make(`stale:discard:${ordinal}`),
                runOrdinal: 1,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            yield* Deferred.succeed(releaseIngestFailure, undefined);
            yield* Deferred.await(ingestionExited);
            yield* Deferred.await(firstInterruptFailure);
            yield* Deferred.await(discardedTailSeen);
            if (!racing) {
              yield* Deferred.succeed(releaseFirstInterrupt, undefined);
              yield* Deferred.await(failureFinalized);
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
                "failed",
              );
            }
          }
          const forced = yield* threads.forceStopThread({ threadId, runId: run.id });
          assert.equal(forced.outcome, "shared");
          assert.isFalse(closed);
          const cleanup = yield* execution.revokeOwnedStart({
            threadId,
            runId: run.id,
            attemptId: run.activeAttemptId!,
          });
          assert.isDefined(cleanup);
          if (handoff) {
            assert.equal(starts, 0);
            yield* Deferred.succeed(releaseHandoff, undefined);
            const response = yield* Deferred.await(wrapperSettled);
            assert.isTrue(
              Exit.isFailure(response),
              "the actual handoff guard must propagate known-unsent rather than successful void",
            );
            yield* cleanup!;
            assert.equal(starts, 0);
            assert.deepEqual(interrupts, []);
            const stopped = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(stopped.runs[0]?.status, "interrupted");
            assert.isNull(stopped.attempts[0]?.providerTurnId);
            assert.isFalse(
              stopped.turnItems.some((item) => item.runId === run.id && item.type === "error"),
            );
            assert.equal(
              stopped.contextHandoffs[0]?.delivery?.status,
              scenario.endsWith("injected") ? "injected" : undefined,
            );
          } else {
            yield* Deferred.await(secondInterruptAck);
            yield* Deferred.succeed(releaseFirstInterrupt, undefined);
            yield* TestClock.adjust("15 seconds");
            assert.isFalse(
              yield* Deferred.isDone(nativeSourceClosed),
              "a consumer-local ingestion failure must not close native observation",
            );
            yield* threads.forceStopThread({ threadId, runId: run.id });
            const old = active!;
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: old.providerThreadId,
              providerTurnId: ProviderTurnId.make("stale:unrelated"),
              runOrdinal: 1,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            active = undefined;
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: old.providerThreadId,
              providerTurnId: old.id,
              runOrdinal: 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Deferred.await(exactTerminalSeen);
            yield* cleanup!;
            assert.deepEqual(interrupts, [old.id, old.id]);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
              racing ? "interrupted" : "failed",
            );
          }
          assert.isTrue(
            Option.isNone(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          assert.isDefined(sibling);
          assert.isFalse(closed);
          assert.equal(
            (yield* orchestrator.getThreadProjection(siblingId)).runs[0]?.status,
            "running",
          );
          yield* Deferred.succeed(accept, undefined);
          yield* Deferred.succeed(releaseStart, undefined);
          yield* Deferred.succeed(releaseIdentity, undefined);
          const nextWaiting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.ordinal === 2 &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* send("liveness-next");
          yield* worker.drain(1);
          const next = active!;
          if (ingestionFailure) {
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: previousNativeTurn!.providerThreadId,
              providerTurnId: previousNativeTurn!.id,
              runOrdinal: 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Deferred.await(lateOldTerminalSeen);
            const current = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            assert.equal(current.status, "running");
            assert.isTrue(
              Option.isSome(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: current.id,
                  attemptId: current.activeAttemptId!,
                }),
              ),
            );
          }
          active = undefined;
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: next.providerThreadId,
            providerTurnId: next.id,
            runOrdinal: 2,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(nextWaiting);
          yield* worker.drain();
          assert.equal(starts, handoff ? 1 : 2);
          if (handoff)
            assert.equal(
              nativeTexts.at(-1)!.split("SYNTHETIC MANUAL CONTEXT").length - 1,
              scenario.endsWith("injected") ? 0 : 1,
            );
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status,
            "completed",
          );
          assert.isDefined(sibling);
          yield* Deferred.await(nativeSourceClosed);
          const siblingRun = (yield* orchestrator.getThreadProjection(siblingId)).runs[0]!;
          const siblingWaiting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === siblingRun.id &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const siblingTurn = sibling!;
          sibling = undefined;
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: siblingTurn.providerThreadId,
            providerTurnId: siblingTurn.id,
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(siblingWaiting);
          yield* worker.drain();
          assert.equal(
            (yield* orchestrator.getThreadProjection(siblingId)).runs[0]?.status,
            "completed",
          );
          assert.isFalse(closed);
          if (yield* Config.Boolean("T3_START_STOP_TRANSCRIPT").pipe(Config.withDefault(false)))
            yield* Effect.logInfo({
              synthetic: true,
              scenario,
              milestones,
              nativeStarts: starts,
              interruptCalls: interrupts.length,
              successfulInterrupts: ingestionFailure ? interrupts.length - 1 : 0,
              nativeSourceClosed: yield* Deferred.isDone(nativeSourceClosed),
              oldOwnerReleased: Option.isNone(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: run.id,
                  attemptId: run.activeAttemptId!,
                }),
              ),
              nextA: "completed",
              siblingB: "completed",
              runtimeClosed: closed,
              sharedRuntimeOpens: opens,
              discardedNativeFrames: ingestionFailure ? 128 : 0,
              nextInlineContextCopies:
                nativeTexts.at(-1)!.split("SYNTHETIC MANUAL CONTEXT").length - 1,
            }).pipe(
              Effect.provide(Logger.layer([Logger.consoleJson])),
              Effect.provideService(References.MinimumLogLevel, "Info"),
            );
          return;
        }
        if (scenario === "goal-activation-error") {
          yield* Deferred.succeed(accept, undefined);
          yield* Deferred.await(nativeAccepted);
          yield* Deferred.await(ingestionHeld);
          yield* Fiber.join(startup);
          assert.isTrue(
            Option.isSome(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
            "post-start goal rejection must retain exact native ownership",
          );
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "running",
          );
          yield* Deferred.succeed(releaseIngestion, undefined);
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("goal-stop"),
            threadId,
          });
          yield* Deferred.succeed(releaseTerminal, undefined);
          yield* worker.drain();
          assert.deepEqual(interrupts, [ProviderTurnId.make(`native-turn:${run.activeAttemptId}`)]);
          assert.isUndefined(active);
          yield* send("goal-next");
          yield* worker.drain();
          assert.equal(starts, 2);
          assert.isDefined(active);
          return;
        }
        if (shared) {
          const originalInput = staleInput!;
          if (!unsent) {
            yield* Deferred.succeed(accept, undefined);
            yield* Deferred.await(nativeAccepted);
          }
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-sibling"),
            threadId: siblingId,
            projectId: ProjectId.make("project:start-stop"),
            title: "working sibling",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("sibling-start"),
            threadId: siblingId,
            messageId: MessageId.make("sibling-start"),
            text: "sibling",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(1);
          const b = (yield* orchestrator.getThreadProjection(siblingId)).runs[0]!;
          assert.isDefined(sibling);
          assert.equal(opens, 1, "both owned starts use the actual shared runtime");
          const outcome = yield* threads.forceStopThread({ threadId, runId: run.id });
          assert.equal(outcome.outcome, "shared");
          assert.deepEqual(outcome.sharedWithThreadIds, [siblingId]);
          assert.isFalse(closed);
          assert.deepEqual(interrupts, []);
          assert.isTrue(
            Option.isSome(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
            "revocation must retain pending native cleanup",
          );
          yield* threads.forceStopThread({ threadId, runId: run.id });
          const cleanup = yield* execution.revokeOwnedStart({
            threadId,
            runId: run.id,
            attemptId: run.activeAttemptId!,
          });
          assert.isDefined(cleanup);
          yield* originalStart(originalInput);
          assert.equal(
            starts,
            unsent ? 0 : 1,
            "revocation removes the old attempt's start authority",
          );
          yield* TestClock.adjust("15 seconds");
          const outstanding = Option.getOrThrow(
            yield* execution.getStartOwnership({
              threadId,
              runId: run.id,
              attemptId: run.activeAttemptId!,
            }),
          );
          assert.isTrue(outstanding.revoked);
          assert.equal(outstanding.cleanup, "unresponsive");
          if (replaced) {
            const binding = initial.providerThreads.find(
              (thread) => thread.id === run.providerThreadId,
            )!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("replace-revoked-binding"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...binding,
                    nativeThreadRef: { driver, nativeId: "replacement-native", strength: "strong" },
                  },
                },
              ],
            });
          }
          yield* Deferred.succeed(accept, undefined);
          yield* Deferred.succeed(releaseTerminal, undefined);
          yield* Deferred.succeed(releaseStart, undefined);
          yield* Deferred.succeed(releaseIdentity, undefined);
          if (replaced) {
            yield* Deferred.await(cleanupGuardRead);
            const old = active!;
            active = undefined;
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: old.providerThreadId,
              providerTurnId: old.id,
              runOrdinal: 1,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          } else if (!unsent) yield* Deferred.await(interruptCalled);
          yield* cleanup!;
          yield* Fiber.join(startup);
          const expectedInterrupts =
            unsent || replaced ? [] : [ProviderTurnId.make(`native-turn:${run.activeAttemptId}`)];
          assert.deepEqual(interrupts, expectedInterrupts);
          assert.isUndefined(active);
          assert.isDefined(sibling);
          assert.isFalse(closed);
          assert.equal(
            (yield* orchestrator.getThreadProjection(siblingId)).runs[0]?.status,
            "running",
          );
          const siblingDone = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === b.id &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: sibling!.providerThreadId,
            providerTurnId: sibling!.id,
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          sibling = undefined;
          yield* Fiber.join(siblingDone);
          yield* send("shared-next");
          yield* worker.drain();
          assert.equal(starts, unsent ? 1 : 2);
          assert.isDefined(active);
          assert.deepEqual(interrupts, expectedInterrupts);
          return;
        }
        if (scenario === "superseded-native") {
          const ingested = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.runAttemptId === run.activeAttemptId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Deferred.succeed(accept, undefined);
          yield* Fiber.join(startup);
          yield* Fiber.join(ingested);
          const owner = initial.providerThreads.find(
            (thread) => thread.id === run.providerThreadId,
          )!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("native-binding-replaced"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...owner,
                  nativeThreadRef: { driver, nativeId: "replacement-native", strength: "strong" },
                },
              },
            ],
          });
          const rejected = yield* execution
            .interruptOwnedStart({ threadId, runId: run.id, attemptId: run.activeAttemptId! })
            .pipe(Effect.flip);
          assert.nestedPropertyVal(rejected, "cause.state", "superseded");
          assert.deepEqual(interrupts, []);
          assert.isDefined(active);
          return;
        }
        if (
          [
            "manager-release",
            "failed-scope-close",
            "manager-release-interrupt",
            "provider-stopped",
            "stream-ended",
          ].includes(scenario)
        ) {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const providerSessionId = initial.providerThreads.find(
            (thread) => thread.id === run.providerThreadId,
          )!.providerSessionId!;
          const runtime = Option.getOrThrow(yield* manager.get(providerSessionId));
          if (scenario === "manager-release-interrupt") {
            const accepted = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Deferred.succeed(accept, undefined);
            yield* Fiber.join(accepted);
          }
          const waiter = yield* Deferred.succeed(ownedWait, undefined).pipe(
            Effect.andThen(
              scenario === "failed-scope-close"
                ? Effect.void
                : execution
                    .interruptOwnedStart({
                      threadId,
                      runId: run.id,
                      attemptId: run.activeAttemptId!,
                    })
                    .pipe(Effect.asVoid),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(ownedWait);
          if (scenario === "manager-release-interrupt") yield* Deferred.await(interruptCalled);
          if (scenario === "provider-stopped" || scenario === "stream-ended") {
            if (scenario === "provider-stopped")
              yield* Queue.offer(events, {
                type: "provider_session.updated",
                driver,
                providerSession: { ...runtime.providerSession, status: "stopped" },
              });
            yield* Queue.end(events);
          } else if (scenario === "failed-scope-close") {
            const failed = yield* manager
              .release({ providerSessionId, reason: "manual_shutdown" })
              .pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(failed));
            assert.isTrue(
              Option.isSome(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: run.id,
                  attemptId: run.activeAttemptId!,
                }),
              ),
            );
            assert.isFalse(yield* Deferred.isDone(callerCancelled));
            const cleanup = yield* execution.revokeOwnedStart({
              threadId,
              runId: run.id,
              attemptId: run.activeAttemptId!,
            });
            yield* cleanup!.pipe(Effect.forkScoped);
            yield* TestClock.adjust("15 seconds");
            assert.isTrue(
              Option.isSome(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: run.id,
                  attemptId: run.activeAttemptId!,
                }),
              ),
            );
            assert.equal(
              Option.getOrThrow(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: run.id,
                  attemptId: run.activeAttemptId!,
                }),
              ).cleanup,
              "unresponsive",
            );
            assert.equal(starts, 0);
            return;
          } else {
            yield* manager.release({ providerSessionId, reason: "manual_shutdown" });
          }
          yield* Fiber.join(waiter);
          yield* Fiber.join(startup);
          assert.isTrue(
            Option.isNone(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          const failed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(failed.runs[0]?.status, "failed");
          assert.equal(failed.attempts[0]?.status, "failed");
          assert.isFalse(failed.turnItems.some((item) => item.type === "run_interrupt_result"));
          yield* Deferred.succeed(accept, undefined);
          yield* Deferred.succeed(releaseStart, undefined);
          assert.equal(starts, scenario === "manager-release-interrupt" ? 1 : 0);
          return;
        }
        const original = store.getThreadRecords;
        let armed = true;
        using _snapshot = vi.spyOn(store, "getThreadRecords").mockImplementation((...args) =>
          original(...args).pipe(
            Effect.tap((snapshot) => {
              if (
                !armed ||
                !args[1].includes("providerTurns") ||
                !args[1].includes("attempts") ||
                args[1].includes("providerSessions") ||
                snapshot.providerTurns.length !== 0
              )
                return Effect.void;
              armed = false;
              return Deferred.succeed(snapshotted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSnapshot)),
              );
            }),
          ),
        );
        const stop = yield* (
          scenario === "queued-promotion"
            ? orchestrator.dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make("stop"),
                threadId,
                queuedRunId: initial.runs.find((run) => run.status === "queued")!.id,
                targetRunId: run.id,
              })
            : orchestrator.dispatch({
                type: "thread.stop",
                commandId: CommandId.make("stop"),
                threadId,
              })
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(snapshotted);
        milestones.push("snapshot");
        const accepted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.succeed(accept, undefined);
        yield* Deferred.await(nativeAccepted);
        const duplicateStart =
          scenario === "pending-ingestion"
            ? yield* originalStart(staleInput!).pipe(Effect.forkScoped)
            : undefined;
        if (!startPending) {
          yield* Fiber.join(startup);
          milestones.push("start-returned");
        }
        yield* Deferred.succeed(releaseSnapshot, undefined);
        yield* Fiber.join(stop);
        if (!startPending) yield* Fiber.join(accepted);
        else if (scenario === "pending-ingestion") yield* Deferred.await(ingestionHeld);
        milestones.push(`stop-request:${run.id}`);
        if (scenario === "pending-ingestion")
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("repeated-stop"),
            threadId,
          });
        if (startPending) {
          yield* Fiber.join(startup);
          assert.isTrue(yield* Deferred.isDone(callerCancelled));
        }
        const stopping = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          stopping.runs.find((candidate) => candidate.id === run.id)?.status,
          "running",
          "Stop must not report terminal while the native turn is unresolved",
        );
        assert.isTrue(stopping.turnItems.some((item) => item.type === "run_interrupt_request"));
        assert.isFalse(stopping.turnItems.some((item) => item.type === "run_interrupt_result"));
        const stoppedNativeTurn = active!;
        const stopEffects = yield* outbox.listByCommandId(CommandId.make("stop"));
        assert.equal(
          stopEffects.filter((effect) => effect.request.type === "provider-turn.interrupt-start")
            .length,
          1,
        );
        const originalWait = execution.interruptOwnedStart;
        using _wait = vi
          .spyOn(execution, "interruptOwnedStart")
          .mockImplementation((key) =>
            Deferred.succeed(ownedWait, undefined).pipe(Effect.andThen(originalWait(key))),
          );
        const interrupt = yield* worker.drain(1).pipe(Effect.forkScoped);
        yield* Deferred.await(ownedWait);
        milestones.push("owned-wait");
        if (identityDelayed || scenario === "interrupt-timeout") {
          if (scenario === "interrupt-timeout") yield* Deferred.await(interruptCalled);
          yield* TestClock.adjust("15 seconds");
          yield* Fiber.join(interrupt);
          if (scenario === "interrupt-timeout") yield* Deferred.await(interruptCancelled);
          const unresolved = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(unresolved.runs[0]?.status, "running");
          assert.isTrue(
            unresolved.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.unresponsiveAt !== undefined,
            ),
          );
          assert.isFalse(unresolved.turnItems.some((item) => item.type === "run_interrupt_result"));
          assert.isTrue(
            Option.isSome(
              yield* execution.getStartOwnership({
                threadId,
                runId: run.id,
                attemptId: run.activeAttemptId!,
              }),
            ),
          );
          if (scenario === "identity-timeout") {
            yield* Deferred.succeed(releaseIdentity, undefined);
            yield* Fiber.join(accepted);
            assert.deepEqual(interrupts, []);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
              "running",
            );
          }
          if (scenario === "identity-timeout-force") {
            assert.deepEqual(interrupts, []);
            const outcome = yield* threads.forceStopThread({ threadId, runId: run.id });
            assert.equal(outcome.outcome, "released");
            assert.isTrue(
              Option.isNone(
                yield* execution.getStartOwnership({
                  threadId,
                  runId: run.id,
                  attemptId: run.activeAttemptId!,
                }),
              ),
            );
            const forced = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(forced.runs[0]?.status, "interrupted");
            assert.isTrue(
              forced.turnItems.some(
                (item) =>
                  item.type === "run_interrupt_result" && item.message === "Force stopped by user",
              ),
            );
          }
          return;
        }
        yield* Deferred.await(interruptCalled);
        if (scenario === "interrupt-error") {
          yield* Fiber.join(interrupt);
          const row = (yield* outbox.listByCommandId(CommandId.make("stop"))).find(
            (effect) => effect.request.type === "provider-turn.interrupt-start",
          )!;
          assert.equal(row.status, "pending");
          assert.include(row.lastError!, "synthetic interrupt rejection");
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "running",
          );
          return;
        }
        assert.isTrue(
          Option.isSome(
            yield* execution.getStartOwnership({
              threadId,
              runId: run.id,
              attemptId: run.activeAttemptId!,
            }),
          ),
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.id === run.id,
          )?.status,
          "running",
        );
        assert.deepEqual(interrupts, [active!.id]);
        const terminal = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === run.id &&
              event.payload.status === "interrupted",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.succeed(releaseIngestion, undefined);
        yield* Deferred.succeed(releaseTerminal, undefined);
        yield* Fiber.join(interrupt);
        yield* Fiber.join(terminal);
        yield* Fiber.join(accepted);
        milestones.push(`terminal:${run.id}`);
        yield* Deferred.succeed(releaseStart, undefined);
        if (duplicateStart !== undefined) yield* Fiber.join(duplicateStart);
        if (scenario !== "queued-promotion") yield* send("replacement");
        const replacementAccepted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== run.activeAttemptId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(replacementAccepted);
        assert.equal(starts, 2);
        assert.isDefined(active);
        const replacementId = active!.id;
        if (scenario === "pending-ingestion") {
          const afterLateTerminal = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.id === replacementId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              ...stoppedNativeTurn,
              status: "interrupted",
              completedAt: yield* DateTime.now,
            },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: stoppedNativeTurn.providerThreadId,
            providerTurnId: stoppedNativeTurn.id,
            runOrdinal: 1,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: active!,
          });
          yield* Fiber.join(afterLateTerminal);
        }
        assert.isUndefined(
          yield* execution.interruptOwnedStart({
            threadId,
            runId: run.id,
            attemptId: run.activeAttemptId!,
          }),
        );
        yield* execution.revokeOwnedStart({
          threadId,
          runId: run.id,
          attemptId: run.activeAttemptId!,
        });
        yield* orchestrator.dispatch({
          type: "run.interrupt.unresponsive",
          commandId: CommandId.make("stale-timeout"),
          threadId,
          runId: run.id,
          attemptId: run.activeAttemptId!,
        });
        yield* orchestrator.dispatch({
          type: "run.force-stop.settle",
          commandId: CommandId.make("stale-force"),
          threadId,
          runId: run.id,
          attemptId: run.activeAttemptId!,
          reason: "stale",
        });
        assert.equal(active!.id, replacementId);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
            (candidate) => candidate.status === "running",
          )?.ordinal,
          2,
        );
        assert.equal(interrupts.length, 1);
        if (yield* Config.Boolean("T3_START_STOP_TRANSCRIPT").pipe(Config.withDefault(false)))
          yield* Effect.logInfo({ synthetic: true, scenario, milestones, starts, interrupts }).pipe(
            Effect.provide(Logger.layer([Logger.consoleJson])),
            Effect.provideService(References.MinimumLogLevel, "Info"),
          );
      }).pipe(Effect.provide(ThreadManagementService.layer.pipe(Layer.provideMerge(base))));
    }),
  ),
);
