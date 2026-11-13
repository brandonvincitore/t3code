// @effect-diagnostics nodeBuiltinImport:off -- Bounded ZIP CRC and stream decoding use Node primitives.
import * as NodeZlib from "node:zlib";
import { NativeHistoryReadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- type-only, to adapt a Node Readable into Effect.
import type * as NodeStream from "node:stream";
import * as Yauzl from "yauzl";

/** Closing the scope closes the archive. */
export const openZipArchive = Effect.fn("zipArchive.open")(function* <E>(
  archivePath: string | Uint8Array,
  makeError: (detail: string, cause: unknown) => E,
) {
  const opened = yield* Effect.acquireRelease(
    Effect.callback<
      {
        readonly zip: Yauzl.ZipFile;
        readonly error: () => E | undefined;
        readonly close: Effect.Effect<void>;
      },
      E
    >((resume) => {
      const options = {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: true,
      };
      const open = (callback: (error: Error | null, zip?: Yauzl.ZipFile) => void) =>
        typeof archivePath === "string"
          ? Yauzl.open(archivePath, options, callback)
          : Yauzl.fromBuffer(Buffer.from(archivePath), options, callback);
      open((error, zip) => {
        if (error || !zip) {
          resume(Effect.fail(makeError("Could not open the verified archive.", error)));
          return;
        }
        let closed = false;
        let archiveError: E | undefined;
        zip.on("close", () => {
          closed = true;
        });
        zip.on("error", (cause: unknown) => {
          archiveError = makeError("The archive could not be read.", cause);
        });
        resume(
          Effect.succeed({
            zip,
            error: () => archiveError,
            close:
              typeof archivePath !== "string"
                ? Effect.sync(() => zip.close())
                : Effect.callback<void>((finish) => {
                    if (closed) {
                      finish(Effect.void);
                      return;
                    }
                    const onClose = () => {
                      zip.removeListener("error", onError);
                      finish(Effect.void);
                    };
                    const onError = (cause: unknown) => {
                      zip.removeListener("close", onClose);
                      finish(Effect.die(makeError("Could not close the archive.", cause)));
                    };
                    zip.once("close", onClose);
                    zip.once("error", onError);
                    zip.close();
                  }),
          }),
        );
      });
    }),
    (opened) => opened.close,
  );

  const next = Effect.callback<Yauzl.Entry | null, E>((resume) => {
    const existingError = opened.error();
    if (existingError) {
      resume(Effect.fail(existingError));
      return;
    }
    const cleanup = () => {
      opened.zip.removeListener("entry", onEntry);
      opened.zip.removeListener("end", onEnd);
      opened.zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(makeError("The archive could not be read.", cause)));
    };
    opened.zip.once("entry", onEntry);
    opened.zip.once("end", onEnd);
    opened.zip.once("error", onError);
    opened.zip.readEntry();
    return Effect.sync(cleanup);
  });

  const streamEntry = (entry: Yauzl.Entry) =>
    Effect.acquireRelease(
      Effect.callback<NodeStream.Readable, E>((resume) => {
        opened.zip.openReadStream(entry, (cause, readable) => {
          resume(
            cause || !readable
              ? Effect.fail(makeError("Could not read an archive member.", cause))
              : Effect.succeed(readable),
          );
        });
      }),
      (readable) =>
        Effect.sync(() => {
          readable.destroy();
        }),
    );
  return { entryCount: opened.zip.entryCount, next, streamEntry };
});

export const decodeNativeHistoryArchive = Effect.fn("zipArchive.decodeNativeHistory")(function* (
  bytes: Uint8Array,
  nativeId: string,
) {
  const invalid = () => new NativeHistoryReadError({ status: "unsafe", reason: "invalid_source" });
  if (bytes.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeId))
    return yield* invalid();
  const archive = yield* openZipArchive(bytes, invalid);
  if (archive.entryCount > 256) return yield* invalid();
  const seen = new Set<string>();
  let declared = 0;
  let actual = 0;
  let metadata: string | undefined;
  let transcript: string | undefined;
  for (;;) {
    const entry = yield* archive.next;
    if (!entry) break;
    const name = entry.fileName;
    const directory = name.endsWith("/");
    const components = name.replace(/\/$/, "").split("/");
    const type = (entry.externalFileAttributes >>> 16) & 0o170000;
    const critical = name === `${nativeId}/session.json` || name === `${nativeId}/messages.jsonl`;
    const auxiliary = new RegExp(
      `^${nativeId}/(?:sub-executions/[A-Za-z0-9_-]+\\.jsonl|diagrams/[A-Za-z0-9_-]+\\.json)$`,
    ).test(name);
    if (
      seen.has(name) ||
      components[0] !== nativeId ||
      components.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..") ||
      (!critical &&
        !auxiliary &&
        !(
          directory &&
          [nativeId, `${nativeId}/sub-executions`, `${nativeId}/diagrams`].includes(
            components.join("/"),
          )
        )) ||
      (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) ||
      (entry.externalFileAttributes & 0x400) !== 0 ||
      (entry.generalPurposeBitFlag & 1) !== 0 ||
      ![0, 8].includes(entry.compressionMethod)
    )
      return yield* invalid();
    seen.add(name);
    declared += entry.uncompressedSize;
    const limit = name === `${nativeId}/session.json` ? 65536 : 8 * 1024 * 1024;
    if (
      declared > 16 * 1024 * 1024 ||
      entry.uncompressedSize > limit ||
      entry.uncompressedSize > Math.max(1, entry.compressedSize) * 1000
    )
      return yield* invalid();
    if (directory) {
      if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) return yield* invalid();
      continue;
    }
    const text = yield* Effect.gen(function* () {
      const readable = yield* archive.streamEntry(entry);
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const abort = () => {
            readable.destroy();
          };
          signal.addEventListener("abort", abort, { once: true });
          let count = 0;
          let crc = 0;
          const chunks: Uint8Array[] = [];
          try {
            for await (const chunk of readable) {
              if (!(chunk instanceof Uint8Array)) throw invalid();
              count += chunk.length;
              actual += chunk.length;
              if (count > limit || actual > 16 * 1024 * 1024) throw invalid();
              crc = NodeZlib.crc32(chunk, crc);
              if (critical) chunks.push(chunk);
            }
            if (count !== entry.uncompressedSize || crc !== entry.crc32) throw invalid();
            return critical
              ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
              : undefined;
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
        catch: invalid,
      });
    }).pipe(Effect.scoped);
    if (name === `${nativeId}/session.json`) metadata = text;
    if (name === `${nativeId}/messages.jsonl`) transcript = text;
  }
  if (seen.size !== archive.entryCount || metadata === undefined || transcript === undefined)
    return yield* invalid();
  return { metadata, transcript };
}, Effect.scoped);
