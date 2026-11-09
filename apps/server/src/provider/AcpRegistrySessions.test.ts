import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AcpRegistryListSessionsResult,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as AcpRegistrySessions from "./AcpRegistrySessions.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const projectId = ProjectId.make("native-session-project");
const instanceId = ProviderInstanceId.make("kiro");
const driver = ProviderDriverKind.make("kiro");
const target = { projectId, instanceId, sessionId: "native-session" };
const cwd = "/workspace/project";
const nativeSession = {
  sessionId: target.sessionId,
  cwd,
  additionalDirectories: [],
  title: null,
  updatedAt: null,
  importedThreadId: null,
};
const page: AcpRegistryListSessionsResult = {
  sessions: [nativeSession],
  nextCursor: null,
  canLoad: true,
  canResume: false,
  canDelete: true,
};

const setup = Effect.fn("test.AcpRegistrySessions.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const calls = { launches: 0, imports: 0, deletions: 0, cursors: [] as Array<string | undefined> };
  const pages = new Map<string | undefined, AcpRegistryListSessionsResult>([[undefined, page]]);
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const snapshot = {
    nativeSessions: { canList: true, canLoad: true, canResume: false, canDelete: true },
  } as ServerProvider;
  const instance = {
    instanceId,
    driverKind: driver,
    snapshot: { getSnapshot: Effect.succeed(snapshot) },
    acpSessionManagement: {
      listSessions: ({ cursor }: { readonly cwd: string; readonly cursor?: string }) =>
        Effect.sync(() => {
          calls.cursors.push(cursor);
          return pages.get(cursor) ?? { ...page, sessions: [] };
        }),
      deleteSession: () =>
        Effect.sync(() => {
          calls.deletions += 1;
        }),
    },
  } as unknown as ProviderInstance;
  const context = yield* Layer.build(
    AcpRegistrySessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService, {
            getById: () => Effect.succeedSome({ id: projectId, workspaceRoot: cwd } as Project),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: () => Effect.succeed(instance),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry, { getProviders: Effect.succeed([]) }),
          AcpRegistryRuntimeCoordinator.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService, {
            getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService, {
            launch: (input) =>
              Effect.gen(function* () {
                calls.launches += 1;
                return yield* new ThreadLaunchService.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: input.commandId,
                  projectId,
                  cause: new Error("Unexpected thread launch"),
                });
              }),
          }),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup, {
            enqueueCommand: (effect) => effect,
          }),
          Layer.mock(AgentSessionImporter.AgentSessionImporter, {
            importNativeHistory: () =>
              Effect.sync(() => {
                calls.imports += 1;
                return 0;
              }),
          }),
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size)),
          ),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );
  const service = yield* Effect.service(AcpRegistrySessions.AcpRegistrySessions).pipe(
    Effect.provide(context),
  );
  const seedOwner = Effect.fn("test.AcpRegistrySessions.seedOwner")(function* (
    ownerId: ThreadId,
    providerInstanceId = instanceId,
    deleted = false,
  ) {
    shells.set(ownerId, {
      id: ownerId,
      projectId,
      historyOrigin: "native",
      latestRunId: RunId.make("existing-run"),
      deletedAt: deleted ? "2026-11-09T00:00:00.000Z" : null,
    } as OrchestrationV2ThreadShell);
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id, provider_session_id, status, updated_at, payload_json)
      VALUES (${`provider:${ownerId}`}, ${ownerId}, NULL, ${providerInstanceId}, ${driver}, ${providerInstanceId}, NULL, 'idle', '2026-11-09T00:00:00.000Z',
        ${JSON.stringify({ nativeThreadRef: { nativeId: target.sessionId } })})
    `;
  });
  return { service, calls, pages, shells, seedOwner };
});

describe("ACP native session ownership", () => {
  it.effect(
    "recognizes ordinary T3-owned native sessions without creating a duplicate import",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const owner = ThreadId.make("ordinary-t3-thread");
        yield* h.seedOwner(owner);
        const result = yield* Effect.result(h.service.importSession(target));
        assert.ok(Result.isSuccess(result));
        assert.deepEqual(result.success, { threadId: owner, imported: false });
        assert.equal(h.calls.launches, 0);
        assert.equal(h.calls.imports, 0);
        const listed = yield* h.service.listSessions({ instanceId, projectId });
        assert.equal(listed.sessions[0]?.importedThreadId, owner);
        assert.equal(
          (yield* h.service.deleteSession(target).pipe(Effect.flip)).reason,
          "session_delete_failed",
        );
        h.shells.delete(owner);
        assert.equal(
          (yield* h.service.deleteSession(target).pipe(Effect.flip)).reason,
          "session_delete_failed",
        );
        assert.equal(h.calls.deletions, 0);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("validates paged project membership before repairing or creating a thread", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const imported = AcpRegistrySessions.importedThreadId({
        driver,
        instanceId,
        sessionId: target.sessionId,
      });
      h.shells.set(imported, {
        id: imported,
        projectId,
        historyOrigin: "native",
        latestRunId: null,
        deletedAt: null,
      } as OrchestrationV2ThreadShell);
      h.pages.set(undefined, { ...page, sessions: [], nextCursor: "second" });
      h.pages.set("second", { ...page, sessions: [{ ...nativeSession, cwd: "/workspace/other" }] });
      const denied = yield* h.service.importSession(target).pipe(Effect.flip);
      assert.equal(denied.reason, "session_import_failed");
      assert.equal(h.calls.imports, 0);
      assert.equal(h.calls.launches, 0);
      h.pages.set("second", page);
      assert.deepEqual(yield* h.service.importSession(target), {
        threadId: imported,
        imported: true,
      });
      assert.equal(h.calls.imports, 1);
      h.pages.set(undefined, { ...page, sessions: [], nextCursor: "loop" });
      h.pages.set("loop", { ...page, sessions: [], nextCursor: "loop" });
      assert.equal(
        (yield* h.service.importSession(target).pipe(Effect.flip)).reason,
        "session_import_failed",
      );
      assert.equal(h.calls.imports, 1);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
  );
});
