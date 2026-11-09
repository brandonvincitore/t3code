import type { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import type { KiroMemoryActions } from "./kiroMemory.ts";
import type { createServerEnvironmentAtoms } from "./state/server.ts";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./state/runtime.ts";

type Server = ReturnType<typeof createServerEnvironmentAtoms>;
type ResourceCommands = Pick<
  Server,
  | "kiroMemoryList"
  | "kiroMemoryGet"
  | "kiroMemoryCreate"
  | "kiroMemoryUpdate"
  | "kiroMemoryDelete"
  | "kiroMemoryGetSyncStatus"
  | "kiroMemorySync"
  | "kiroPowersList"
  | "kiroPowersInstall"
  | "kiroPowersRemove"
>;

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

export function makeKiroResourceActions(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly commands: ResourceCommands;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projectId: ProjectId;
}) {
  const { registry, commands, environmentId, instanceId, projectId } = input;
  const target = { instanceId, projectId };
  const options = { reportFailure: false, reportDefect: false };
  const memory: KiroMemoryActions = {
    list: (fields) =>
      runAtomCommand(
        registry,
        commands.kiroMemoryList,
        { environmentId, input: { ...target, ...fields } },
        options,
      ).then(unwrap),
    get: (id) =>
      runAtomCommand(
        registry,
        commands.kiroMemoryGet,
        { environmentId, input: { ...target, id } },
        options,
      ).then(unwrap),
    create: (fields) =>
      runAtomCommand(
        registry,
        commands.kiroMemoryCreate,
        { environmentId, input: { ...target, ...fields } },
        options,
      ).then(unwrap),
    update: (fields) =>
      runAtomCommand(
        registry,
        commands.kiroMemoryUpdate,
        { environmentId, input: { ...target, ...fields } },
        options,
      ).then(unwrap),
    delete: (id) =>
      runAtomCommand(
        registry,
        commands.kiroMemoryDelete,
        { environmentId, input: { ...target, id } },
        options,
      ).then(unwrap),
    getSyncStatus: () =>
      runAtomCommand(
        registry,
        commands.kiroMemoryGetSyncStatus,
        { environmentId, input: target },
        options,
      ).then(unwrap),
    sync: () =>
      runAtomCommand(
        registry,
        commands.kiroMemorySync,
        { environmentId, input: target },
        options,
      ).then(unwrap),
  };
  return {
    memory,
    powers: {
      list: () =>
        runAtomCommand(
          registry,
          commands.kiroPowersList,
          { environmentId, input: target },
          options,
        ).then(unwrap),
      install: (power: string) =>
        runAtomCommand(
          registry,
          commands.kiroPowersInstall,
          { environmentId, input: { ...target, target: power } },
          options,
        ).then(unwrap),
      remove: (name: string) =>
        runAtomCommand(
          registry,
          commands.kiroPowersRemove,
          { environmentId, input: { ...target, name } },
          options,
        ).then(unwrap),
    },
  };
}

export function makeKiroMcpActions(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly commands: Pick<
    Server,
    "kiroMcpStatus" | "kiroMcpBeginSignIn" | "kiroMcpTakeAuthorizationUrl" | "kiroMcpCancelSignIn"
  >;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { registry, commands, environmentId, threadId } = input;
  const options = { reportFailure: false, reportDefect: false };
  return {
    getStatus: () =>
      runAtomCommand(
        registry,
        commands.kiroMcpStatus,
        { environmentId, input: { threadId } },
        options,
      ).then(unwrap),
    beginSignIn: (serverName: string) =>
      runAtomCommand(
        registry,
        commands.kiroMcpBeginSignIn,
        { environmentId, input: { threadId, serverName } },
        options,
      ).then(unwrap),
    takeAuthorizationUrl: (attemptId: string) =>
      runAtomCommand(
        registry,
        commands.kiroMcpTakeAuthorizationUrl,
        { environmentId, input: { threadId, attemptId } },
        options,
      ).then(unwrap),
    cancelSignIn: (attemptId: string) =>
      runAtomCommand(
        registry,
        commands.kiroMcpCancelSignIn,
        { environmentId, input: { threadId, attemptId } },
        options,
      ).then(unwrap),
  };
}
