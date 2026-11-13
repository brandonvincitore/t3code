import { reconcileNativeHistory } from "./nativeHistoryReconciliation.ts";
import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import { type NativeHistorySyncInput, type NativeHistorySyncResult } from "@t3tools/contracts";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import { agentSessionImportTurnItemId } from "./agentSessionImportIds.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
  readonly itemId?: TurnItemId;
  readonly nativeRowId?: string;
  readonly status?: "completed" | "interrupted";
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(input.itemId ?? `${input.threadId}:${suffix}`);
  const turnItemId = input.itemId ?? agentSessionImportTurnItemId(input.threadId, input.index);
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef:
      input.nativeRowId === undefined
        ? null
        : {
            driver: ProviderDriverKind.make("kiro"),
            nativeId: input.nativeRowId,
            strength: "strong" as const,
          },
    parentItemId: null,
    ordinal,
    status: input.status ?? ("completed" as const),
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = AgentSessionScanner.decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "claudeAgent"
                  ? { threadId, resume: thread.providerSessionId }
                  : { threadId: nativeThreadId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            // Other recorded transcripts mean this one changed after the import, and the
            // thread does not hold its new messages, so it must stay unrecorded.
            const recorded = Option.flatMap(yield* runtimes.getByThreadId({ threadId }), (row) =>
              AgentSessionScanner.decodeImportedTranscriptPayload(row.runtimePayload),
            ).pipe(Option.flatMapNullishOr((payload) => payload.importedTranscripts));
            if (
              Option.isSome(recorded) &&
              recorded.value.length > 0 &&
              !recorded.value.some((imported) =>
                AgentSessionScanner.sameTranscriptIdentity(imported, source),
              )
            ) {
              return false;
            }
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...(thread.omittedMessageCount > 0
                ? [
                    {
                      id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                      type: "turn-item.updated" as const,
                      threadId,
                      occurredAt: createdAt,
                      payload: {
                        id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                        threadId,
                        runId: null,
                        nodeId: null,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 0,
                        status: "completed" as const,
                        title: null,
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                      },
                    },
                  ]
                : []),
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  const syncNativeHistory = Effect.fn("AgentSessionImporter.syncNativeHistory")(
    function* (input: NativeHistorySyncInput) {
      const result = (
        status: NativeHistorySyncResult["status"],
        reason: NativeHistorySyncResult["reason"],
        addedItems = 0,
        baselineRows = 0,
      ): NativeHistorySyncResult => ({ status, reason, addedItems, baselineRows });
      const read = () =>
        orchestrator.getThreadRecords(input.threadId, [
          "providerThreads",
          "runs",
          "providerTurns",
          "attempts",
          "turnItems",
        ]);
      const initial = yield* read().pipe(Effect.option);
      if (Option.isNone(initial)) return result("unavailable", "unavailable");
      if (
        initial.value.thread.projectId !== input.projectId ||
        initial.value.thread.modelSelection.instanceId !== input.instanceId
      )
        return result("unsafe", "binding_changed");
      const selectedOwner = initial.value.providerThreads.find(
        (owner) => owner.id === initial.value.thread.activeProviderThreadId,
      );
      if (selectedOwner && selectedOwner.driver !== "kiro")
        return result("unsupported", "unsupported");
      const currentOwner = (records: typeof initial.value) =>
        records.providerThreads.find(
          (owner) =>
            records.thread.deletedAt === null &&
            records.thread.projectId === input.projectId &&
            records.thread.modelSelection.instanceId === input.instanceId &&
            owner.id === records.thread.activeProviderThreadId &&
            owner.appThreadId === input.threadId &&
            owner.ownerNodeId === null &&
            owner.providerInstanceId === input.instanceId &&
            owner.driver === "kiro" &&
            owner.nativeThreadRef?.driver === "kiro" &&
            owner.nativeThreadRef.strength === "strong",
        );
      const owner = currentOwner(initial.value);
      const nativeId = owner?.nativeThreadRef?.nativeId;
      if (!owner || !nativeId) return result("unsafe", "binding_changed");
      if (
        initial.value.runs.some(isActiveRun) ||
        owner.status === "active" ||
        (owner.pendingBackgroundTasks?.length ?? 0) > 0
      )
        return result("busy", "thread_busy");
      const project = yield* projects.getById(input.projectId).pipe(Effect.option);
      if (
        Option.isNone(project) ||
        Option.isNone(project.value) ||
        project.value.value.deletedAt !== null
      )
        return result("unavailable", "unavailable");
      const workspaceRoot = project.value.value.workspaceRoot;
      const cwd = initial.value.thread.worktreePath ?? workspaceRoot;
      const adapter = yield* registry.get(input.instanceId).pipe(Effect.option);
      if (
        Option.isNone(adapter) ||
        adapter.value.driver !== "kiro" ||
        adapter.value.instanceId !== input.instanceId ||
        !adapter.value.nativeHistory
      )
        return result("unsupported", "unsupported");
      const metadata = yield* registry.getMetadata?.(input.instanceId) ?? Effect.undefined;
      if (metadata?.enabled === false) return result("unavailable", "unavailable");
      const reader = adapter.value.nativeHistory;
      const capture = yield* reader.capture({ cwd, nativeId });
      const verified = yield* reader.capture({ cwd, nativeId });
      if (capture.identity !== verified.identity || capture.source !== verified.source)
        return result("busy", "source_changed");
      return yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* read();
          const currentAdapter = yield* registry.get(input.instanceId);
          const currentProject = yield* projects.getById(input.projectId);
          const currentMetadata = yield* (
            registry.getMetadata?.(input.instanceId) ?? Effect.undefined
          );
          if (
            Option.isNone(currentProject) ||
            currentProject.value.deletedAt !== null ||
            currentProject.value.workspaceRoot !== workspaceRoot ||
            currentMetadata?.enabled === false
          )
            return result("unsafe", "binding_changed");
          const active = currentOwner(current);
          if (
            !active ||
            active.id !== owner.id ||
            active.nativeThreadRef?.nativeId !== owner.nativeThreadRef?.nativeId ||
            current.thread.worktreePath !== initial.value.thread.worktreePath ||
            currentAdapter.driver !== "kiro" ||
            currentAdapter.instanceId !== input.instanceId ||
            currentAdapter.nativeHistory !== reader
          )
            return result("unsafe", "binding_changed");
          if (
            current.runs.some(isActiveRun) ||
            active.status === "active" ||
            (active.pendingBackgroundTasks?.length ?? 0) > 0
          )
            return result("busy", "thread_busy");
          const plan = reconcileNativeHistory(capture, current, active);
          if (plan.status !== "ready") return result(plan.status, plan.reason);
          if (input.checkOnly)
            return result(
              plan.changed ? "updates_available" : "synced",
              "captured",
              0,
              plan.receipt.baselineRows,
            );
          if (!plan.changed) return result("synced", "captured", 0, plan.receipt.baselineRows);
          const at = yield* DateTime.now;
          const ordinal = current.turnItems.reduce((max, item) => Math.max(max, item.ordinal), 0);
          const events = plan.additions.flatMap(({ row, itemId }, index) =>
            messageEvents({
              threadId: input.threadId,
              itemId,
              nativeRowId: row.id,
              ...(row.status === undefined ? {} : { status: row.status }),
              index: ordinal + index,
              message: {
                role: row.kind === "control" ? "assistant" : row.kind,
                text: row.text!,
                createdAt: row.timestamp,
              },
            }),
          );
          const committed = yield* eventSink.writeIfProviderThreadUnchanged({
            expected: active,
            updateNativeHistory: true,
            runlessItemRunOrdinal: current.runs.reduce(
              (max, run) => (run.startedAt === null ? max : Math.max(max, run.ordinal)),
              0,
            ),
            events: [
              ...events,
              {
                id: EventId.make(`kiro-history:${input.threadId}:${capture.identity}`),
                type: "provider-thread.updated",
                threadId: input.threadId,
                providerInstanceId: input.instanceId,
                occurredAt: at,
                payload: {
                  ...active,
                  nativeMetadata: { ...active.nativeMetadata, nativeHistory: plan.receipt },
                },
              },
              {
                id: EventId.make(`kiro-history-thread:${input.threadId}:${capture.identity}`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                occurredAt: at,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return committed.committed
            ? result("synced", "captured", plan.additions.length, plan.receipt.baselineRows)
            : result("unsafe", "binding_changed");
        }),
      );
    },
    Effect.catchTags({
      NativeHistoryReadError: (error) =>
        Effect.succeed({
          status: error.status,
          reason: error.reason,
          addedItems: 0,
          baselineRows: 0,
        } satisfies NativeHistorySyncResult),
    }),
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
  );

  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const bound = yield* orchestrator.getThreadRecords(input.threadId, ["providerThreads"]);
    const owner = bound.providerThreads.find(
      (owner) => owner.id === bound.thread.activeProviderThreadId,
    );
    if (owner?.driver === "kiro") {
      return (yield* syncNativeHistory({
        threadId: input.threadId,
        projectId: bound.thread.projectId,
        instanceId: owner.providerInstanceId,
      })).addedItems;
    }
    const pendingThread = Effect.map(
      orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
      (records) =>
        isNativeHistoryPending({
          historyOrigin: records.thread.historyOrigin,
          hasRun: records.runs.length > 0,
        })
          ? records
          : null,
    );
    // Thread commands write whole thread rows, so hold their lock from the
    // re-read through the write to keep both this marker and their changes.
    const commit = (
      messages: ReadonlyArray<HistoryMessage>,
      source: OrchestrationV2ProviderThread,
      nativeThreadId: string,
    ) =>
      threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          const owner = current.providerThreads.find((candidate) => candidate.id === source.id);
          if (
            owner === undefined ||
            current.thread.activeProviderThreadId !== owner.id ||
            current.thread.modelSelection.instanceId !== source.providerInstanceId ||
            owner.driver !== source.driver ||
            owner.providerInstanceId !== source.providerInstanceId ||
            owner.nativeThreadRef?.driver !== source.nativeThreadRef?.driver ||
            owner.nativeThreadRef?.nativeId !== source.nativeThreadRef?.nativeId
          )
            return 0;
          yield* eventSink.write({
            events: [
              ...messages.flatMap((message, index) =>
                messageEvents({ threadId: input.threadId, index, message }),
              ),
              {
                id: EventId.make(
                  `${IMPORT_EVENT_PREFIX}:provider-thread:${owner.id}:native-history`,
                ),
                type: "provider-thread.updated",
                threadId: input.threadId,
                providerInstanceId: owner.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...owner,
                  nativeMetadata: {
                    ...owner.nativeMetadata,
                    importedHistory: {
                      driver: source.driver,
                      providerInstanceId: source.providerInstanceId,
                      nativeThreadId,
                      itemCount: messages.length,
                    },
                  },
                },
              },
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return messages.length;
        }),
      );
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find(
      (candidate) =>
        candidate.id === thread.activeProviderThreadId &&
        candidate.appThreadId === input.threadId &&
        candidate.providerInstanceId === thread.modelSelection.instanceId &&
        candidate.nativeThreadRef !== null,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || nativeThreadId == null) return 0;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    if (
      snapshot.providerThread.id !== providerThread.id ||
      snapshot.providerThread.driver !== providerThread.driver ||
      snapshot.providerThread.providerInstanceId !== providerThread.providerInstanceId ||
      snapshot.providerThread.nativeThreadRef?.driver !== providerThread.nativeThreadRef?.driver ||
      snapshot.providerThread.nativeThreadRef?.nativeId !== nativeThreadId
    )
      return 0;
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* commit(messages, providerThread, nativeThreadId);
  });

  return { importRecentAgentThreads, importNativeHistory, syncNativeHistory };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
