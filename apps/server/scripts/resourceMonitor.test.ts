import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { buildResourceMonitor } from "./resourceMonitor.ts";

it.live.each(["valid", "legacy", "failed build", "custom target"] as const)(
  "stages a standalone compatible helper or rejects the build: %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcess.Platform;
      const arch = yield* HostProcess.Architecture;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clean-helper-build-" });
      const output =
        scenario === "custom target"
          ? `${root}/configured-target/host/release`
          : `${root}/native/resource-monitor/target/release`;
      const name = platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
      yield* fs.makeDirectory(output, { recursive: true });
      yield* fs.writeFileString(`${output}/${name}`, "compiled-helper");
      const replacement = ChildProcessSpawner.make((command) => {
        const cargo = ChildProcess.isStandardCommand(command) && command.command === "cargo";
        const reply =
          scenario === "legacy"
            ? { type: "hello", version: 3 }
            : {
                pid: process.pid,
                ppid: process.ppid,
                birthId: "fixture",
                startedAtUpperBoundMs: 1,
                zombie: false,
              };
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(
              ChildProcessSpawner.ExitCode(cargo && scenario === "failed build" ? 101 : 0),
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(
              new TextEncoder().encode(
                JSON.stringify(
                  cargo
                    ? {
                        reason: "compiler-artifact",
                        target: { name: "t3-resource-monitor", kind: ["bin"] },
                        executable: `${output}/${name}`,
                      }
                    : reply,
                ),
              ),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const result = yield* buildResourceMonitor(root).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, replacement),
        Effect.result,
      );
      assert.equal(
        result._tag,
        scenario === "valid" || scenario === "custom target" ? "Success" : "Failure",
      );
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "Install Rust/Cargo");
        return;
      }
      assert.equal(
        result.success,
        `${root}/apps/server/dist/resource-monitor/${platform}-${arch}/${name}`,
      );
      yield* fs.remove(output, { recursive: true });
      assert.equal(yield* fs.readFileString(result.success), "compiled-helper");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
