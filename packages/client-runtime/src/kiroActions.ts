import type { NativeHistorySyncResult } from "@t3tools/contracts";
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

export function nativeHistorySyncMessage(result: NativeHistorySyncResult): string {
  switch (result.status) {
    case "synced":
      return result.baselineRows > 0
        ? `Synced ${result.addedItems} new items since the verified T3 turn. Earlier history was not reimported.`
        : `Native snapshot synced (${result.addedItems} new items).`;
    case "updates_available":
      return "Native history has updates. Choose Sync from Kiro to copy them into this thread.";
    case "busy":
      return result.reason === "lease_present"
        ? "Kiro's session lease is present or uncertain. Release or clear it in Kiro, then retry. T3 has not changed the lease."
        : "The thread or native history is busy. Wait for it to finish, then retry.";
    case "ambiguous":
      return "This older thread has no verified native history boundary. Continue using Kiro, or start a new T3 conversation with selected context; the existing history has been kept.";
    case "unsafe":
      return "Native history changed or cannot be read safely. The existing thread has been kept. Continue in Kiro or start a new T3 conversation with selected context.";
    case "unsupported":
      return "Safe native history sync is unavailable for this provider, server platform or history format.";
    case "unavailable":
      return "Native history is unavailable in this environment. Check the provider and project, then retry.";
  }
}
