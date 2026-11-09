import { AcpRegistryListSessionsResult, AcpRegistryOperationError } from "@t3tools/contracts";
import type { KiroSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Acp from "effect-acp/compat";
import { makeKiroAcpRuntime } from "./acpSupport.ts";

const decodeSource = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({ source: Schema.optional(Schema.Unknown) }),
  }),
);

function isLocalSession(
  session: Acp.ListSessionsResponse["sessions"][number],
  cwd: string,
  path: Path.Path,
) {
  const source = Option.getOrUndefined(decodeSource(session._meta))?.kiro.source;
  if (source !== undefined && source !== "local") return false;
  return path.isAbsolute(session.cwd) && path.resolve(session.cwd) === path.resolve(cwd);
}

export function kiroSessionCapabilities(initialized: Acp.InitializeResponse) {
  const capabilities = initialized.agentCapabilities;
  return {
    canList: capabilities?.sessionCapabilities?.list != null,
    canLoad: capabilities?.loadSession === true,
    canResume: capabilities?.sessionCapabilities?.resume != null,
    canDelete: capabilities?.sessionCapabilities?.delete != null,
  };
}

interface ManagementInput {
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

const managementFailure = (operation: "list" | "delete", cause: unknown) =>
  new AcpRegistryOperationError({
    reason: operation === "list" ? "probe_failed" : "session_delete_failed",
    message:
      operation === "list" ? "Could not list Kiro sessions." : "Could not delete the Kiro session.",
    cause,
  });

/** Discovery initializes ACP without opening, loading, or creating a native session. */
export const listKiroSessions = Effect.fn("KiroSessions.list")(
  function* (input: ManagementInput & { readonly cursor?: string }) {
    const path = yield* Path.Path;
    if (!input.settings.enabled)
      return yield* new AcpRegistryOperationError({
        reason: "agent_not_configured",
        message: "Kiro is disabled in T3 Code settings.",
      });
    const runtime = yield* makeKiroAcpRuntime({
      settings: input.settings,
      environment: input.environment,
      cwd: input.cwd,
      authenticateOnAuthRequired: false,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "t3-code-session-browser", version: "0.0.0" },
    });
    const initialized = yield* runtime.initialize();
    const capabilities = kiroSessionCapabilities(initialized);
    if (!capabilities.canList)
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: "Kiro does not advertise session listing.",
      });
    const listed = yield* runtime.listSessions(input.cursor);
    return AcpRegistryListSessionsResult.make({
      sessions: listed.sessions
        .filter((session) => isLocalSession(session, input.cwd, path))
        .slice(0, 256)
        .flatMap((session) => {
          if (
            !session.sessionId ||
            session.sessionId !== session.sessionId.trim() ||
            session.sessionId.length > 1_024 ||
            session.cwd.length > 4_096
          )
            return [];
          return [
            {
              sessionId: session.sessionId,
              cwd: session.cwd,
              additionalDirectories: (session.additionalDirectories ?? [])
                .filter((directory) => directory.trim().length > 0 && directory.length <= 4_096)
                .slice(0, 32),
              title: session.title?.trim().slice(0, 1_024) || null,
              updatedAt: session.updatedAt?.trim().slice(0, 128) || null,
              importedThreadId: null,
            },
          ];
        }),
      nextCursor: listed.nextCursor?.trim().slice(0, 2_048) || null,
      canLoad: capabilities.canLoad,
      canResume: capabilities.canResume,
      canDelete: capabilities.canDelete,
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(managementFailure("list", undefined)),
      }),
      Effect.mapError((cause) =>
        cause._tag === "AcpRegistryOperationError" ? cause : managementFailure("list", cause),
      ),
    ),
);

export const deleteKiroSession = Effect.fn("KiroSessions.delete")(
  function* (input: ManagementInput & { readonly sessionId: string }) {
    const path = yield* Path.Path;
    if (!input.settings.enabled)
      return yield* new AcpRegistryOperationError({
        reason: "agent_not_configured",
        message: "Kiro is disabled in T3 Code settings.",
      });
    const runtime = yield* makeKiroAcpRuntime({
      settings: input.settings,
      environment: input.environment,
      cwd: input.cwd,
      authenticateOnAuthRequired: false,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "t3-code-session-browser", version: "0.0.0" },
    });
    const capabilities = kiroSessionCapabilities(yield* runtime.initialize());
    if (!capabilities.canDelete || !capabilities.canList)
      return yield* new AcpRegistryOperationError({
        reason: "session_delete_unsupported",
        message: "Kiro does not advertise scoped session deletion.",
      });
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 32; page += 1) {
      const listed = yield* runtime.listSessions(cursor);
      if (
        listed.sessions.some(
          (session) =>
            session.sessionId === input.sessionId && isLocalSession(session, input.cwd, path),
        )
      ) {
        yield* runtime.deleteSession(input.sessionId);
        return;
      }
      cursor = listed.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return yield* new AcpRegistryOperationError({
      reason: "session_delete_failed",
      message: "The Kiro session is not available in this project.",
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(managementFailure("delete", undefined)),
      }),
      Effect.mapError((cause) =>
        cause._tag === "AcpRegistryOperationError" ? cause : managementFailure("delete", cause),
      ),
    ),
);
