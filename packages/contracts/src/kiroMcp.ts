import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const AttemptId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const KiroMcpStatusInput = Schema.Struct({ threadId: ThreadId });
export type KiroMcpStatusInput = typeof KiroMcpStatusInput.Type;
export const KiroMcpBeginSignInInput = Schema.Struct({
  threadId: ThreadId,
  serverName: ServerName,
});
export type KiroMcpBeginSignInInput = typeof KiroMcpBeginSignInInput.Type;
export const KiroMcpAttemptInput = Schema.Struct({ threadId: ThreadId, attemptId: AttemptId });
export type KiroMcpAttemptInput = typeof KiroMcpAttemptInput.Type;
export const KiroMcpBeginSignInResult = Schema.Struct({ attemptId: AttemptId });
export type KiroMcpBeginSignInResult = typeof KiroMcpBeginSignInResult.Type;

// Only an owner-authorized, transient RPC response may carry this value.
export const KiroMcpAuthorizationResult = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(16_384)),
});
export type KiroMcpAuthorizationResult = typeof KiroMcpAuthorizationResult.Type;

export const KiroMcpStatus = Schema.Struct({
  reported: Schema.Boolean,
  canSignIn: Schema.Boolean,
  busy: Schema.Boolean,
  servers: Schema.Array(
    Schema.Struct({
      name: ServerName,
      status: Schema.Literals(["connected", "failed", "disabled", "pending"]),
      failedAuthorization: Schema.Boolean,
    }),
  ),
  attempt: Schema.NullOr(
    Schema.Struct({
      attemptId: AttemptId,
      serverName: ServerName,
      phase: Schema.Literals(["waiting_for_url", "authorization_ready", "connecting"]),
    }),
  ),
});
export type KiroMcpStatus = typeof KiroMcpStatus.Type;

export class KiroMcpError extends Schema.TaggedError<KiroMcpError>()("KiroMcpError", {
  code: Schema.Literals([
    "session_unavailable",
    "unsupported",
    "server_unavailable",
    "busy",
    "attempt_unavailable",
    "cancelled",
    "connection_failed",
  ]),
}) {
  override get message(): string {
    switch (this.code) {
      case "session_unavailable":
        return "Start a Kiro session in this thread to see its MCP servers.";
      case "unsupported":
        return "MCP sign-in is unavailable in this connection. Update Kiro CLI on its server and start a new session, then retry in T3. CLI MCP credentials are separate from T3.";
      case "server_unavailable":
        return "This server is no longer awaiting authorization in this session.";
      case "busy":
        return "Another MCP sign-in is still finishing in this Kiro session. Try again after it finishes.";
      case "attempt_unavailable":
        return "This sign-in is no longer available. Start a fresh sign-in.";
      case "cancelled":
        return "MCP sign-in was dismissed. The Kiro connection attempt may still finish.";
      case "connection_failed":
        return "Kiro could not complete the MCP connection. Refresh its status and try again.";
    }
  }
}

export interface KiroMcpController {
  readonly getStatus: (
    sessionId: string,
    ownerId: string,
  ) => Effect.Effect<KiroMcpStatus, KiroMcpError>;
  readonly beginSignIn: (input: {
    readonly sessionId: string;
    readonly serverName: string;
    readonly ownerId: string;
  }) => Effect.Effect<KiroMcpBeginSignInResult, KiroMcpError>;
  readonly takeAuthorizationUrl: (input: {
    readonly sessionId: string;
    readonly attemptId: string;
    readonly ownerId: string;
  }) => Effect.Effect<KiroMcpAuthorizationResult, KiroMcpError>;
  readonly cancelSignIn: (input: {
    readonly sessionId: string;
    readonly attemptId: string;
    readonly ownerId: string;
  }) => Effect.Effect<void, KiroMcpError>;
}
