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

export const ProviderSessionAccessReason = Schema.Literals([
  "held",
  "unknown",
  "locked",
  "changed",
  "invalid",
  "unavailable",
  "active",
]);
export type ProviderSessionAccessReason = typeof ProviderSessionAccessReason.Type;

const SESSION_ACCESS_MESSAGES: Record<ProviderSessionAccessReason, string> = {
  held: "This native conversation is held by another client. Close it there before retrying.",
  unknown:
    "This native conversation could not be found. Select an existing conversation or start a new thread.",
  locked:
    "This native conversation is temporarily locked. Wait for the other operation to finish, then retry.",
  changed:
    "This native conversation changed while it was being opened. Retry to load its current state.",
  invalid:
    "This native conversation cannot be opened with the current configuration. Check the provider settings or start a new thread.",
  unavailable:
    "Native conversation access is unavailable. Check the provider setup and restart T3 before retrying.",
  active:
    "This native conversation has an active turn. Wait for it to finish or stop it before retrying.",
};

export class ProviderSessionAccessError extends Schema.TaggedError<ProviderSessionAccessError>()(
  "ProviderSessionAccessError",
  { reason: ProviderSessionAccessReason, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return SESSION_ACCESS_MESSAGES[this.reason];
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
