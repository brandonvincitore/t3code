import {
  AcpRegistryOperationError,
  CommandId,
  ThreadId,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDeleteSessionResult,
  type AcpRegistryListSessionsInput,
  type AcpRegistryListSessionsResult,
  type AcpRegistryImportSessionInput,
  type AcpRegistryImportSessionResult,
  type Project,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export const importedThreadId = (input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
}) =>
  IdAllocator.deriveThreadFromProviderThread({
    driver: input.driver,
    providerInstanceId: input.instanceId,
    nativeThreadId: input.sessionId,
  });

export class AcpRegistrySessions extends Context.Service<
  AcpRegistrySessions,
  {
    readonly project: (projectId: ProjectId) => Effect.Effect<Project, AcpRegistryOperationError>;
    readonly sessionManager: (instanceId: ProviderInstanceId) => Effect.Effect<
      {
        readonly instance: ProviderInstance;
        readonly manager: NonNullable<ProviderInstance["acpSessionManagement"]>;
      },
      AcpRegistryOperationError
    >;
    readonly listSessions: (
      input: AcpRegistryListSessionsInput,
    ) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly deleteSession: (
      input: AcpRegistryDeleteSessionInput,
    ) => Effect.Effect<AcpRegistryDeleteSessionResult, AcpRegistryOperationError>;
    /**
     * Binds a native ACP session to a T3 thread and copies its history in. Importing a
     * session whose thread still lacks its history repairs that thread instead.
     */
    readonly importSession: (
      input: AcpRegistryImportSessionInput,
    ) => Effect.Effect<AcpRegistryImportSessionResult, AcpRegistryOperationError>;
  }
