import type { OrchestrationV2AppThread, OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
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
    schemaVersion: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    createdAt: Schema.optional(Schema.String),
    lastModifiedAt: Schema.optional(Schema.String),
    titleSetByUser: Schema.optional(Schema.Boolean),
    title: Schema.optional(Schema.NullOr(Schema.String)),
    kiro: Schema.optional(
      Schema.Struct({
        source: Schema.optional(Schema.String),
        titleSetByUser: Schema.optional(Schema.Boolean),
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

export const initializeKiroThreadTitle = Effect.fn("Kiro.initializeThreadTitle")(function* ({
  runtime,
  session,
  turn,
  observedTitle,
}: Parameters<NonNullable<AcpAdapterV2Flavor["initializeThreadTitle"]>>[0]) {
  const methods = Option.getOrUndefined(
    decodeMethods(session.initializeResult.agentCapabilities?._meta),
  )?.kiro.extensionMethods;
  if (!methods?.includes("_kiro/session/rename")) return;
  const meta = Option.getOrUndefined(decodeSession(session.sessionSetupResult._meta));
  const sources = [meta?.source, meta?.kiro?.source].filter((source) => source !== undefined);
  if (sources.length === 0 || sources.some((source) => source !== "local")) return;
  if (meta?.titleSetByUser === true || meta?.kiro?.titleSetByUser === true) return;
  // Only the adapter's proven fresh-root window can treat Kiro's creation metadata as unowned.
  const initialDefault =
    meta?.title === "New Session" &&
    meta.schemaVersion === "1.0.0" &&
    meta.id === session.sessionId &&
    meta.createdAt !== undefined &&
    Number.isFinite(Date.parse(meta.createdAt)) &&
    meta.createdAt === meta.lastModifiedAt;
  if (
    (meta?.title?.trim() && !initialDefault) ||
    meta?.kiro?.title?.trim() ||
    observedTitle?.trim()
  )
    return;
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
    return;
  }
  return title;
});

const Record = Schema.Struct({
  schemaVersion: Schema.Literal("1.0.0"),
  id: Schema.String,
  title: Schema.String,
  workspacePaths: Schema.Array(Schema.String),
  createdAt: Schema.String,
  lastModifiedAt: Schema.String,
  titleSetByUser: Schema.optional(Schema.Boolean),
  parentSessionId: Schema.optional(Schema.String),
  forkedAtMessageId: Schema.optional(Schema.String),
  parentExecutionId: Schema.optional(Schema.String),
});
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String,
  createdAt: Schema.String,
  title: Schema.String,
  owned: Schema.Boolean,
});
const decodeRecord = Schema.decodeOption(Schema.fromJsonString(Record));
const decodeReceipt = Schema.decodeOption(Schema.fromJsonString(Receipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Receipt));
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
type Runtime = Parameters<NonNullable<AcpAdapterV2Flavor["initializeThreadTitle"]>>[0]["runtime"];

export const makeKiroNativeTitles = Effect.fn("KiroNativeTitles.make")(function* (
  instanceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const posixPath = yield* Effect.provide(Path.Path, Path.layer);
  const digest = yield* Digest.Digest;
  const host = yield* ProviderHost.ProviderHost;
  const fallbackHome = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const lock = yield* Semaphore.make(1);
  const runtimes = new WeakMap<
    Runtime,
    { environment: NodeJS.ProcessEnv; cwd: string; closed: boolean }
  >();
  const hash = (value: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(Effect.map(Hex.encode));
  const normalize = (value: string) => {
    const slashes = path.resolve(value).replace(/\\/g, "/");
    let normalized = posixPath.normalize(slashes);
    if (platform === "win32" && slashes.startsWith("//") && !normalized.startsWith("//"))
      normalized = `/${normalized}`;
    if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized))
      normalized = normalized.replace(/\/+$/, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const tolerantRealPath = Effect.fn("KiroNativeTitles.realPath")(function* (
    value: string,
  ): Effect.fn.Return<string> {
    let current = value;
    const missing: string[] = [];
    for (;;) {
      const real = yield* fs.realPath(current).pipe(Effect.option);
      if (Option.isSome(real)) return path.join(real.value, ...missing.toReversed());
      const parent = path.dirname(current);
      if (parent === current) return value;
      missing.push(path.basename(current));
      current = parent;
    }
  });
  const nativeHome = Effect.fn("KiroNativeTitles.home")(function* (environment: NodeJS.ProcessEnv) {
    const home =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME) || fallbackHome;
    if (!path.isAbsolute(home)) return;
    const override = environment.KIRO_HOME?.trim();
    const defaultHome = path.join(home, ".kiro");
    if (!override || !path.isAbsolute(override)) return defaultHome;
    const candidate = yield* tolerantRealPath(path.resolve(override));
    const actualHome = yield* tolerantRealPath(path.resolve(home));
    const relative = path.relative(candidate, actualHome);
    return candidate === path.parse(candidate).root ||
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
      ? defaultHome
      : path.resolve(override);
  });
  const readBounded = Effect.fn("KiroNativeTitles.readBounded")(function* (filePath: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const before = yield* fs.lstat(filePath);
        if (before.type !== "File" || before.size > 65_536) return;
        const file = yield* fs.open(filePath, { flag: "r" });
        const opened = yield* file.stat;
        if (
          opened.type !== "File" ||
          Option.getOrUndefined(opened.ino) !== Option.getOrUndefined(before.ino) ||
          opened.size !== before.size ||
          opened.size > 65_536
        )
          return;
        const bytes = yield* file.readAlloc(65_537);
        const after = yield* file.stat;
        const current = yield* fs.lstat(filePath);
        if (
          Option.isNone(bytes) ||
          bytes.value.length !== Number(opened.size) ||
          after.size !== opened.size ||
          current.type !== "File" ||
          Option.getOrUndefined(current.ino) !== Option.getOrUndefined(opened.ino) ||
          Option.getOrUndefined(after.mtime)?.getTime() !==
            Option.getOrUndefined(opened.mtime)?.getTime()
        )
          return;
        if ((yield* fs.realPath(filePath)) !== filePath) return;
        const text = new TextDecoder().decode(bytes.value);
        const roundtrip = new TextEncoder().encode(text);
        if (
          roundtrip.length !== bytes.value.length ||
          roundtrip.some((byte, index) => byte !== bytes.value[index])
        )
          return;
        return text;
      }),
    );
  });
  const readRecord = Effect.fn("KiroNativeTitles.readRecord")(
    function* (runtime: Runtime, sessionId: string) {
      const bound = runtimes.get(runtime);
      if (
        !bound ||
        bound.closed ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
        sessionId.toLowerCase() === "workflows"
      )
        return;
      const home = yield* nativeHome(bound.environment);
      if (!home || !path.isAbsolute(bound.cwd)) return;
      const root = yield* fs.realPath(home);
      const workspace = normalize(bound.cwd);
      const bucket = (yield* hash(workspace)).slice(0, 16);
      let current = root;
      for (const segment of ["sessions", bucket, sessionId]) {
        current = path.join(current, segment);
        if (
          (yield* fs.lstat(current)).type !== "Directory" ||
          (yield* fs.realPath(current)) !== current
        )
          return;
      }
      const filePath = path.join(current, "session.json");
      const raw = yield* readBounded(filePath);
      if (!raw) return;
      const record = decodeRecord(raw);
      if (Option.isNone(record)) return;
      const value = record.value;
      if (
        value.id !== sessionId ||
        value.workspacePaths.length !== 1 ||
        !value.workspacePaths.every(
          (entry) => path.isAbsolute(entry) && normalize(entry) === workspace,
        ) ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        !Number.isFinite(Date.parse(value.lastModifiedAt)) ||
        Date.parse(value.lastModifiedAt) < Date.parse(value.createdAt) ||
        value.parentSessionId !== undefined ||
        value.forkedAtMessageId !== undefined ||
        value.parentExecutionId !== undefined
      )
        return;
      return { record: value, root, workspace };
    },
    Effect.orElseSucceed(() => undefined),
  );
  const location = Effect.fn("KiroNativeTitles.location")(function* (
    appThread: OrchestrationV2AppThread,
    providerThread: OrchestrationV2ProviderThread,
  ) {
    const encoded = yield* encodeIdentity([appThread.id, instanceId, providerThread.id]);
    const key = yield* hash(encoded);
    return path.join(host.paths.stateDir, "kiro-native-title-v1", `${key}.json`);
  });
  const binding = (
    appThread: OrchestrationV2AppThread,
    providerThread: OrchestrationV2ProviderThread,
    source: NonNullable<Effect.Success<ReturnType<typeof readRecord>>>,
  ) =>
    encodeIdentity([
      appThread.id,
      instanceId,
      providerThread.id,
      providerThread.nativeThreadRef?.nativeId ?? "",
      source.root,
      source.workspace,
    ]).pipe(Effect.flatMap(hash));
  const save = (filePath: string, receipt: typeof Receipt.Type) =>
    writeFileStringAtomically({
      filePath,
      contents: encodeReceipt(receipt),
      mode: 0o600,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const initialize: NonNullable<AcpAdapterV2Flavor["initializeThreadTitle"]> = Effect.fn(
    "KiroNativeTitles.initialize",
  )(function* (input) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const title = yield* initializeKiroThreadTitle(input);
        if (!title || input.turn.appThread.titleManuallySet === true) return;
        const source = yield* readRecord(input.runtime, input.session.sessionId);
        if (!source || source.record.title !== title) return;
        const filePath = yield* location(input.turn.appThread, input.turn.providerThread);
        yield* save(filePath, {
          version: 1,
          binding: yield* binding(input.turn.appThread, input.turn.providerThread, source),
          createdAt: source.record.createdAt,
          title,
          owned: true,
        });
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
  });
  const synchronize: NonNullable<AcpAdapterV2Flavor["syncGeneratedTitle"]> = Effect.fn(
    "KiroNativeTitles.synchronize",
  )(function* (input) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const filePath = yield* location(input.appThread, input.providerThread);
        const raw = yield* readBounded(filePath);
        if (!raw) return;
        const decoded = decodeReceipt(raw);
        if (Option.isNone(decoded) || !decoded.value.owned) return;
        const receipt = decoded.value;
        const retire = save(filePath, { ...receipt, owned: false });
        if (input.appThread.titleManuallySet === true) return yield* retire;
        const source = yield* readRecord(input.runtime, input.session.sessionId);
        if (!source) return;
        if (
          receipt.binding !== (yield* binding(input.appThread, input.providerThread, source)) ||
          receipt.createdAt !== source.record.createdAt ||
          receipt.title !== source.record.title
        )
          return yield* retire;
        const title = normalizeTitle(input.appThread.title);
        if (!title || title === receipt.title || !(yield* input.isCurrent)) return;
        const methods = Option.getOrUndefined(
          decodeMethods(input.session.initializeResult.agentCapabilities?._meta),
        )?.kiro.extensionMethods;
        if (
          !methods?.includes("_kiro/session/rename") ||
          runtimes.get(input.runtime)?.closed !== false
        )
          return;
        const result = yield* input.runtime
          .request("_kiro/session/rename", {
            sessionId: input.session.sessionId,
            title,
            sessionSource: "local",
          })
          .pipe(Effect.timeoutOption("5 seconds"), Effect.orElseSucceed(Option.none));
        if (
          Option.isNone(result) ||
          Option.getOrUndefined(decodeRenamed(result.value))?.success !== true
        )
          return;
        if (!(yield* input.isCurrent) || runtimes.get(input.runtime)?.closed !== false)
          return yield* retire;
        yield* save(filePath, { ...receipt, title });
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
  });
  const bindRuntime = Effect.fn("KiroNativeTitles.bindRuntime")(function* (
    runtime: Runtime,
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) {
    const bound = { environment: { ...environment }, cwd, closed: false };
    runtimes.set(runtime, bound);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        bound.closed = true;
      }),
    );
  });
  return { initialize, synchronize, bindRuntime };
});
