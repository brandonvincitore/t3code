// @effect-diagnostics nodeBuiltinImport:off - Deterministic row IDs are derived synchronously by this pure reconciliation function.
import * as NodeCrypto from "node:crypto";
import {
  TurnItemId,
  type NativeHistoryReceipt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { NativeHistoryCapture } from "@t3tools/provider-core/server/ProviderAdapter";

export function reconcileNativeHistory(
  capture: NativeHistoryCapture,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerTurns" | "attempts" | "turnItems"
  >,
  owner: OrchestrationV2ProviderThread,
) {
  const nativeId = owner.nativeThreadRef?.nativeId;
  if (!nativeId) return { status: "unsafe", reason: "binding_changed" } as const;
  const receipt = owner.nativeMetadata?.nativeHistory;
  if (
    receipt &&
    (receipt.source !== capture.source ||
      receipt.nativeThreadId !== owner.nativeThreadRef?.nativeId ||
      receipt.providerInstanceId !== owner.providerInstanceId ||
      receipt.rows.length > capture.rows.length ||
      receipt.rows.some(
        (row, i) => row.id !== capture.rows[i]?.id || row.digest !== capture.rows[i]?.digest,
      ))
  )
    return { status: "unsafe", reason: "source_changed" } as const;
  const nativeUsers = new Set(
    capture.rows.filter((row) => row.kind === "user").map((row) => row.id),
  );
  if (projection.runs.some((run) => run.status === "rolled_back"))
    return { status: "unsafe", reason: "source_changed" } as const;
  const turns = projection.providerTurns.filter((turn) => turn.providerThreadId === owner.id);
  const knownUsers = new Set<string>();
  const startedRuns = projection.runs.filter(
    (run) => run.providerThreadId === owner.id && run.startedAt !== null,
  );
  const latestRun = startedRuns.reduce((max, run) => Math.max(max, run.ordinal), 0);
  const mustJoin = receipt
    ? startedRuns.filter((run) => run.ordinal > receipt.coveredRunOrdinal)
    : startedRuns.filter((run) => run.ordinal === latestRun);
  for (const run of mustJoin) {
    const accepted = turns.filter((turn) =>
      projection.attempts.some(
        (attempt) =>
          attempt.id === turn.runAttemptId &&
          attempt.runId === run.id &&
          (attempt.nativeThreadId === undefined ||
            attempt.nativeThreadId === owner.nativeThreadRef?.nativeId),
      ),
    );
    if (
      accepted.length === 0 ||
      accepted.some(
        (turn) =>
          turn.status !== "completed" ||
          turn.nativeTurnRef?.driver !== "kiro" ||
          turn.nativeTurnRef.strength !== "strong" ||
          turn.nativeTurnRef.nativeId === null ||
          !nativeUsers.has(turn.nativeTurnRef.nativeId),
      )
    )
      return { status: "ambiguous", reason: "legacy_unanchored" } as const;
    for (const turn of accepted) knownUsers.add(turn.nativeTurnRef!.nativeId!);
  }
  let baselineRows = receipt?.baselineRows ?? 0;
  if (!receipt && (projection.turnItems.length > 0 || startedRuns.length > 0)) {
    const boundary = capture.rows.findLastIndex(
      (row) =>
        row.boundary === "end" && row.userRowId !== undefined && knownUsers.has(row.userRowId),
    );
    if (boundary < 0) return { status: "ambiguous", reason: "legacy_unanchored" } as const;
    baselineRows = boundary + 1;
  }
  const previous = receipt?.rows.length ?? baselineRows;
  const additions = capture.rows.flatMap((row, index) =>
    index >= previous &&
    row.kind !== "control" &&
    row.text?.trim() &&
    !knownUsers.has(row.userRowId ?? row.id)
      ? [
          {
            row,
            itemId: TurnItemId.make(
              `kiro-history:${NodeCrypto.createHash("sha256")
                .update(JSON.stringify([projection.thread.id, owner.id, capture.source, row.id]))
                .digest("hex")}`,
            ),
          },
        ]
      : [],
  );
  const mapped = new Map(additions.map((item) => [item.row.id, item.itemId]));
  const next: NativeHistoryReceipt = {
    version: 1,
    source: capture.source,
    nativeThreadId: nativeId,
    providerInstanceId: owner.providerInstanceId,
    baselineRows,
    coveredRunOrdinal: Math.max(receipt?.coveredRunOrdinal ?? 0, latestRun),
    rows: capture.rows.map((row, i) => ({
      id: row.id,
      digest: row.digest,
      ...(receipt?.rows[i]?.itemId
        ? { itemId: receipt.rows[i]!.itemId }
        : mapped.has(row.id)
          ? { itemId: mapped.get(row.id)! }
          : {}),
    })),
  };
  return {
    status: "ready",
    additions,
    receipt: next,
    changed: previous !== capture.rows.length || receipt === undefined,
  } as const;
}
