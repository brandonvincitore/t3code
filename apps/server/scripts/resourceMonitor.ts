import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { probeProcessIdentity } from "../src/process/processIdentityProtocol.ts";

class ResourceMonitorBuildError extends Schema.TaggedError<ResourceMonitorBuildError>()(
  "ResourceMonitorBuildError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not build a compatible native resource monitor. Install Rust/Cargo and rebuild T3; do not install this incomplete build.";
  }
}
const isResourceMonitorBuildError = Schema.is(ResourceMonitorBuildError);

export const buildResourceMonitor = Effect.fn("buildResourceMonitor")(
  function* (repoRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const crate = path.join(repoRoot, "native/resource-monitor");
    const exit = yield* ChildProcess.make(
      "cargo",
      ["build", "--locked", "--release", "--manifest-path", path.join(crate, "Cargo.toml")],
      {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    ).pipe(
      Effect.flatMap((child) => child.exitCode),
      Effect.scoped,
    );
    if (exit !== 0) return yield* new ResourceMonitorBuildError({});
    const name = platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
    const directory = path.join(
      repoRoot,
      "apps/server/dist/resource-monitor",
      `${platform}-${arch}`,
    );
    yield* fs.makeDirectory(directory, { recursive: true });
    const staged = path.join(directory, name);
    yield* fs.copyFile(path.join(crate, "target/release", name), staged);
    const row = yield* probeProcessIdentity(staged, process.pid);
    if (platform !== "win32" && (row === null || row.zombie))
      return yield* new ResourceMonitorBuildError({});
    return staged;
  },
  Effect.mapError((cause) =>
    isResourceMonitorBuildError(cause) ? cause : new ResourceMonitorBuildError({ cause }),
  ),
);
