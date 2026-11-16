import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as NativeProcessIdentity from "./NativeProcessIdentity.ts";

it.live.each([
  "identity",
  "missing",
  "wrong-pid",
  "invalid-json",
  "legacy-helper",
  "bad-birth",
  "failed-helper",
] as const)("reads precise native identity or fails closed: %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-process-identity-" });
    const identity = {
      pid: 127,
      ppid: 126,
      birthId: "123:456",
      startedAtUpperBoundMs: 1_001,
      zombie: false,
    };
    const output =
      scenario === "invalid-json"
        ? "{invalid"
        : JSON.stringify(
            scenario === "missing"
              ? null
              : scenario === "wrong-pid"
                ? { ...identity, pid: 128 }
                : scenario === "legacy-helper"
                  ? { type: "hello", version: 3 }
                  : scenario === "bad-birth"
                    ? { ...identity, birthId: "" }
                    : identity,
          );
    const binary = writeFakeCli({
      directory: root,
      name: "process-identity",
      source: `if (process.argv[2] !== '--process-identity' || process.argv[3] !== '127' || process.argv.length !== 4) process.exit(64);
process.stdout.write(${JSON.stringify(output)}); process.exit(${scenario === "failed-helper" ? 1 : 0});`,
    });
    const read = yield* NativeProcessIdentity.make().pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), root)),
      Effect.provideService(HostProcess.Environment, { T3CODE_RESOURCE_MONITOR_PATH: binary }),
    );
    assert.deepEqual(yield* read(127), scenario === "identity" ? identity : undefined);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
