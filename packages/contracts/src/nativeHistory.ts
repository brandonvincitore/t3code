import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnItemId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NativeHistorySyncInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  checkOnly: Schema.optionalKey(Schema.Boolean),
});
export type NativeHistorySyncInput = typeof NativeHistorySyncInput.Type;

export const NativeHistorySyncResult = Schema.Struct({
  status: Schema.Literals([
    "synced",
    "updates_available",
    "busy",
    "unsafe",
    "ambiguous",
    "unsupported",
    "unavailable",
  ]),
  reason: Schema.Literals([
    "captured",
    "lease_present",
    "thread_busy",
    "source_changed",
    "incomplete",
    "invalid_source",
    "legacy_unanchored",
    "binding_changed",
    "unsupported",
    "unavailable",
  ]),
  addedItems: NonNegativeInt,
  baselineRows: NonNegativeInt,
});
export type NativeHistorySyncResult = typeof NativeHistorySyncResult.Type;

export class NativeHistoryReadError extends Schema.TaggedError<NativeHistoryReadError>()(
  "NativeHistoryReadError",
  {
    status: NativeHistorySyncResult.fields.status,
    reason: NativeHistorySyncResult.fields.reason,
  },
) {}

export const NativeHistoryReceipt = Schema.Struct({
  version: Schema.Literal(1),
  source: TrimmedNonEmptyString,
  nativeThreadId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  baselineRows: NonNegativeInt,
  coveredRunOrdinal: NonNegativeInt,
  rows: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      digest: TrimmedNonEmptyString,
      itemId: Schema.optionalKey(TurnItemId),
    }),
  ).check(Schema.isMaxLength(4_096)),
});
export type NativeHistoryReceipt = typeof NativeHistoryReceipt.Type;
