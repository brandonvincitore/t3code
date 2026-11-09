import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const MemoryId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const MemoryScope = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?:Global|workspace:[^/\s]+|repo:[^/\s]+\/[^/\s]+(?:\/[^/\s]+)+)$/u),
);
const MemoryTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9-]+$/),
);
const MemorySummary = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(250));
const MemoryContent = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
const WritableMemoryType = Schema.Literals(["USER_PREFERENCE", "SEMANTIC"]);

export const KiroMemoryTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
});
export type KiroMemoryTarget = typeof KiroMemoryTarget.Type;
export const KiroMemoryListOptions = Schema.Struct({
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  scopes: Schema.optional(
    Schema.Array(Schema.Union([MemoryScope, Schema.Literal("UNKNOWN")])).check(
      Schema.isMaxLength(32),
    ),
  ),
  memoryTypes: Schema.optional(
    Schema.Array(Schema.Literals(["USER_PREFERENCE", "SEMANTIC", "UNKNOWN"])).check(
      Schema.isMaxLength(3),
    ),
  ),
});
export type KiroMemoryListOptions = typeof KiroMemoryListOptions.Type;
export const KiroMemoryListInput = Schema.Struct({
  ...KiroMemoryTarget.fields,
  ...KiroMemoryListOptions.fields,
});
export type KiroMemoryListInput = typeof KiroMemoryListInput.Type;
export const KiroMemoryGetInput = Schema.Struct({ ...KiroMemoryTarget.fields, id: MemoryId });
export type KiroMemoryGetInput = typeof KiroMemoryGetInput.Type;
export const KiroMemoryCreate = Schema.Struct({
  memoryType: WritableMemoryType,
  scopes: Schema.Array(MemoryScope).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  title: MemoryTitle,
  summary: MemorySummary,
  content: MemoryContent,
});
export type KiroMemoryCreate = typeof KiroMemoryCreate.Type;
export const KiroMemoryCreateInput = Schema.Struct({
  ...KiroMemoryTarget.fields,
  ...KiroMemoryCreate.fields,
});
export type KiroMemoryCreateInput = typeof KiroMemoryCreateInput.Type;
export const KiroMemoryUpdate = Schema.Struct({
  id: MemoryId,
  newTitle: Schema.optional(MemoryTitle),
  summary: Schema.optional(MemorySummary),
  content: Schema.optional(MemoryContent),
  memoryType: Schema.optional(WritableMemoryType),
  unresolvedConflict: Schema.optional(Schema.Boolean),
});
export type KiroMemoryUpdate = typeof KiroMemoryUpdate.Type;
export const KiroMemoryUpdateInput = Schema.Struct({
  ...KiroMemoryTarget.fields,
  ...KiroMemoryUpdate.fields,
});
export type KiroMemoryUpdateInput = typeof KiroMemoryUpdateInput.Type;

