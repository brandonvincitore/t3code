import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const Identity = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
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

export const probeProcessIdentity = Effect.fn("NativeProcessIdentity.probe")(
  function* (path: string, pid: number) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(path, ["--process-identity", String(pid)], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    let size = 0;
    const [stdout, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText(),
          Stream.mapEffect((chunk) => {
            size += chunk.length;
            return size > 4_096
              ? Effect.fail(new NativeProcessIdentityReadError({}))
              : Effect.succeed(chunk);
          }),
          Stream.mkString,
        ),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) return yield* new NativeProcessIdentityReadError({});
    const row = yield* decode(stdout);
    if (row !== null && row.pid !== pid) return yield* new NativeProcessIdentityReadError({});
    return row;
  },
  Effect.scoped,
  Effect.timeout("2 seconds"),
);
