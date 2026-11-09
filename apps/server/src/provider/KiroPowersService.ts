import {
  KiroPowersError,
  type KiroPowersInput,
  type KiroPowersInstallInput,
  type KiroPowersRemoveInput,
  type KiroPowersState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

export class KiroPowersService extends Context.Service<
  KiroPowersService,
  {
    readonly list: (input: KiroPowersInput) => Effect.Effect<KiroPowersState, KiroPowersError>;
    readonly install: (input: KiroPowersInstallInput) => Effect.Effect<void, KiroPowersError>;
    readonly remove: (input: KiroPowersRemoveInput) => Effect.Effect<void, KiroPowersError>;
  }
>()("t3/provider/KiroPowersService") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectService.ProjectService;
  const resolve = Effect.fn("KiroPowersService.resolve")(function* (input: KiroPowersInput) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError((cause) => new KiroPowersError({ code: "unavailable", cause })));
    const instance = yield* registry.getInstance(input.instanceId);
    if (
      Option.isNone(project) ||
      !instance?.enabled ||
      instance.driverKind !== "kiro" ||
      !instance.kiroPowers
    )
      return yield* new KiroPowersError({ code: "unavailable" });
    return { controller: instance.kiroPowers, cwd: project.value.workspaceRoot };
  });
  const list = Effect.fn("KiroPowersService.list")(function* (input: KiroPowersInput) {
    const { controller, cwd } = yield* resolve(input);
    return yield* controller.list(cwd);
  });
  const install = Effect.fn("KiroPowersService.install")(function* (input: KiroPowersInstallInput) {
    const { controller, cwd } = yield* resolve(input);
    yield* controller.install({ cwd, target: input.target });
  });
  const remove = Effect.fn("KiroPowersService.remove")(function* (input: KiroPowersRemoveInput) {
    const { controller, cwd } = yield* resolve(input);
    yield* controller.remove({ cwd, name: input.name });
  });
  return KiroPowersService.of({ list, install, remove });
});

export const layer = Layer.effect(KiroPowersService, make);
