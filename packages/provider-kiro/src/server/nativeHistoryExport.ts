import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- Only a freshly owned private export directory is read or removed.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NativeHistoryReadError } from "@t3tools/contracts";
import type { NativeHistoryCapture } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { KiroSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";
import type { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeKiroAcpRuntime } from "./acpSupport.ts";

type Runtime = Pick<AcpSessionRuntime["Service"], "initialize" | "request" | "listSessions">;
export interface NativeHistoryExportOptions {
  readonly instanceId: string;
  readonly settings: Pick<KiroSettings, "enabled" | "binaryPath">;
  readonly decodeArchive?: NonNullable<ProviderHost["Service"]["decodeNativeHistoryArchive"]>;
  readonly makeRuntime?: (
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<
    Runtime,
    AcpErrors.AcpError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
  >;
}
const Methods = Schema.Struct({
  kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }),
});
const Exported = Schema.Struct({
  success: Schema.Boolean,
  filePath: Schema.optional(Schema.String),
});
const Source = Schema.Struct({
  source: Schema.optional(Schema.Unknown),
  kiro: Schema.optional(Schema.Struct({ source: Schema.optional(Schema.Unknown) })),
});
const decodeMethods = Schema.decodeUnknownEffect(Methods);
const decodeExported = Schema.decodeUnknownEffect(Exported);
const decodeSource = Schema.decodeEffect(Source);
const isReadError = Schema.is(NativeHistoryReadError);
const error = (status: "unsupported" | "unsafe" | "unavailable" = "unsafe") =>
  new NativeHistoryReadError({ status, reason: status === "unsafe" ? "invalid_source" : status });
