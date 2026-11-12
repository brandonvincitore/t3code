import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";

const decodeMethods = Schema.decodeUnknownOption(
  Schema.Struct({ kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }) }),
);
const decodeSession = Schema.decodeUnknownOption(
  Schema.Struct({
    source: Schema.optional(Schema.String),
    title: Schema.optional(Schema.NullOr(Schema.String)),
    kiro: Schema.optional(
      Schema.Struct({
        source: Schema.optional(Schema.String),
        title: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeRenamed = Schema.decodeUnknownOption(Schema.Struct({ success: Schema.Boolean }));

function normalizeTitle(value: string | null | undefined) {
  const title = value?.toWellFormed().replace(/\s+/gu, " ").trim();
  if (!title || /^(?:new (?:thread|chat)|untitled)$/iu.test(title)) return undefined;
  if (title.length <= 80) return title;
  let head = title.slice(0, 77);
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1);
  return `${head}...`;
}

export const initializeKiroThreadTitle: NonNullable<AcpAdapterV2Flavor["initializeThreadTitle"]> =
  Effect.fn("Kiro.initializeThreadTitle")(function* ({ runtime, session, turn, observedTitle }) {
    const methods = Option.getOrUndefined(
      decodeMethods(session.initializeResult.agentCapabilities?._meta),
    )?.kiro.extensionMethods;
    if (!methods?.includes("_kiro/session/rename")) return;
    const meta = Option.getOrUndefined(decodeSession(session.sessionSetupResult._meta));
    const sources = [meta?.source, meta?.kiro?.source].filter((source) => source !== undefined);
    if (sources.length === 0 || sources.some((source) => source !== "local")) return;
    if (meta?.title?.trim() || meta?.kiro?.title?.trim() || observedTitle?.trim()) return;
    const title = normalizeTitle(turn.appThread.title);
    if (title === undefined) return;
    const result = yield* runtime
      .request("_kiro/session/rename", {
        sessionId: session.sessionId,
        title,
        sessionSource: "local",
      })
      .pipe(Effect.timeoutOption("5 seconds"), Effect.orElseSucceed(Option.none));
    if (
      Option.isNone(result) ||
      Option.getOrUndefined(decodeRenamed(result.value))?.success !== true
    ) {
      yield* Effect.logWarning("Kiro initial native title was not confirmed");
    }
  });
