import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { KiroSettings } from "../settings.ts";

const decodeSettings = Schema.decodeEffect(KiroSettings);
import { makeKiroPowers } from "./powers.ts";

const fixture = Effect.fn("KiroPowersTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-powers-" });
  const binaryPath = path.join(root, "kiro-cli");
  const stateFile = path.join(root, "state.json");
  const logFile = path.join(root, "operations.jsonl");
  const customHome = path.join(root, "home");
  const changes = yield* Ref.make(0);
  const state = {
    resources: [
      {
        type: "power",
        compose: "append",
        items: [
          {
            layer: "user-local",
            standing: { kind: "active" },
            value: { name: "local-power", description: "Installed" },
          },
          { layer: "organization", standing: { kind: "active" }, value: { name: "managed-power" } },
          { layer: "user-local", standing: { kind: "displaced" }, value: { name: "hidden-power" } },
        ],
      },
    ],
  };
  yield* fs.writeFileString(stateFile, JSON.stringify(state));
  yield* fs.writeFileString(
    binaryPath,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv[2] === 'powers') {
  appendFileSync(process.env.KIRO_TEST_LOG, JSON.stringify({ argv: process.argv.slice(2), home: process.env.KIRO_HOME, cwd: process.cwd() }) + '\\n');
  if (process.argv.at(-1) === 'failure') { process.stderr.write('secret-native-diagnostic'); process.exit(1); }
  process.exit(0);
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { _meta: { kiro: { extensionMethods: ['_kiro/configuration/getState'] } } } } : JSON.parse(readFileSync(process.env.KIRO_TEST_STATE, 'utf8'));
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
  );
  yield* fs.chmod(binaryPath, 0o700);
  const controller = yield* makeKiroPowers(
    yield* decodeSettings({ enabled: true, binaryPath }),
    {
      PATH: (yield* HostProcess.Environment).PATH,
      KIRO_HOME: customHome,
      KIRO_TEST_STATE: stateFile,
      KIRO_TEST_LOG: logFile,
    },
    Ref.update(changes, (value) => value + 1),
  );
  const operations = fs.readFileString(logFile).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ),
  );
  return { controller, root, customHome, operations, changes, state, stateFile };
});

describe("Kiro Powers", () => {
  it.live(
    "uses native visibility and protected argv with the configured home, and invalidates after successful changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const listed = yield* f.controller.list(f.root);
        assert.deepEqual(
          listed.powers.map((power) => [power.name, power.canRemove]),
          [
            ["local-power", true],
            ["managed-power", false],
          ],
        );
        const localPath = `${f.root}/power with spaces;echo unsafe`;
        yield* f.controller.install({ cwd: f.root, target: localPath });
        yield* f.controller.remove({ cwd: f.root, name: "local-power" });
        const operations = yield* f.operations;
        assert.deepEqual(
          operations.map((operation: { argv: Array<string> }) => operation.argv),
          [
            ["powers", "install", "--", localPath],
            ["powers", "uninstall", "--", "local-power"],
          ],
        );
        assert.isTrue(
          operations.every(
            (operation: { home: string; cwd: string }) =>
              operation.home === f.customHome && operation.cwd === f.root,
          ),
        );
        assert.equal(yield* Ref.get(f.changes), 2);
        const failed = yield* f.controller
          .install({ cwd: f.root, target: "failure" })
          .pipe(Effect.flip);
        assert.equal(
          failed.message,
          "Kiro could not complete the Powers operation. Check the Kiro environment and try again.",
        );
        assert.equal(yield* Ref.get(f.changes), 2);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live(
    "rejects URL targets, option-like names, managed removals, and locked Power collections",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* fixture();
        for (const target of [
          "https://example.com/power?token=secret",
          "--help",
          "relative path",
          "a\nunsafe",
        ]) {
          const error = yield* f.controller.install({ cwd: f.root, target }).pipe(Effect.flip);
          assert.equal(error.code, "invalid_target");
        }
        const removal = yield* f.controller
          .remove({ cwd: f.root, name: "managed-power" })
          .pipe(Effect.flip);
        assert.equal(removal.code, "managed");
        yield* fs.writeFileString(
          f.stateFile,
          JSON.stringify({ resources: [{ ...f.state.resources[0], compose: "locked" }] }),
        );
        const installation = yield* f.controller
          .install({ cwd: f.root, target: "catalog-power" })
          .pipe(Effect.flip);
        assert.equal(installation.code, "managed");
        assert.equal(yield* Ref.get(f.changes), 0);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
