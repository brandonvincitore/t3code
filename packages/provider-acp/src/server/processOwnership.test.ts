import { assert, it } from "@effect/vitest";
import type { ProviderProcessIdentity } from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import { ownsDescendantProcess } from "./processOwnership.ts";

it.effect.each([
  "owned",
  "foreign-parent",
  "orphan",
  "zombie",
  "missing",
  "cycle",
  "future-birth",
  "same-second-replacement",
  "candidate-reused",
  "parent-reused",
  "parent-moved",
  "root-exit",
  "missing-root",
  "wrong-pid",
  "too-deep",
] as const)("requires a stable live ancestry and birth before the lease: %s", (scenario) =>
  Effect.gen(function* () {
    const row = (
      pid: number,
      ppid: number,
      startedAtUpperBoundMs: number,
    ): ProviderProcessIdentity => ({
      pid,
      ppid,
      startedAtUpperBoundMs,
      birthId: `birth:${pid}`,
      zombie: false,
    });
    const rows = new Map([
      [100, row(100, 90, 1_000)],
      [200, row(200, 100, 1_100)],
      [300, row(300, 200, 1_200)],
    ]);
    if (scenario === "orphan") rows.set(200, row(200, 1, 1_100));
    if (scenario === "zombie") rows.set(300, { ...rows.get(300)!, zombie: true });
    if (scenario === "missing") rows.delete(300);
    if (scenario === "missing-root") rows.delete(100);
    if (scenario === "cycle") rows.set(200, row(200, 300, 1_100));
    if (scenario === "future-birth") rows.set(300, row(300, 200, 2_000));
    if (scenario === "same-second-replacement") rows.set(300, row(300, 200, 1_501));
    if (scenario === "wrong-pid") rows.set(300, row(301, 200, 1_200));
    if (scenario === "too-deep") {
      for (let pid = 200; pid < 240; pid++) rows.set(pid, row(pid, pid + 1, 1_100));
      rows.set(240, row(240, 100, 1_100));
    }
    const reads = new Map<number, number>();
    let rootChecks = 0;
    const owned = yield* ownsDescendantProcess({
      rootPid: 100,
      pid: 300,
      parentPid: scenario === "foreign-parent" ? 201 : 200,
      acquiredAtMs: 1_500,
      isRootRunning: Effect.sync(() => scenario !== "root-exit" || ++rootChecks === 1),
      readIdentity: (pid) =>
        Effect.sync(() => {
          const count = (reads.get(pid) ?? 0) + 1;
          reads.set(pid, count);
          const current = rows.get(pid);
          if (current === undefined) return;
          if (
            count === 2 &&
            ((scenario === "candidate-reused" && pid === 300) ||
              (scenario === "parent-reused" && pid === 200))
          )
            return { ...current, birthId: "replacement" };
          if (count === 2 && scenario === "parent-moved" && pid === 200)
            return { ...current, ppid: 90 };
          return current;
        }),
    });
    assert.equal(owned, scenario === "owned");
  }),
);
