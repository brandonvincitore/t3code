import type { ProviderProcessIdentity } from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";

export const ownsDescendantProcess = Effect.fn("AcpSessionRuntime.ownsDescendantProcess")(
  function* (input: {
    readonly rootPid: number;
    readonly pid: number;
    readonly parentPid: number;
    readonly acquiredAtMs: number;
    readonly isRootRunning: Effect.Effect<boolean>;
    readonly readIdentity: (pid: number) => Effect.Effect<ProviderProcessIdentity | undefined>;
  }) {
    if (!(yield* input.isRootRunning)) return false;
    const readChain = Effect.gen(function* () {
      const chain: Array<ProviderProcessIdentity> = [];
      const visited = new Set<number>();
      let pid = input.pid;
      for (let depth = 0; depth < 32; depth++) {
        if (!Number.isSafeInteger(pid) || pid <= 1 || visited.has(pid)) return;
        visited.add(pid);
        const row = yield* input.readIdentity(pid);
        if (
          row === undefined ||
          row.pid !== pid ||
          row.zombie ||
          row.birthId.length === 0 ||
          !Number.isSafeInteger(row.startedAtUpperBoundMs) ||
          row.startedAtUpperBoundMs < 0 ||
          row.startedAtUpperBoundMs > input.acquiredAtMs ||
          (depth === 0 && row.ppid !== input.parentPid)
        )
          return;
        chain.push(row);
        if (pid === input.rootPid) return chain;
        pid = row.ppid;
      }
    });
    const first = yield* readChain;
    if (first === undefined) return false;
    const second = yield* readChain;
    return (
      second !== undefined &&
      first.length === second.length &&
      first.every((row, index) => {
        const current = second[index];
        return (
          current?.pid === row.pid && current.ppid === row.ppid && current.birthId === row.birthId
        );
      }) &&
      (yield* input.isRootRunning)
    );
  },
);
