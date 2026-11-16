import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PROCESS_IDENTITY_UNAVAILABLE_MESSAGE =
  "T3's native process identity helper is missing or incompatible. Rebuild T3 with Rust installed, or reinstall a complete T3 build, then restart T3.";

export class ProviderProcessIdentityUnavailableError extends Schema.TaggedError<ProviderProcessIdentityUnavailableError>()(
  "ProviderProcessIdentityUnavailableError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return PROCESS_IDENTITY_UNAVAILABLE_MESSAGE;
  }
}

export class ProviderDriverError extends Schema.TaggedError<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

export class ProviderCredentialError extends Schema.TaggedError<ProviderCredentialError>()(
  "ProviderCredentialError",
  {
    operation: Schema.Literals(["get", "set", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} stored provider credentials.`;
  }
}