const key = (s: Awaited<ReturnType<typeof NodeFSP.stat>>) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
const stamp = (s: Awaited<ReturnType<typeof NodeFSP.stat>>) =>
  `${key(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function privateTemp() {
  const created = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-kiro-history-export-"));
  const identity = key(await NodeFSP.lstat(created));
  try {
    const root = await NodeFSP.realpath(created);
    await NodeFSP.chmod(root, 0o700);
    if (key(await NodeFSP.lstat(root)) !== identity) throw error();
    return { root, identity };
  } catch (cause) {
    try {
      if (key(await NodeFSP.lstat(created)) === identity) await NodeFSP.rmdir(created);
    } catch {
      /* Only the recorded empty directory is ours. */
    }
    throw cause;
  }
}

async function readExport(
  owned: Awaited<ReturnType<typeof privateTemp>>,
  filePath: string,
  id: string,
  platform: NodeJS.Platform,
) {
  const relative = NodePath.relative(owned.root, filePath);
  const parts = relative.split(NodePath.sep);
  if (
    !NodePath.isAbsolute(filePath) ||
    filePath !== NodePath.resolve(filePath) ||
    parts.length !== 2 ||
    !/^kiro-exports-[A-Za-z0-9]{6}$/.test(parts[0]!) ||
    parts[1] !== `kiro-session-${id}.zip`
  )
    throw error();
  const root = await NodeFSP.lstat(owned.root);
  const directory = NodePath.dirname(filePath);
  const dir = await NodeFSP.lstat(directory);
  const before = await NodeFSP.lstat(filePath);
  if (
    key(root) !== owned.identity ||
    !root.isDirectory() ||
    !dir.isDirectory() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    (platform !== "win32" && (root.mode & 0o077) !== 0) ||
    before.size > 8 * 1024 * 1024 ||
    (await NodeFSP.realpath(directory)) !== directory ||
    (await NodeFSP.realpath(filePath)) !== filePath
  )
    throw error();
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw error();
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (
      offset !== before.size ||
      stamp(await handle.stat()) !== stamp(before) ||
      stamp(await NodeFSP.lstat(filePath)) !== stamp(before) ||
      key(await NodeFSP.lstat(directory)) !== key(dir) ||
      key(await NodeFSP.lstat(owned.root)) !== owned.identity ||
      (await NodeFSP.realpath(filePath)) !== filePath
    )
      throw error();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export const makeNativeExportCapture = Effect.fn("KiroHistory.makeExportCapture")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly options: NativeHistoryExportOptions;
    readonly observeLease: (cwd: string, id: string) => Effect.Effect<void, NativeHistoryReadError>;
    readonly parse: (
      metadata: string,
      transcript: string,
      cwd: string,
      id: string,
    ) => Effect.Effect<NativeHistoryCapture, NativeHistoryReadError>;
    readonly normalize: (path: string) => string;
  }) {
    const platform = yield* HostProcess.Platform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const random = yield* SecureRandom.SecureRandom;
    const makeRuntime =
      input.options.makeRuntime ??
      ((cwd, environment) =>
        makeKiroAcpRuntime({
          settings: input.options.settings,
          environment,
          cwd,
          authenticateOnAuthRequired: false,
          inheritEnvironment: false,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code-history-export", version: "0.0.0" },
          onStderr: () => Effect.void,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(SecureRandom.SecureRandom, random),
        ));
    return Effect.fn("KiroHistory.captureExport")(
      function* ({ cwd, nativeId }: { cwd: string; nativeId: string }) {
        if (!input.options.settings.enabled) return yield* error("unavailable");
        if (
          !NodePath.isAbsolute(cwd) ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(nativeId) ||
          nativeId.toLowerCase() === "workflows"
        )
          return yield* error();
        yield* input.observeLease(cwd, nativeId);
        const decodeArchive = input.options.decodeArchive;
        if (!decodeArchive) return yield* error("unsupported");
        const owned = yield* Effect.acquireRelease(
          Effect.tryPromise({ try: privateTemp, catch: () => error("unavailable") }),
          (owned) =>
            Effect.promise(async () => {
              try {
                const current = await NodeFSP.lstat(owned.root);
                if (current.isDirectory() && key(current) === owned.identity)
                  await NodeFSP.rm(owned.root, { recursive: true, force: true });
              } catch {
                /* A substituted path is never cleanup authority. */
              }
            }),
        );
        const environment = Object.fromEntries(
          Object.entries(input.environment).filter(
            ([name]) => !["TMPDIR", "TEMP", "TMP"].includes(name.toUpperCase()),
          ),
        );
        const runtime = yield* makeRuntime(cwd, {
          ...environment,
          TMPDIR: owned.root,
          TEMP: owned.root,
          TMP: owned.root,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(SecureRandom.SecureRandom, random),
        );
        const initialized = yield* runtime.initialize();
        const methods = yield* decodeMethods(initialized.agentCapabilities?._meta).pipe(
          Effect.mapError(() => error("unsupported")),
        );
        if (
          !methods.kiro.extensionMethods.includes("_kiro/session/export") ||
          !initialized.agentCapabilities?.sessionCapabilities?.list
        )
          return yield* error("unsupported");
        let cursor: string | undefined;
        let found = false;
        const cursors = new Set<string>();
        for (let page = 0; page < 32; page++) {
          const listed = yield* runtime.listSessions(cursor);
          if (listed.sessions.length > 256) return yield* error();
          const matches = listed.sessions.filter((session) => session.sessionId === nativeId);
          if (matches.length > 1) return yield* error();
          if (matches.length === 1) {
            const session = matches[0]!;
            const source = yield* decodeSource(session._meta ?? {}).pipe(
              Effect.mapError(() => error()),
            );
            if (
              [source.source, source.kiro?.source].every((s) => s === undefined) ||
              [source.source, source.kiro?.source].some((s) => s !== undefined && s !== "local") ||
              !NodePath.isAbsolute(session.cwd) ||
              input.normalize(session.cwd) !== input.normalize(cwd) ||
              (session.additionalDirectories ?? []).some(
                (p) => !NodePath.isAbsolute(p) || input.normalize(p) !== input.normalize(cwd),
              )
            )
              return yield* error();
            found = true;
            break;
          }
          cursor = listed.nextCursor ?? undefined;
          if (!cursor || cursor.length > 2048 || cursors.has(cursor)) break;
          cursors.add(cursor);
        }
        if (!found) return yield* error("unavailable");
        yield* input.observeLease(cwd, nativeId);
        const response = yield* runtime.request("_kiro/session/export", { sessionId: nativeId });
        const exported = yield* decodeExported(response).pipe(Effect.mapError(() => error()));
        if (!exported.success) return yield* error("unavailable");
        if (!exported.filePath || exported.filePath.length > 8192) return yield* error();
        const bytes = yield* Effect.tryPromise({
          try: () => readExport(owned, exported.filePath!, nativeId, platform),
          catch: () => error(),
        });
        const archive = yield* decodeArchive(bytes, nativeId);
        const capture = yield* input.parse(archive.metadata, archive.transcript, cwd, nativeId);
        yield* input.observeLease(cwd, nativeId);
        return capture;
      },
      Effect.scoped,
      Effect.catchTags({
        AcpRequestError: (cause) =>
          Effect.fail(error(cause.code === -32601 ? "unsupported" : "unavailable")),
      }),
      Effect.mapError((cause) => (isReadError(cause) ? cause : error("unavailable"))),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(error("unavailable")),
      }),
    );
  },
);