export const KiroMemoryEntry = Schema.Struct({
  id: MemoryId,
  memoryType: Schema.Literals(["USER_PREFERENCE", "SEMANTIC", "UNKNOWN"]),
  scopes: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(32)),
  title: Schema.String.check(Schema.isMaxLength(256)),
  summary: Schema.String.check(Schema.isMaxLength(2_000)),
  createdAt: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String.check(Schema.isMaxLength(128)),
  unresolvedConflict: Schema.optional(Schema.Boolean),
});
export type KiroMemoryEntry = typeof KiroMemoryEntry.Type;
export const KiroMemoryDetail = Schema.Struct({
  ...KiroMemoryEntry.fields,
  content: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type KiroMemoryDetail = typeof KiroMemoryDetail.Type;
export const KiroMemoryListResult = Schema.Struct({
  memories: Schema.Array(KiroMemoryEntry).check(Schema.isMaxLength(100)),
  nextCursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  total: NonNegativeInt,
  counts: Schema.Struct({
    byType: Schema.Record(Schema.String, NonNegativeInt),
    byScope: Schema.Record(Schema.String, NonNegativeInt),
  }),
});
export type KiroMemoryListResult = typeof KiroMemoryListResult.Type;
export const KiroMemoryGetResult = Schema.Struct({ memory: KiroMemoryDetail });
export type KiroMemoryGetResult = typeof KiroMemoryGetResult.Type;
export const KiroMemoryCreateResult = Schema.Struct({
  id: MemoryId,
  memory: Schema.optional(KiroMemoryDetail),
});
export type KiroMemoryCreateResult = typeof KiroMemoryCreateResult.Type;
export const KiroMemoryUpdateResult = Schema.Struct({ memory: Schema.optional(KiroMemoryDetail) });
export type KiroMemoryUpdateResult = typeof KiroMemoryUpdateResult.Type;
export const KiroMemoryDeleteResult = Schema.Struct({
  id: MemoryId,
  title: Schema.String.check(Schema.isMaxLength(256)),
});
export type KiroMemoryDeleteResult = typeof KiroMemoryDeleteResult.Type;
export const KiroMemorySyncStatus = Schema.Struct({
  state: Schema.Literals([
    "notStarted",
    "resolving",
    "off",
    "unavailable",
    "suspended",
    "syncing",
    "synced",
    "failed",
  ]),
  reason: Schema.optional(
    Schema.Literals([
      "notSignedIn",
      "teamKey",
      "notEntitled",
      "identityUnknown",
      "forbidden",
      "backendSignal",
      "sync",
      "storage",
    ]),
  ),
  lastSyncAt: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  pending: Schema.optional(NonNegativeInt),
});
export type KiroMemorySyncStatus = typeof KiroMemorySyncStatus.Type;

export class KiroMemoryError extends Schema.TaggedError<KiroMemoryError>()("KiroMemoryError", {
  code: Schema.Literals([
    "provider_unavailable",
    "project_unavailable",
    "unsupported",
    "invalid_input",
    "invalid_response",
    "operation_failed",
  ]),
}) {
  override get message(): string {
    switch (this.code) {
      case "provider_unavailable":
        return "This Kiro provider is no longer available.";
      case "project_unavailable":
        return "Choose an available project on the Kiro environment.";
      case "unsupported":
        return "This Kiro CLI does not advertise the requested memory operation.";
      case "invalid_input":
        return "Check the memory fields and try again. Titles use letters, digits, and hyphens, with at most 64 characters.";
      case "invalid_response":
        return "Kiro returned a memory response this client could not read.";
      case "operation_failed":
        return "Kiro could not complete this memory operation. Check that memory is enabled and your account has access, then refresh and try again.";
    }
  }
}

export interface KiroMemoryController {
  readonly list: (
    input: KiroMemoryListOptions & { readonly cwd: string },
  ) => Effect.Effect<KiroMemoryListResult, KiroMemoryError>;
  readonly get: (input: {
    readonly cwd: string;
    readonly id: string;
  }) => Effect.Effect<KiroMemoryGetResult, KiroMemoryError>;
  readonly create: (
    input: KiroMemoryCreate & { readonly cwd: string },
  ) => Effect.Effect<KiroMemoryCreateResult, KiroMemoryError>;
  readonly update: (
    input: KiroMemoryUpdate & { readonly cwd: string },
  ) => Effect.Effect<KiroMemoryUpdateResult, KiroMemoryError>;
  readonly delete: (input: {
    readonly cwd: string;
    readonly id: string;
  }) => Effect.Effect<KiroMemoryDeleteResult, KiroMemoryError>;
  readonly getSyncStatus: (input: {
    readonly cwd: string;
  }) => Effect.Effect<KiroMemorySyncStatus, KiroMemoryError>;
  readonly sync: (input: {
    readonly cwd: string;
  }) => Effect.Effect<KiroMemorySyncStatus, KiroMemoryError>;
}
