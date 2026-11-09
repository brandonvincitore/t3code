import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const PowerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/),
);
export const KiroPowersInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
});
export type KiroPowersInput = typeof KiroPowersInput.Type;
export const KiroPowersInstallInput = Schema.Struct({
  ...KiroPowersInput.fields,
  target: TrimmedNonEmptyString.check(
    Schema.isMaxLength(4_096),
    Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
  ),
});
export type KiroPowersInstallInput = typeof KiroPowersInstallInput.Type;
export const KiroPowersRemoveInput = Schema.Struct({ ...KiroPowersInput.fields, name: PowerName });
export type KiroPowersRemoveInput = typeof KiroPowersRemoveInput.Type;
export const KiroPowersState = Schema.Struct({
  reported: Schema.Boolean,
  canInstall: Schema.Boolean,
  powers: Schema.Array(
    Schema.Struct({
      name: PowerName,
      description: Schema.String.check(Schema.isMaxLength(2_048)),
      scope: Schema.String.check(Schema.isMaxLength(128)),
      canRemove: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(256)),
});
export type KiroPowersState = typeof KiroPowersState.Type;

export class KiroPowersError extends Schema.TaggedError<KiroPowersError>()("KiroPowersError", {
  code: Schema.Literals([
    "unavailable",
    "unsupported",
    "invalid_target",
    "managed",
    "operation_failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "unavailable":
        return "Kiro Powers are unavailable for this project or provider instance.";
      case "unsupported":
        return "This Kiro version cannot report installed Powers.";
      case "invalid_target":
        return "Enter a catalog name or an absolute local path on the Kiro environment.";
      case "managed":
        return "Kiro policy manages these Powers. This operation is unavailable.";
      case "operation_failed":
        return "Kiro could not complete the Powers operation. Check the Kiro environment and try again.";
    }
  }
}

export interface KiroPowersController {
  readonly list: (cwd: string) => Effect.Effect<KiroPowersState, KiroPowersError>;
  readonly install: (input: {
    readonly cwd: string;
    readonly target: string;
  }) => Effect.Effect<void, KiroPowersError>;
  readonly remove: (input: {
    readonly cwd: string;
    readonly name: string;
  }) => Effect.Effect<void, KiroPowersError>;
}
