import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";

const Identity = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(1)),
  ppid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  birthId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  startedAtUpperBoundMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  zombie: Schema.Boolean,
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.NullOr(Identity)));
class NativeProcessIdentityReadError extends Schema.TaggedError<NativeProcessIdentityReadError>()(
  "NativeProcessIdentityReadError",
  {},
) {}

export const make = Effect.fn("NativeProcessIdentity.make")(function* () {
  const binary = yield* ResourceMonitorBinary.make();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let warned = false;
  return Effect.fn("NativeProcessIdentity.read")(
    function* (pid: number) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      const path = yield* binary.resolve;
      const handle = yield* spawner.spawn(
        ChildProcess.make(path, ["--process-identity", String(pid)], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0 || stdout.length > 4_096)
        return yield* new NativeProcessIdentityReadError({});
      const row = yield* decode(stdout);
      return row?.pid === pid ? row : undefined;
    },
    Effect.scoped,
    Effect.timeout("2 seconds"),
    Effect.tapError(() =>
      Effect.gen(function* () {
        if (!warned) {
          warned = true;
          yield* Effect.logWarning(
            "Precise provider process identity is unavailable. Rebuild the native resource monitor.",
          );
        }
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});
