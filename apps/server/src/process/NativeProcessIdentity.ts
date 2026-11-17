import { ProviderProcessIdentityUnavailableError } from "@t3tools/provider-core/server/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";
import { probeProcessIdentity } from "./processIdentityProtocol.ts";

export const make = Effect.fn("NativeProcessIdentity.make")(function* () {
  const binary = yield* ResourceMonitorBinary.make();
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const probe = Effect.fn("NativeProcessIdentity.readStrict")(function* (pid: number) {
    return yield* probeProcessIdentity(yield* binary.resolve, pid).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  });
  const readPresence = Effect.fn("NativeProcessIdentity.readPresence")(function (pid: number) {
    return Effect.sync(() => {
      if (
        (platform !== "linux" && platform !== "darwin") ||
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        pid > 0x7fffffff
      )
        return "unknown" as const;
      try {
        process.kill(pid, 0);
        return "present" as const;
      } catch (cause) {
        return Predicate.hasProperty(cause, "code") && cause.code === "ESRCH"
          ? ("missing" as const)
          : ("unknown" as const);
      }
    });
  });
  let warned = false;
  const read = Effect.fn("NativeProcessIdentity.read")(
    function* (pid: number) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      return (yield* probe(pid)) ?? undefined;
    },
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
  const ensureAvailable = Effect.gen(function* () {
    const row = yield* probe(process.pid);
    // Windows preserves direct-spawn proof; the helper's identity protocol returns null there.
    if (platform !== "win32" && (row === null || row.zombie))
      return yield* new ProviderProcessIdentityUnavailableError({});
  }).pipe(Effect.mapError((cause) => new ProviderProcessIdentityUnavailableError({ cause })));
  return { read, readPresence, ensureAvailable };
});
