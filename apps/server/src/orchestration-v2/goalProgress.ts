import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";

export function goalProgressId(providerThread: OrchestrationV2ProviderThread): string {
  return JSON.stringify([
    providerThread.id,
    providerThread.goal?.id ?? providerThread.goal?.objective,
    providerThread.lastRunOrdinal,
  ]);
}

export function currentGoalProviderThread(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads">,
  caller: { readonly providerSessionId: string; readonly providerInstanceId: ProviderInstanceId },
) {
  if (projection.thread.deletedAt !== null) return undefined;
  return projection.providerThreads.find(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.providerSessionId === caller.providerSessionId &&
      thread.providerInstanceId === caller.providerInstanceId &&
      (thread.driver === "codex" || thread.driver === "claudeAgent") &&
      thread.status === "active" &&
      thread.goal?.status === "active",
  );
}
