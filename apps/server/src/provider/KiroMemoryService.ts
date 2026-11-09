import {
  KiroMemoryError,
  type KiroMemoryCreateInput,
  type KiroMemoryCreateResult,
  type KiroMemoryDeleteResult,
  type KiroMemoryGetInput,
  type KiroMemoryGetResult,
  type KiroMemoryListInput,
  type KiroMemoryListResult,
  type KiroMemorySyncStatus,
  type KiroMemoryTarget,
  type KiroMemoryUpdateInput,
  type KiroMemoryUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

export class KiroMemoryService extends Context.Service<
  KiroMemoryService,
  {
    readonly list: (
      input: KiroMemoryListInput,
    ) => Effect.Effect<KiroMemoryListResult, KiroMemoryError>;
    readonly get: (
      input: KiroMemoryGetInput,
    ) => Effect.Effect<KiroMemoryGetResult, KiroMemoryError>;
    readonly create: (
      input: KiroMemoryCreateInput,
    ) => Effect.Effect<KiroMemoryCreateResult, KiroMemoryError>;
    readonly update: (
      input: KiroMemoryUpdateInput,
    ) => Effect.Effect<KiroMemoryUpdateResult, KiroMemoryError>;
    readonly delete: (
      input: KiroMemoryGetInput,
    ) => Effect.Effect<KiroMemoryDeleteResult, KiroMemoryError>;
    readonly getSyncStatus: (
      input: KiroMemoryTarget,
    ) => Effect.Effect<KiroMemorySyncStatus, KiroMemoryError>;
    readonly sync: (
      input: KiroMemoryTarget,
    ) => Effect.Effect<KiroMemorySyncStatus, KiroMemoryError>;
  }
>()("t3/provider/KiroMemoryService") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const resolve = Effect.fn("KiroMemoryService.resolve")(function* (input: KiroMemoryTarget) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError(() => new KiroMemoryError({ code: "project_unavailable" })));
    if (Option.isNone(project)) return yield* new KiroMemoryError({ code: "project_unavailable" });
    const instance = yield* registry.getInstance(input.instanceId);
    if (!instance?.enabled || instance.driverKind !== "kiro" || !instance.kiroMemory)
      return yield* new KiroMemoryError({ code: "provider_unavailable" });
    return { controller: instance.kiroMemory, cwd: project.value.workspaceRoot };
  });

  const list = Effect.fn("KiroMemoryService.list")(function* ({
    instanceId,
    projectId,
    ...input
  }: KiroMemoryListInput) {
    const { controller, cwd } = yield* resolve({ instanceId, projectId });
    return yield* controller.list({ cwd, ...input });
  });
  const get = Effect.fn("KiroMemoryService.get")(function* (input: KiroMemoryGetInput) {
    const { controller, cwd } = yield* resolve(input);
    return yield* controller.get({ cwd, id: input.id });
  });
  const create = Effect.fn("KiroMemoryService.create")(function* ({
    instanceId,
    projectId,
    ...input
  }: KiroMemoryCreateInput) {
    const { controller, cwd } = yield* resolve({ instanceId, projectId });
    return yield* controller.create({ cwd, ...input });
  });
  const update = Effect.fn("KiroMemoryService.update")(function* ({
    instanceId,
    projectId,
    ...input
  }: KiroMemoryUpdateInput) {
    const { controller, cwd } = yield* resolve({ instanceId, projectId });
    return yield* controller.update({ cwd, ...input });
  });
  const remove = Effect.fn("KiroMemoryService.delete")(function* (input: KiroMemoryGetInput) {
    const { controller, cwd } = yield* resolve(input);
    return yield* controller.delete({ cwd, id: input.id });
  });
  const getSyncStatus = Effect.fn("KiroMemoryService.getSyncStatus")(function* (
    input: KiroMemoryTarget,
  ) {
    const { controller, cwd } = yield* resolve(input);
    return yield* controller.getSyncStatus({ cwd });
  });
  const sync = Effect.fn("KiroMemoryService.sync")(function* (input: KiroMemoryTarget) {
    const { controller, cwd } = yield* resolve(input);
    return yield* controller.sync({ cwd });
  });
  return KiroMemoryService.of({ list, get, create, update, delete: remove, getSyncStatus, sync });
});

export const layer = Layer.effect(KiroMemoryService, make);
