// @effect-diagnostics nodeBuiltinImport:off - The runtime proof supplies a closed stdin and an explicit isolated subprocess environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { makeKiroNativeHistory } from "@t3tools/provider-kiro/testing";
import { expect, it } from "@effect/vitest";
import {
  type AgentSessionSource,
  type ServerSettingsError,
  EventId,
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  MessageId,
  RunId,
  TurnItemId,
  RunAttemptId,
  NodeId,
  ProviderTurnId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

class SyntheticWriterError extends Schema.TaggedError<SyntheticWriterError>()(
  "SyntheticWriterError",
  { cause: Schema.Defect() },
) {}

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
  driverOverride?: ProviderDriverKind,
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = driverOverride ?? ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  getAdapter?: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape["get"],
  threadCommands?: KeyedLock.KeyedLock<ThreadId>,
  settings: Layer.Layer<
    ServerSettings.ServerSettingsService,
    ServerSettingsError
  > = ServerSettings.layerTest(),
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          settings,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => Stream.fromIterable(candidates),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
          getAdapter === undefined
            ? Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})
            : Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
                get: getAdapter,
                list: () => Effect.succeed([]),
              }),
          Layer.succeed(
            ThreadCommandExecutor.ThreadCommandExecutor,
            threadCommands ?? (yield* KeyedLock.make<ThreadId>()),
          ),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId }),
    importNativeHistory: importer.importNativeHistory,
    syncNativeHistory: importer.syncNativeHistory,
    published,
  };
});