>()("t3/provider/AcpRegistrySessions") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
  const random = yield* SecureRandom.SecureRandom;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;

  const project = Effect.fn("AcpRegistrySessions.project")(function* (projectId: ProjectId) {
    const found = yield* projectService.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} is unavailable.`,
            cause,
          }),
      ),
    );
    return yield* Effect.fromOption(
      found,
      () =>
        new AcpRegistryOperationError({
          reason: "project_not_found",
          message: `Project ${projectId} was not found.`,
        }),
    );
  });

  const sessionManager = Effect.fn("AcpRegistrySessions.sessionManager")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "instance_not_found",
        message: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance.acpSessionManagement === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: `Provider instance ${instanceId} does not expose ACP session management.`,
      });
    }
    return { instance, manager: instance.acpSessionManagement };
  });

  const owner = Effect.fn("AcpRegistrySessions.owner")(function* (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly sessionId: string;
  }) {
    const rows = yield* sql<{ readonly thread_id: string | null }>`
      SELECT COALESCE(owned.thread_id, node.thread_id) AS thread_id
      FROM orchestration_v2_projection_provider_threads AS owned
      LEFT JOIN orchestration_v2_projection_nodes AS node ON node.node_id = owned.owner_node_id
      WHERE owned.driver = ${input.driver}
        AND owned.provider_instance_id = ${input.instanceId}
        AND json_extract(owned.payload_json, '$.nativeThreadRef.nativeId') = ${input.sessionId}
      LIMIT 1
    `.pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not inspect the native ACP session owner.",
            cause,
          }),
      ),
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id) };
  });

  const inWorkspace = (
    session: AcpRegistryListSessionsResult["sessions"][number],
    workspaceRoot: string,
  ) => path.isAbsolute(session.cwd) && path.resolve(session.cwd) === path.resolve(workspaceRoot);

  const requireListed = Effect.fn("AcpRegistrySessions.requireListed")(function* (
    manager: NonNullable<ProviderInstance["acpSessionManagement"]>,
    workspaceRoot: string,
    sessionId: string,
    reason: "session_import_failed" | "session_delete_failed",
  ) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page += 1) {
      const listed = yield* manager.listSessions({
        cwd: workspaceRoot,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (
        listed.sessions.some(
          (session) => session.sessionId === sessionId && inWorkspace(session, workspaceRoot),
        )
      )
        return;
      const next = listed.nextCursor;
      if (next === null || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return yield* new AcpRegistryOperationError({
      reason,
      message:
        "The native ACP session is not available in this project's session list. Refresh the session browser and try again.",
    });
  });

  const listSessions = Effect.fn("AcpRegistrySessions.listSessions")(function* (
    input: AcpRegistryListSessionsInput,
  ) {
    const { workspaceRoot } = yield* project(input.projectId);
    const { instance, manager } = yield* sessionManager(input.instanceId);
    const listed = yield* manager.listSessions({
      cwd: workspaceRoot,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const sessions = yield* Effect.forEach(
      listed.sessions.filter((session) => inWorkspace(session, workspaceRoot)),
      (session) =>
        Effect.gen(function* () {
          const owned = yield* owner({
            driver: instance.driverKind,
            instanceId: input.instanceId,
            sessionId: session.sessionId,
          });
          const thread = owned?.threadId
            ? yield* threadManagement.getThreadShell(owned.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "session_import_failed",
                      message: "Could not inspect the native ACP session's T3 thread.",
                      cause,
                    }),
                ),
              )
            : null;
          return {
            ...session,
            importedThreadId: owned?.threadId ?? null,
            ...(thread !== null &&
            AgentSessionImporter.isNativeHistoryPending({
              historyOrigin: thread.historyOrigin,
              hasRun: thread.latestRunId !== null,
            })
              ? { nativeHistoryPending: true }
              : {}),
          };
        }),
      { concurrency: 16 },
    );
    return { ...listed, sessions };
  });

  const deleteSession = Effect.fn("AcpRegistrySessions.deleteSession")(function* (
    input: AcpRegistryDeleteSessionInput,
  ) {
    const { workspaceRoot } = yield* project(input.projectId);
    const { instance, manager } = yield* sessionManager(input.instanceId);
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.nativeSessions?.canDelete !== true)
      return yield* new AcpRegistryOperationError({
        reason: "session_delete_unsupported",
        message: "The ACP agent does not advertise session deletion.",
      });
    const ownership = {
      driver: instance.driverKind,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
    };
    const refuseOwned = Effect.fn("AcpRegistrySessions.refuseOwnedDeletion")(function* () {
      if ((yield* owner(ownership)) !== undefined)
        return yield* new AcpRegistryOperationError({
          reason: "session_delete_failed",
          message: "This native ACP session belongs to a T3 thread and cannot be deleted here.",
        });
    });
    yield* refuseOwned();
    yield* requireListed(manager, workspaceRoot, input.sessionId, "session_delete_failed");
    yield* refuseOwned();
    yield* manager.deleteSession({ cwd: workspaceRoot, sessionId: input.sessionId });
    return { deleted: true } as const;
  }, coordinator.withSessionMutation);

  const importSession = Effect.fn("AcpRegistrySessions.importSession")(function* (
    input: AcpRegistryImportSessionInput,
  ) {
    const { workspaceRoot } = yield* project(input.projectId);
    const { instance, manager } = yield* sessionManager(input.instanceId);
    const providerSnapshot = yield* instance.snapshot.getSnapshot;
    if (
      providerSnapshot.nativeSessions?.canLoad !== true &&
      providerSnapshot.nativeSessions?.canResume !== true
    ) {
      return yield* new AcpRegistryOperationError({
        reason: "session_resume_unsupported",
        message: "The ACP agent cannot load or resume native sessions.",
      });
    }
    yield* requireListed(manager, workspaceRoot, input.sessionId, "session_import_failed");
    const ownership = {
      driver: instance.driverKind,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
    };
    const owned = yield* owner(ownership);
    const threadId = importedThreadId({
      driver: instance.driverKind,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
    });
    if (owned !== undefined && owned.threadId !== threadId) {
      if (owned.threadId === null)
        return yield* new AcpRegistryOperationError({
          reason: "session_import_failed",
          message: "This native ACP session already belongs to unavailable T3 work.",
        });
      const existingOwner = yield* threadManagement.getThreadShell(owned.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not inspect the native ACP session's T3 thread.",
              cause,
            }),
        ),
      );
      if (existingOwner === null || existingOwner.deletedAt !== null)
        return yield* new AcpRegistryOperationError({
          reason: "session_import_failed",
          message: "This native ACP session already belongs to an unavailable T3 thread.",
        });
      return { threadId: owned.threadId, imported: false } as const;
    }
    const existing = yield* threadManagement.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not inspect the imported ACP session mapping.",
            cause,
          }),
      ),
    );
    if (existing !== null) {
      if (existing.deletedAt !== null)
        return yield* new AcpRegistryOperationError({
          reason: "session_import_failed",
          message: "This native ACP session already belongs to an unavailable T3 thread.",
        });
      if (existing.projectId !== input.projectId) return { threadId, imported: false } as const;
      const repairing = AgentSessionImporter.isNativeHistoryPending({
        historyOrigin: existing.historyOrigin,
        hasRun: existing.latestRunId !== null,
      });
      yield* agentSessionImporter.importNativeHistory({ threadId, workspaceRoot }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not import the ACP session history.",
              cause,
            }),
        ),
      );
      return { threadId, imported: repairing } as const;
    }

    const provider = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === input.instanceId,
    );
    const model =
      provider?.models.find((candidate) => candidate.isDefault)?.slug ??
      provider?.models[0]?.slug ??
      "default";
    const commandId = CommandId.make(yield* random.uuidV4());
    const launched = yield* Effect.result(
      startup.enqueueCommand(
        threadLaunch.launch({
          commandId,
          threadId,
          projectId: input.projectId,
          title: input.title ?? "Imported ACP session",
          modelSelection: { instanceId: input.instanceId, model },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          importedNativeThread: {
            ref: {
              driver: instance.driverKind,
              nativeId: input.sessionId,
              strength: "strong",
            },
            metadata: {
              itemIdentityVersion: 2,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
            },
          },
          createdBy: "user",
          creationSource: "web",
        }),
      ),
    );
    if (Result.isFailure(launched)) {
      const racedOwner = yield* owner(ownership);
      if (racedOwner?.threadId) return { threadId: racedOwner.threadId, imported: false } as const;
      const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not inspect the imported ACP session after launch failed.",
              cause,
            }),
        ),
      );
      if (racedImport !== null) return { threadId, imported: false } as const;
      return yield* new AcpRegistryOperationError({
        reason: "session_import_failed",
        message: "Could not create a T3 thread for the ACP session.",
        cause: launched.failure,
      });
    }
    // The thread is usable without its history, so a failed read only logs.
    yield* agentSessionImporter.importNativeHistory({ threadId, workspaceRoot }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not import ACP session history", {
          instanceId: input.instanceId,
          sessionId: input.sessionId,
          cause,
        }),
      ),
    );
    return { threadId, imported: true } as const;
  }, coordinator.withSessionMutation);

  return AcpRegistrySessions.of({
    project,
    sessionManager,
    listSessions,
    deleteSession,
    importSession,
  });
});

export const layer = Layer.effect(AcpRegistrySessions, make);
