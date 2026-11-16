import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as NativeProcessIdentity from "./NativeProcessIdentity.ts";
import { probeProcessIdentity } from "./processIdentityProtocol.ts";

it.live.each([
  "identity",
  "missing",
  "wrong-pid",
  "invalid-json",
  "legacy-helper",
  "bad-birth",
  "failed-helper",
  "absent-helper",
  "non-executable",
  "pid-one",
] as const)("reads precise native identity or fails closed: %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
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
      source: `if (process.argv[2] !== '--process-identity' || process.argv.length !== 4) process.exit(64);
const output = ${JSON.stringify(output)};
let row; try { row = JSON.parse(output); } catch {}
if (row && row.pid === 127) row.pid = Number(process.argv[3]);
process.stdout.write(row === undefined ? output : JSON.stringify(row)); process.exit(${scenario === "failed-helper" ? 1 : 0});`,
    });
    if (scenario === "absent-helper") yield* fs.remove(binary);
    if (scenario === "non-executable" && platform !== "win32") yield* fs.chmod(binary, 0o644);
    const reader = yield* NativeProcessIdentity.make().pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), root)),
      Effect.provideService(HostProcess.Environment, { T3CODE_RESOURCE_MONITOR_PATH: binary }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: (file) => (file === binary ? fs.exists(file) : Effect.succeed(false)),
      }),
    );
    if (scenario === "pid-one") {
      assert.equal((yield* probeProcessIdentity(binary, 1))?.pid, 1);
      assert.isUndefined(yield* reader.read(1));
      return;
    }
    const valid =
      scenario === "identity" || (scenario === "non-executable" && platform === "win32");
    assert.deepEqual(yield* reader.read(127), valid ? identity : undefined);
    const ready = yield* reader.ensureAvailable.pipe(Effect.result);
    assert.equal(
      ready._tag,
      valid || (scenario === "missing" && platform === "win32") ? "Success" : "Failure",
    );
    if (ready._tag === "Failure")
      assert.equal(ready.failure._tag, "ProviderProcessIdentityUnavailableError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
