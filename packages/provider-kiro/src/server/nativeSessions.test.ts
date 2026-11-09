import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KiroSettings } from "../settings.ts";

const decodeSettings = Schema.decodeEffect(KiroSettings);
import { deleteKiroSession, listKiroSessions } from "./nativeSessions.ts";

const makeFixture = Effect.fn("KiroSessionTest.fixture")(function* (capabilities = true) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-native-" });
  const binaryPath = path.join(root, "kiro-cli");
  const log = path.join(root, "methods.jsonl");
  yield* fs.writeFileString(
    binaryPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.KIRO_TEST_LOG, JSON.stringify({ method: request.method, params: request.params }) + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: ${capabilities ? "{ list: {}, delete: {} }" : "{}"} } };
  else if (request.method === 'session/list') result = { sessions: [
    { sessionId: 'local', cwd: process.cwd(), title: 'Local', _meta: { kiro: { source: 'local' } } },
    { sessionId: 'remote', cwd: process.cwd(), _meta: { kiro: { source: 'remote' } } },
    { sessionId: 'other', cwd: '/other/project' }
  ] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
  );
  yield* fs.chmod(binaryPath, 0o700);
  const input = {
    settings: yield* decodeSettings({ enabled: true, binaryPath }),
    environment: {
      PATH: (yield* HostProcess.Environment).PATH,
      KIRO_HOME: path.join(root, "custom-home"),
      KIRO_TEST_LOG: log,
    },
    cwd: root,
  };
  const methods = fs.readFileString(log).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method),
    ),
  );
  return { input, methods };
});

describe("Kiro native sessions", () => {
  it.live("lists and deletes only local project sessions without creating sessions", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const list = yield* listKiroSessions(fixture.input);
      assert.deepEqual(
        list.sessions.map((session) => session.sessionId),
        ["local"],
      );
      assert.equal(list.canLoad, true);
      assert.equal(list.canResume, false);
      yield* deleteKiroSession({ ...fixture.input, sessionId: "local" });
      assert.deepEqual(yield* fixture.methods, [
        "initialize",
        "session/list",
        "initialize",
        "session/list",
        "session/delete",
      ]);
      const rejected = yield* deleteKiroSession({ ...fixture.input, sessionId: "other" }).pipe(
        Effect.flip,
      );
      assert.equal(rejected.reason, "session_delete_failed");
      assert.equal(
        (yield* fixture.methods).filter((method: string) => method === "session/delete").length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("never sends unadvertised session list or delete methods", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(false);
      const list = yield* listKiroSessions(fixture.input).pipe(Effect.flip);
      const deletion = yield* deleteKiroSession({ ...fixture.input, sessionId: "local" }).pipe(
        Effect.flip,
      );
      assert.equal(list.reason, "session_list_unsupported");
      assert.equal(deletion.reason, "session_delete_unsupported");
      assert.deepEqual(yield* fixture.methods, ["initialize", "initialize"]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
