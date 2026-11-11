import { TurnItemId, type ThreadId } from "@t3tools/contracts";

export const agentSessionImportTurnItemId = (threadId: ThreadId, index: number): TurnItemId =>
  TurnItemId.make(
    `agent-session-import:v2:turn-item:${threadId}:${String(index).padStart(6, "0")}`,
  );
