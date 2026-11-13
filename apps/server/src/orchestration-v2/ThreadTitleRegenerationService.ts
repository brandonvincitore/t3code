import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ServerSettingsError,
  type ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly synchronize: (input: {
      readonly threadId: ThreadId;
      readonly title: string;
      readonly updatedAt: string;
      readonly providerThreadId: ProviderThreadId;
    }) => Effect.Effect<void>;
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const synchronize: ThreadTitleRegenerationService["Service"]["synchronize"] = Effect.fn(
    "ThreadTitleRegenerationService.synchronize",
  )(
    function* (input) {
      const read = threads.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
      ]);
      const projection = yield* read;
      const thread = projection.thread;
      const providerThread = projection.providerThreads.find(
        (entry) => entry.id === input.providerThreadId,
      );
      if (
        !providerThread ||
        !providerThread.providerSessionId ||
        providerThread.ownerNodeId !== null ||
        providerThread.appThreadId !== thread.id ||
        providerThread.providerInstanceId !== thread.providerInstanceId ||
        providerThread.forkedFrom !== null ||
        thread.forkedFrom !== null ||
        thread.lineage.parentThreadId !== null ||
        thread.delegatedFrom != null ||
        thread.activeProviderThreadId !== providerThread.id
      )
        return;
      const runtime = yield* providerSessions.get(providerThread.providerSessionId);
      if (
        Option.isNone(runtime) ||
        !runtime.value.syncGeneratedTitle ||
        runtime.value.instanceId !== providerThread.providerInstanceId
      )
        return;
      const isCurrent = Effect.gen(function* () {
        const current = yield* read;
        const bound = current.providerThreads.find((entry) => entry.id === input.providerThreadId);
        const activeRuntime = yield* providerSessions.get(providerThread.providerSessionId!);
        return (
          Option.isSome(activeRuntime) &&
          activeRuntime.value === runtime.value &&
          current.thread.activeProviderThreadId === providerThread.id &&
          current.thread.providerInstanceId === providerThread.providerInstanceId &&
          current.thread.title === input.title &&
          current.thread.titleManuallySet !== true &&
          current.thread.titleRegeneration == null &&
          DateTime.formatIso(current.thread.updatedAt) === input.updatedAt &&
          bound?.providerSessionId === providerThread.providerSessionId &&
          bound?.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId
        );
      }).pipe(Effect.orElseSucceed(() => false));
      if (thread.titleManuallySet !== true && !(yield* isCurrent)) return;
      yield* runtime.value.syncGeneratedTitle({ appThread: thread, providerThread, isCurrent });
    },
    Effect.orElseSucceed(() => undefined),
  );

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      .pipe(Effect.asVoid);

  const messagesThroughRun = Effect.fn("ThreadTitleRegenerationService.messagesThroughRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const source = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      const ordinals = new Map(
        source.runs
          .filter((run) => run.status !== "rolled_back")
          .map((run) => [run.id, run.ordinal]),
      );
      const forkOrdinal = ordinals.get(runId) ?? -1;
      const messages = source.messages.filter((message) => {
        if (message.streaming) return false;
        if (message.runId === null) return source.thread.historyOrigin === "v1_import";
        return (ordinals.get(message.runId) ?? Infinity) <= forkOrdinal;
      });
      return { thread: source.thread, messages };
    },
  );

  // A fork starts with no messages of its own, so its subject lives in the history it inherited.
  const forkSource = Effect.fn("ThreadTitleRegenerationService.forkSource")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    let title: string | undefined;
    const history: Array<ReadonlyArray<OrchestrationV2ConversationMessage>> = [];
    let forkedFrom = thread.forkedFrom;
    while (forkedFrom?.type === "run") {
      const source = yield* messagesThroughRun(forkedFrom.threadId, forkedFrom.runId);
      history.push(source.messages);
      title ??= source.thread.title;
      forkedFrom = source.thread.forkedFrom;
    }
    const context = formatThreadTitleContext(history.reverse().flat());
    return title === undefined || context.message.length === 0
      ? undefined
      : { title, history: context.message };
  });

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | { readonly type: "complete"; readonly title?: string } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : {
                message: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
                attachments: message.attachments,
              };
      } else {
        context = formatThreadTitleContext(
          projection.messages.filter((message) => !message.streaming),
        );
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      // A deleted source should not cost the fork its title.
      const inherited = yield* forkSource(projection.thread).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      // Storage cleanup removes worktrees but keeps the path; CLIs cannot spawn in a missing cwd.
      const worktreePath = projection.thread.worktreePath;
      const worktreeExists =
        worktreePath !== null &&
        (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
      const result = yield* textGeneration.generateThreadTitle({
        cwd: worktreeExists ? worktreePath : project.value.workspaceRoot,
        message: context.message,
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        ...(inherited === undefined ? {} : { forkSource: inherited }),
        instructions: settings.threadTitleInstructions,
        modelSelection: settings.textGenerationModelSelection,
        projectId: projection.thread.projectId,
      });
      const generatedTitle = result.title.trim();
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const }
        : { type: "complete" as const, title: result.title };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
    });
  });

  return ThreadTitleRegenerationService.of({ execute, synchronize });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