it.effect("catches up an existing Kiro owner without loading the native session", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const selection = { instanceId: ProviderInstanceId.make("kiro"), model: "default" };
    const threadId = yield* seedOwner(
      candidate(selection, "catch-up"),
      "active",
      ProviderDriverKind.make("kiro"),
    );
    const before = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    yield* sink.write({
      events: [
        {
          id: EventId.make("legacy-history"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...before.thread, historyOrigin: "v1_import" },
        },
      ],
    });
    const capture = {
      source: "synthetic-source",
      identity: "snapshot-1",
      rows: [
        {
          id: "native-user-row",
          digest: "row-digest",
          timestamp,
          kind: "user" as const,
          text: "External CLI addition",
        },
      ],
    };
    const adapter = {
      instanceId: selection.instanceId,
      driver: ProviderDriverKind.make("kiro"),
      nativeHistory: {
        capture: () => Effect.succeed(capture),
      },
      openSession: () => Effect.die("Native load must never be used for catch-up"),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const importer = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    expect(
      yield* importer.importNativeHistory({ threadId, workspaceRoot: "/workspace/project" }),
    ).toBe(1);
    expect(
      (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map((m) => m.text),
    ).toEqual(["External CLI addition"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      unowned.thread.omittedMessageCount = 1;
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === unowned) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
    const sink = yield* EventSink.EventSinkV2;
    const providerThread = (yield* projections.getThreadRecords(ownerId, ["providerThreads"]))
      .providerThreads[0]!;
    const ownerThread = yield* projections.getThread(ownerId);
    const importedId = importId(source);
    const importedProviderThread = { ...providerThread, appThreadId: importedId };
    const claim = {
      commandId: CommandId.make("import-ownership-claim"),
      threadId: importedId,
      commandType: "thread.create",
      acceptedAt: now,
      unlessNativeThreadOwned: importedProviderThread,
      events: [
        {
          id: EventId.make("import-ownership-claim:thread"),
          type: "thread.created" as const,
          threadId: importedId,
          occurredAt: now,
          payload: {
            ...ownerThread,
            id: importedId,
            lineage: { ...ownerThread.lineage, rootThreadId: importedId },
          },
        },
        {
          id: EventId.make("import-ownership-claim:provider"),
          type: "provider-thread.updated" as const,
          threadId: importedId,
          occurredAt: now,
          payload: importedProviderThread,
        },
      ],
      effects: [],
    };
    const rejected = yield* sink.commitCommand(claim);
    expect(rejected.receipt.status).toBe("rejected");
    expect(rejected.storedEvents).toEqual([]);
    expect(yield* Effect.option(projections.getThread(importedId))).toEqual(Option.none());
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "copies native session history into the imported thread once, retrying a failed read",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const source = candidate(CODEX_MODEL_SELECTION, "native-history");
      const threadId = yield* seedOwner(source);
      const resolved: Array<ProviderInstanceId> = [];
      const opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
      let closed = false;
      let failRead = true;
      const replayed = (role: "user" | "assistant", text: string) => ({
        createdBy: role === "user" ? ("user" as const) : ("agent" as const),
        creationSource: "provider" as const,
        id: MessageId.make(`replayed:${text}`),
        threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const adapter = {
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opened.push(input);
              return {
                readThreadSnapshot: ({ providerThread }) =>
                  failRead
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                          driver: providerThread.driver,
                          providerThreadId: providerThread.id,
                        }),
                      )
                    : Effect.succeed({
                        providerThread,
                        providerTurns: [],
                        runtimeRequests: [],
                        reasoningMessageIds: [MessageId.make("replayed:Check the build log")],
                        messages: [
                          replayed("user", "Fix the build"),
                          replayed("assistant", "Check the build log"),
                          replayed("assistant", "Fixed it"),
                          replayed("assistant", " "),
                        ],
                      }),
              } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">;
            }),
            () =>
              Effect.sync(() => {
                closed = true;
              }),
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
      const importer = yield* makeImporter([], Effect.void, (instanceId) =>
        Effect.sync(() => {
          resolved.push(instanceId);
          return adapter;
        }),
      );

      const importHistory = importer.importNativeHistory({
        threadId,
        workspaceRoot: "/workspace/project",
      });

      expect((yield* Effect.flip(importHistory))._tag).toBe(
        "ProviderAdapterReadThreadSnapshotError",
      );
      expect(closed).toBe(true);
      expect(
        (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
      ).toBeUndefined();

      failRead = false;
      expect(yield* importHistory).toBe(3);
      expect(resolved).toEqual([
        CODEX_MODEL_SELECTION.instanceId,
        CODEX_MODEL_SELECTION.instanceId,
      ]);
      expect(opened[1]).toMatchObject({
        threadId,
        initialNativeThreadId: source.source.providerSessionId,
        runtimePolicy: { cwd: "/workspace/project" },
      });
      // Forks keep run-less history only for this origin.
      expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
        "v1_import",
      );
      expect(
        (yield* projections.getThreadRecords(threadId, ["providerThreads"])).providerThreads[0]
          ?.nativeMetadata,
      ).toMatchObject({
        importedHistory: {
          driver: "codex",
          providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
          nativeThreadId: source.source.providerSessionId,
          itemCount: 3,
        },
      });
      expect(yield* importHistory).toBe(0);
      expect(opened).toHaveLength(2);
      const records = yield* projections.getThreadRecords(threadId, ["messages"]);
      expect(records.messages.map((message) => message.text)).toEqual([
        "Fix the build",
        "Fixed it",
      ]);
      expect(
        importer.published.filter(
          (stored) => "event" in stored && stored.event.type === "message.updated",
        ),
      ).toHaveLength(2);
      const page = yield* projections.getTimelinePage(threadId, { view: "activity", limit: 10 });
      expect(
        page.items.map(({ item }) => [
          item.type,
          item.runId,
          "text" in item ? item.text : undefined,
        ]),
      ).toEqual([
        ["user_message", null, "Fix the build"],
        ["reasoning", null, "Check the build log"],
        ["assistant_message", null, "Fixed it"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("releases the ACP import lock when a native session never answers", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
    const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, "native-history-hang"));
    const opened = yield* Deferred.make<void>();
    let closed = false;
    // An agent that only resumes sessions and never answers its first session/resume.
    const adapter = {
      openSession: () =>
        Effect.suspend(() => {
          if (!closed) {
            return Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ).pipe(
              Effect.andThen(Deferred.succeed(opened, undefined)),
              Effect.andThen(Effect.never),
            );
          }
          return Effect.succeed({
            readThreadSnapshot: ({ providerThread }) =>
              Effect.succeed({
                providerThread,
                providerTurns: [],
                runtimeRequests: [],
                messages: [
                  {
                    createdBy: "user",
                    creationSource: "provider",
                    id: MessageId.make("replayed:hang"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: "user",
                    text: "Fix the build",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
          } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">);
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const importer = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    const importHistory = coordinator.withSessionMutation(
      importer.importNativeHistory({ threadId, workspaceRoot: "/workspace/project" }),
    );

    const importing = yield* importHistory.pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(opened);
    // Any other ACP import or delete waits for the same lock.
    const next = yield* coordinator
      .withSessionMutation(Effect.succeed("next"))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 minutes");

    expect((yield* Fiber.join(importing))._tag).toBe("TimeoutError");
    expect(closed).toBe(true);
    expect(yield* Fiber.join(next)).toBe("next");
    expect(
      (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
    ).toBeUndefined();
    expect(yield* importHistory).toBe(1);
    expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
      "v1_import",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(persistence, AcpRegistryRuntimeCoordinator.layer)),
  ),
);

/**
 * Runs a thread command that read the thread before the history load ended and
 * writes once the importer is about to commit, as an unserialized write would.
 */
const importDuringCommand = Effect.fn(function* (
  name: string,
  command: (
    thread: OrchestrationV2AppThread,
    owner: OrchestrationV2ProviderThread,
  ) => ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, name));
  const lock = yield* KeyedLock.make<ThreadId>();
  const loaded = yield* Deferred.make<void>();
  const importerCommitting = yield* Deferred.make<void>();
  const commandWritten = yield* Deferred.make<void>();
  const committing = Deferred.succeed(importerCommitting, undefined);
  const adapter = {
    openSession: () =>
      Effect.succeed({
        readThreadSnapshot: ({ providerThread }) =>
          Deferred.await(loaded).pipe(
            Effect.as({
              providerThread,
              providerTurns: [],
              runtimeRequests: [],
              messages: [
                {
                  createdBy: "user" as const,
                  creationSource: "provider" as const,
                  id: MessageId.make(`replayed:${name}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: "user" as const,
                  text: "Fix the build",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }),
          ),
      } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const importer = yield* makeImporter(
    [],
    committing.pipe(Effect.andThen(Deferred.await(commandWritten))),
    () => Effect.succeed(adapter),
    {
      ...lock,
      withLock: (key, effect) => committing.pipe(Effect.andThen(lock.withLock(key, effect))),
    },
  );
  const commanding = yield* Effect.forkScoped(
    lock.withLock(
      threadId,
      Effect.gen(function* () {
        const { thread, providerThreads } = yield* projections.getThreadRecords(threadId, [
          "providerThreads",
        ]);
        yield* Deferred.succeed(loaded, undefined);
        yield* Deferred.await(importerCommitting);
        yield* sink.write({ events: command(thread, providerThreads[0]!) });
        yield* Deferred.succeed(commandWritten, undefined);
      }),
    ),
  );
  const imported = yield* importer.importNativeHistory({
    threadId,
    workspaceRoot: "/workspace/project",
  });
  yield* Fiber.join(commanding);
  const records = yield* projections.getThreadRecords(threadId, ["runs"]);
  const page = yield* projections.getTimelinePage(threadId, { view: "messages", limit: 10 });
  return { imported, thread: records.thread, runs: records.runs, items: page.items };
});

it.effect("keeps a thread edit made while the native history loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("renamed-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:renamed`),
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, title: "Renamed" },
      },
    ]);
    expect(result.imported).toBe(1);
    expect(result.thread.title).toBe("Renamed");
    expect(result.thread.historyOrigin).toBe("v1_import");
    expect(result.items).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["run", "native session", "provider instance", "driver", "active root"] as const)(
  "skips native history when %s changes while it loads",
  (change) =>
    Effect.gen(function* () {
      const result = yield* importDuringCommand(`changed-${change}`, (thread, owner) =>
        change === "run"
          ? [
              {
                id: EventId.make(`${thread.id}:run`),
                type: "run.updated",
                threadId: thread.id,
                occurredAt: now,
                payload: {
                  id: RunId.make(`${thread.id}:run`),
                  threadId: thread.id,
                  ordinal: 1,
                  providerInstanceId: thread.providerInstanceId,
                  modelSelection: thread.modelSelection,
                  providerThreadId: null,
                  userMessageId: MessageId.make(`${thread.id}:prompt`),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "queued",
                  requestedAt: now,
                  startedAt: null,
                  completedAt: null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ]
          : change === "active root"
            ? [
                {
                  id: EventId.make(`${thread.id}:active-root`),
                  type: "thread.metadata-updated",
                  threadId: thread.id,
                  occurredAt: now,
                  payload: {
                    ...thread,
                    activeProviderThreadId: ProviderThreadId.make("another-root"),
                  },
                },
              ]
            : [
                {
                  id: EventId.make(`${thread.id}:owner`),
                  type: "provider-thread.updated",
                  threadId: thread.id,
                  occurredAt: now,
                  payload: {
                    ...owner,
                    ...(change === "native session"
                      ? {
                          nativeThreadRef: {
                            ...owner.nativeThreadRef!,
                            nativeId: "replacement-native",
                          },
                        }
                      : {}),
                    ...(change === "provider instance"
                      ? { providerInstanceId: ProviderInstanceId.make("replacement-instance") }
                      : {}),
                    ...(change === "driver" ? { driver: ProviderDriverKind.make("kiro") } : {}),
                  },
                },
              ],
      );
      expect(result.imported).toBe(0);
      expect(result.runs).toHaveLength(change === "run" ? 1 : 0);
      expect(result.thread.historyOrigin).toBeUndefined();
      expect(result.items).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports under a policy ceiling in the project's default, kept under the ceiling", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ceiling");
    const threadId = importId(source);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      undefined,
      undefined,
      ServerSettings.layerTest(
        { defaultRuntimeMode: "full-access" },
        {
          organization: "Example Corp",
          lockedSettings: [],
          limits: { maxRuntimeMode: "auto-accept-edits" },
        },
      ),
    );
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect((yield* projections.getThread(threadId)).runtimeMode).toBe("auto-accept-edits");
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimeMode).toBe(
      "auto-accept-edits",
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

const setupKiroSync = Effect.fn("test.setupKiroSync")(function* (withRun = false) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const selection = { instanceId: ProviderInstanceId.make("kiro"), model: "default" };
  const threadId = yield* seedOwner(
    candidate(selection, "sync"),
    "active",
    ProviderDriverKind.make("kiro"),
  );
  const before = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
  const owner = before.providerThreads[0]!;
  const rows: Array<
    import("@t3tools/provider-core/server/ProviderAdapter").NativeHistoryCapture["rows"][number]
  > = [
    {
      id: "user-external",
      digest: "user-digest",
      timestamp,
      kind: "user",
      text: "CLI addition",
      userRowId: "user-external",
    },
    {
      id: "reasoning",
      digest: "reasoning-digest",
      timestamp,
      kind: "reasoning",
      text: "Thinking",
      userRowId: "user-external",
    },
    {
      id: "reply",
      digest: "reply-digest",
      timestamp,
      kind: "assistant",
      text: "Reply",
      userRowId: "user-external",
    },
    {
      id: "end-external",
      digest: "end-digest",
      timestamp,
      kind: "control",
      boundary: "end",
      userRowId: "user-external",
    },
  ];
  const capture = { source: "scoped-source", identity: "snapshot-1", rows };
  const state = { reads: 0, capture, beforeCapture: Effect.void as Effect.Effect<void> };
  const reader = {
    capture: () =>
      state.beforeCapture.pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.reads++;
            return state.capture;
          }),
        ),
      ),
  };
  const adapter = {
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make("kiro"),
    nativeHistory: reader,
    openSession: () => Effect.die("Native loading is forbidden"),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const provider = { current: adapter };
  const lock = yield* KeyedLock.make<ThreadId>();
  const make = () => makeImporter([], Effect.void, () => Effect.succeed(provider.current), lock);
  const importer = yield* make();
  if (withRun) {
    const runId = RunId.make("existing-run");
    const attemptId = RunAttemptId.make("existing-attempt");
    const nodeId = NodeId.make("existing-node");
    const turnId = ProviderTurnId.make("existing-turn");
    yield* sink.write({
      events: [
        {
          id: EventId.make("existing-run"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: selection.instanceId,
            modelSelection: selection,
            providerThreadId: owner.id,
            userMessageId: MessageId.make("existing-user"),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("existing-attempt"),
          type: "run-attempt.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: selection.instanceId,
            providerThreadId: owner.id,
            providerTurnId: turnId,
            nativeThreadId: "sync",
            reason: "initial",
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make("existing-turn"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: turnId,
            providerThreadId: owner.id,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: {
              driver: ProviderDriverKind.make("kiro"),
              nativeId: "anchored-user",
              strength: "strong",
            },
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make("existing-user-item"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("existing-user-item"),
            threadId,
            runId,
            nodeId,
            providerThreadId: owner.id,
            providerTurnId: turnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("existing-user"),
            inputIntent: "turn_start",
            text: "Earlier T3 prompt",
            attachments: [],
          },
        },
        {
          id: EventId.make("existing-user-message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: MessageId.make("existing-user"),
            threadId,
            runId,
            nodeId,
            role: "user",
            text: "Earlier T3 prompt",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("existing-history"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...before.thread, historyOrigin: "v1_import" },
        },
      ],
    });
    rows.unshift(
      {
        id: "anchored-user",
        digest: "anchor-digest",
        timestamp,
        kind: "user",
        text: "Earlier T3 prompt",
        userRowId: "anchored-user",
      },
      {
        id: "anchored-end",
        digest: "anchor-end-digest",
        timestamp,
        kind: "control",
        boundary: "end",
        userRowId: "anchored-user",
      },
    );
  }
  const input = { threadId, projectId, instanceId: selection.instanceId };
  return {
    importer,
    make,
    input,
    capture,
    state,
    provider,
    owner,
    sink,
    projections,
    lock,
    read: () =>
      projections.getThreadRecords(threadId, ["providerThreads", "messages", "runs", "turnItems"]),
  };
});

it.effect(
  "syncs CLI additions after a strong legacy anchor in a thread with runs, and remains idempotent across concurrent requests and reconstruction",
  () =>
    Effect.gen(function* () {
      const h = yield* setupKiroSync(true);
      expect(yield* h.importer.syncNativeHistory({ ...h.input, checkOnly: true })).toMatchObject({
        status: "updates_available",
        baselineRows: 2,
      });
      expect((yield* h.read()).messages).toHaveLength(1);
      const results = yield* Effect.all(
        [h.importer.syncNativeHistory(h.input), h.importer.syncNativeHistory(h.input)],
        { concurrency: 2 },
      );
      expect(results.map((result) => result.addedItems).sort()).toEqual([0, 3]);
      const records = yield* h.read();
      expect(records.runs).toHaveLength(1);
      expect(records.messages.map((message) => message.text)).toEqual([
        "Earlier T3 prompt",
        "CLI addition",
        "Reply",
      ]);
      const externalItems = records.turnItems.filter((item) => item.runId === null);
      expect(
        externalItems.every(
          (item) => item.ordinal > records.turnItems.find((item) => item.runId !== null)!.ordinal,
        ),
      ).toBe(true);
      expect(externalItems.map((item) => item.type)).toEqual([
        "user_message",
        "reasoning",
        "assistant_message",
      ]);
      expect(externalItems.map((item) => item.nativeItemRef?.nativeId)).toEqual([
        "user-external",
        "reasoning",
        "reply",
      ]);
      expect(records.providerThreads[0]?.nativeMetadata?.nativeHistory?.rows).toHaveLength(6);
      const restarted = yield* h.make();
      expect(yield* restarted.syncNativeHistory(h.input)).toMatchObject({
        status: "synced",
        addedItems: 0,
      });
      h.state.capture = {
        ...h.capture,
        identity: "snapshot-2",
        rows: [
          ...h.capture.rows,
          {
            id: "next-user",
            digest: "next-digest",
            timestamp,
            kind: "user",
            text: "CLI addition",
            userRowId: "next-user",
          },
          {
            id: "next-end",
            digest: "next-end",
            timestamp,
            kind: "control",
            boundary: "end",
            userRowId: "next-user",
          },
        ],
      };
      expect(yield* restarted.syncNativeHistory(h.input)).toMatchObject({
        status: "synced",
        addedItems: 1,
      });
      expect(
        (yield* h.read()).messages.filter((message) => message.text === "CLI addition"),
      ).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["legacy", "receipt", "receipt unstarted", "unstarted", "uncertain"] as const)(
  "does not reimport a T3 cancelled native input: %s",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* setupKiroSync(true);
      if (kind.startsWith("receipt")) yield* h.importer.syncNativeHistory(h.input);
      const records = yield* h.projections.getThreadRecords(h.input.threadId, [
        "runs",
        "providerTurns",
        "attempts",
      ]);
      const run = records.runs[0]!;
      const turn = records.providerTurns[0]!;
      const attempt = records.attempts[0]!;
      const later = kind.startsWith("receipt");
      const runId = later ? RunId.make("cancelled-run") : run.id;
      const attemptId = later ? RunAttemptId.make("cancelled-attempt") : attempt.id;
      const turnId = later ? ProviderTurnId.make("cancelled-turn") : turn.id;
      const nativeUser = later ? "cancelled-user" : "anchored-user";
      yield* h.sink.write({
        events: [
          {
            id: EventId.make("cancel-run"),
            type: "run.updated",
            threadId: h.input.threadId,
            occurredAt: now,
            payload: {
              ...run,
              id: runId,
              ordinal: later ? 2 : 1,
              activeAttemptId: attemptId,
              status: "cancelled",
              startedAt: kind.endsWith("unstarted") ? null : now,
            },
          },
          {
            id: EventId.make("cancel-attempt"),
            type: "run-attempt.updated",
            threadId: h.input.threadId,
            occurredAt: now,
            payload: { ...attempt, id: attemptId, runId, providerTurnId: turnId },
          },
          {
            id: EventId.make("cancel-turn"),
            type: "provider-turn.updated",
            threadId: h.input.threadId,
            occurredAt: now,
            payload: {
              ...turn,
              id: turnId,
              ordinal: later ? 2 : 1,
              runAttemptId: attemptId,
              status: kind === "uncertain" ? "interrupted" : "completed",
              nativeTurnRef: { ...turn.nativeTurnRef!, nativeId: nativeUser },
            },
          },
        ],
      });
      if (later)
        h.state.capture = {
          ...h.capture,
          identity: "after-cancel",
          rows: [
            ...h.capture.rows,
            ...(kind === "receipt unstarted"
              ? []
              : ([
                  {
                    id: nativeUser,
                    digest: nativeUser,
                    timestamp,
                    kind: "user",
                    text: "Already delivered cancelled input",
                    userRowId: nativeUser,
                  },
                  {
                    id: "cancelled-end",
                    digest: "cancelled-end",
                    timestamp,
                    kind: "control",
                    boundary: "end",
                    userRowId: nativeUser,
                  },
                ] as const)),
            {
              id: "later-external",
              digest: "later-external",
              timestamp,
              kind: "user",
              text: "External after cancel",
              userRowId: "later-external",
            },
            {
              id: "later-end",
              digest: "later-end",
              timestamp,
              kind: "control",
              boundary: "end",
              userRowId: "later-external",
            },
          ],
        };
      const result = yield* h.importer.syncNativeHistory(h.input);
      expect(result.status).toBe(
        kind === "unstarted" || kind === "uncertain" ? "ambiguous" : "synced",
      );
      if (result.status === "synced") {
        expect(result.addedItems).toBe(later ? 1 : 3);
        expect(
          (yield* h.read()).messages.filter((message) => message.text === "Earlier T3 prompt"),
        ).toHaveLength(1);
        expect(
          (yield* h.read()).messages.some(
            (message) => message.text === "Already delivered cancelled input",
          ),
        ).toBe(false);
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each([
  "unanchored",
  "unsupported",
  "rewrite",
  "truncate",
  "home",
  "project",
  "instance",
  "replacement",
  "native replacement",
  "provider replacement",
  "driver replacement",
  "cwd replacement",
  "busy",
  "unstable",
] as const)("keeps the timeline unchanged and receipts bound to their owner on %s sync", (kind) =>
  Effect.gen(function* () {
    const h = yield* setupKiroSync(kind === "unanchored");
    if (kind !== "unanchored") yield* h.importer.syncNativeHistory(h.input);
    const before = yield* h.read();
    let input = h.input;
    switch (kind) {
      case "unsupported":
        yield* h.sink.write({
          events: [
            {
              id: EventId.make("unsupported-driver"),
              type: "provider-thread.updated",
              threadId: input.threadId,
              occurredAt: now,
              payload: { ...before.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
            },
          ],
        });
        break;
      case "unanchored":
        h.capture.rows[0] = { ...h.capture.rows[0]!, id: "different-native-user" };
        break;
      case "rewrite":
        h.state.capture = {
          ...h.capture,
          rows: [{ ...h.capture.rows[0]!, digest: "rewritten" }, ...h.capture.rows.slice(1)],
        };
        break;
      case "truncate":
        h.state.capture = { ...h.capture, rows: h.capture.rows.slice(0, -1) };
        break;
      case "home":
        h.state.capture = { ...h.capture, source: "another-home" };
        break;
      case "project":
        input = { ...input, projectId: ProjectId.make("another-project") };
        break;
      case "instance":
        input = { ...input, instanceId: ProviderInstanceId.make("another-instance") };
        break;
      case "replacement":
        h.state.beforeCapture = Effect.sync(() => {
          h.provider.current = {
            ...h.provider.current,
            nativeHistory: { ...h.provider.current.nativeHistory! },
          };
        });
        break;
      case "native replacement":
      case "provider replacement":
      case "driver replacement":
      case "cwd replacement":
        h.state.beforeCapture = Effect.suspend(() =>
          h.state.reads > 2
            ? Effect.void
            : h.sink
                .write({
                  events: [
                    kind === "cwd replacement"
                      ? {
                          id: EventId.make("capture-cwd-change"),
                          type: "thread.metadata-updated",
                          threadId: input.threadId,
                          occurredAt: now,
                          payload: { ...before.thread, worktreePath: "/another-workspace" },
                        }
                      : {
                          id: EventId.make(`capture-${kind}`),
                          type: "provider-thread.updated",
                          threadId: input.threadId,
                          occurredAt: now,
                          payload: {
                            ...before.providerThreads[0]!,
                            ...(kind === "native replacement"
                              ? {
                                  nativeThreadRef: {
                                    ...h.owner.nativeThreadRef!,
                                    nativeId: "another-native",
                                  },
                                }
                              : {}),
                            ...(kind === "provider replacement"
                              ? { providerInstanceId: ProviderInstanceId.make("another-provider") }
                              : {}),
                            ...(kind === "driver replacement"
                              ? { driver: ProviderDriverKind.make("another-driver") }
                              : {}),
                          },
                        },
                  ],
                })
                .pipe(Effect.asVoid, Effect.orDie),
        );
        break;
      case "unstable":
        h.state.beforeCapture = Effect.sync(() => {
          h.state.capture = { ...h.state.capture, identity: `changing-${h.state.reads}` };
        });
        break;
      case "busy":
        yield* h.sink.write({
          events: [
            {
              id: EventId.make("busy-run"),
              type: "run.updated",
              threadId: input.threadId,
              occurredAt: now,
              payload: {
                id: RunId.make("busy-run"),
                threadId: input.threadId,
                ordinal: 1,
                providerInstanceId: input.instanceId,
                modelSelection: { instanceId: input.instanceId, model: "default" },
                providerThreadId: h.owner.id,
                userMessageId: MessageId.make("busy-user"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "running",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        break;
    }
    const result = yield* h.importer.syncNativeHistory(input);
    expect(result.status).toBe(
      kind === "unsupported"
        ? "unsupported"
        : kind === "unanchored"
          ? "ambiguous"
          : kind === "busy" || kind === "unstable"
            ? "busy"
            : "unsafe",
    );
    const after = yield* h.read();
    expect(after.messages).toEqual(before.messages);
    expect(after.providerThreads[0]?.nativeMetadata).toEqual(
      ["unsupported", "native replacement", "provider replacement", "driver replacement"].includes(
        kind,
      )
        ? {}
        : before.providerThreads[0]?.nativeMetadata,
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.live(
  "proves read-only catch-up through the service after a synthetic subprocess releases its lease",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-history-proof-" });
      const selection = { instanceId: ProviderInstanceId.make("kiro"), model: "default" };
      const threadId = yield* seedOwner(
        candidate(selection, "pipe-proof"),
        "active",
        ProviderDriverKind.make("kiro"),
      );
      const native = `${home}/.kiro`;
      const writer = String.raw`
      const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
      const root = process.env.KIRO_HOME; const cwd = '/workspace/project'; const id = 'pipe-proof';
      const directory = path.join(root, 'sessions', crypto.createHash('sha256').update(cwd).digest('hex').slice(0,16), id);
      fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.join(root,'session-leases'), {recursive:true});
      const at = '2026-11-13T00:00:00.000Z';
      fs.writeFileSync(path.join(directory,'session.json'),JSON.stringify({schemaVersion:'1.0.0',id,workspacePaths:[cwd],createdAt:at,lastModifiedAt:at}));
      const rows = [{id:'writer-user',timestamp:at,payload:{type:'user',content:'Synthetic CLI request',_meta:{kiro:{peerPromptGeneration:false,userMessageTag:'synthetic-tag'}}}},
        {id:'writer-thought',timestamp:at,payload:{type:'assistant',operationType:'Reasoning',content:'Synthetic reasoning',_meta:{kiro:{}}}},
        {id:'writer-answer',timestamp:at,payload:{type:'assistant',operationType:'Say',content:'Synthetic CLI answer',_meta:{kiro:{classifierApproved:true}}}},
        {id:'writer-pending',timestamp:at,payload:{type:'pending_interaction',interactionType:'tool_approval',toolCallId:'synthetic-tool',question:'Private native approval',options:[],executionId:'synthetic-execution'}},
        {id:'writer-resolved',timestamp:at,payload:{type:'interaction_resolved',toolCallId:'synthetic-tool',outcome:'approved',executionId:'synthetic-execution'}},
        {id:'writer-memory',timestamp:at,payload:{type:'session_metadata',key:'memoryExposureMessage',value:'Private memory control',executionId:'synthetic-execution'}},
        {id:'writer-end',timestamp:at,payload:{type:'turn_end',stopReason:'end_turn'}}];
      fs.writeFileSync(path.join(directory,'messages.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
      fs.writeFileSync(path.join(root,'session-leases',id+'.lease'),'synthetic foreign lease');
      process.stdout.write('synthetic writer: one completed turn persisted\n');
    `;
      const transcript = yield* Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            const child = NodeChildProcess.spawn(process.execPath, ["-e", writer], {
              cwd: home,
              env: {
                HOME: home,
                KIRO_HOME: native,
                XDG_CONFIG_HOME: `${home}/xdg`,
                PATH: "/usr/bin:/bin",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (data) => {
              output += String(data);
            });
            child.stderr.resume();
            child.once("error", reject);
            child.once("close", (code) =>
              code === 0 ? resolve(output) : reject(new SyntheticWriterError({ cause: code })),
            );
          }),
        catch: (cause) => new SyntheticWriterError({ cause }),
      });
      expect(transcript).toBe("synthetic writer: one completed turn persisted\n");
      const reader = yield* makeKiroNativeHistory({
        HOME: home,
        KIRO_HOME: native,
        XDG_CONFIG_HOME: `${home}/xdg`,
      });
      const adapter = {
        instanceId: selection.instanceId,
        driver: ProviderDriverKind.make("kiro"),
        nativeHistory: { capture: reader.capture },
        openSession: () => Effect.die("Sync must not open or load a native session"),
      } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
      const importer = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
      const input = { threadId, projectId, instanceId: selection.instanceId };
      expect(yield* importer.syncNativeHistory(input)).toMatchObject({
        status: "busy",
        reason: "lease_present",
      });
      const lease = `${native}/session-leases/pipe-proof.lease`;
      expect(yield* fs.readFileString(lease)).toBe("synthetic foreign lease");
      // The fixture acts as the user releasing a lease; production never removes one.
      yield* fs.remove(lease);
      const synced = yield* importer.syncNativeHistory(input);
      expect(synced).toMatchObject({ status: "synced", addedItems: 3 });
      const reconstructed = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
      expect(yield* reconstructed.syncNativeHistory(input)).toMatchObject({
        status: "synced",
        addedItems: 0,
      });
      expect(yield* importer.syncNativeHistory(input)).toMatchObject({
        status: "synced",
        addedItems: 0,
      });
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        threadId,
        ["runs", "messages"],
      );
      expect(projection.runs).toHaveLength(0);
      expect(projection.messages.map((message) => message.text)).toEqual([
        "Synthetic CLI request",
        "Synthetic CLI answer",
      ]);
      const sourceState = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        threadId,
        ["providerThreads", "turnItems", "runtimeRequests"],
      );
      expect(sourceState.turnItems.map((item) => item.type)).toEqual([
        "user_message",
        "reasoning",
        "assistant_message",
      ]);
      expect(sourceState.runtimeRequests).toHaveLength(0);
      const bucket = (yield* fs.readDirectory(`${native}/sessions`))[0]!;
      const transcriptFile = `${native}/sessions/${bucket}/pipe-proof/messages.jsonl`;
      const saved = yield* fs.readFileString(transcriptFile);
      const uncertain = [
        {
          id: "unknown-user",
          timestamp: "2026-11-13T00:00:00.000Z",
          payload: {
            type: "user",
            content: "NEVER VISIBLE",
            _meta: { kiro: { unknownFraming: true } },
          },
        },
        {
          id: "unknown-end",
          timestamp: "2026-11-13T00:00:00.000Z",
          payload: { type: "turn_end", stopReason: "end_turn" },
        },
      ];
      yield* fs.writeFileString(
        transcriptFile,
        saved + uncertain.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      expect(yield* reconstructed.syncNativeHistory(input)).toMatchObject({
        status: "unsupported",
        addedItems: 0,
      });
      const afterUncertain = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        threadId,
        ["providerThreads", "turnItems"],
      );
      expect(afterUncertain.providerThreads[0]?.nativeMetadata?.nativeHistory).toEqual(
        sourceState.providerThreads[0]?.nativeMetadata?.nativeHistory,
      );
      expect(afterUncertain.turnItems).toEqual(sourceState.turnItems);
      yield* Effect.logInfo(
        "SYNTHETIC RUNTIME PROOF: Node pipe writer exited 0; lease blocked sync unchanged; fixture released lease; synced 3 items including reasoning into same owner; repeat added 0; native open/load/model calls 0; fake runs 0.",
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
