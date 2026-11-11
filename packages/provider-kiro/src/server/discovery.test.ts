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
import { kiroDiscoveredAgentDescriptor, makeKiroDiscovery } from "./discovery.ts";

const resources = (name: string) => ({
  resources: [
    {
      type: "agent",
      items: [
        {
          layer: "workspace",
          standing: { kind: "active" },
          value: { id: name, name, description: "Project agent" },
        },
      ],
    },
    {
      type: "skill",
      items: [
        {
          layer: "workspace",
          standing: { kind: "active" },
          value: { name, uri: `file:///workspace/${name}/SKILL.md` },
        },
        { layer: "workspace", standing: { kind: "blocked" }, value: { name: "policy-disabled" } },
      ],
    },
  ],
});

describe("Kiro workspace discovery", () => {
  it.live(
    "respects native policy, workspace isolation, custom homes and explicit cache invalidation without creating sessions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-discovery-" });
        const binaryPath = path.join(root, "kiro-cli");
        const state = path.join(root, "resources.json");
        const log = path.join(root, "requests.jsonl");
        const customHome = path.join(root, "custom-home");
        const a = path.join(root, "a");
        const b = path.join(root, "b");
        yield* fs.makeDirectory(a);
        yield* fs.makeDirectory(b);
        yield* fs.writeFileString(
          state,
          JSON.stringify({ [a]: resources("agent-a"), [b]: resources("agent-b") }),
        );
        yield* fs.writeFileString(
          binaryPath,
          `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.KIRO_TEST_LOG, JSON.stringify({ method: request.method, cwd: process.cwd(), home: process.env.KIRO_HOME, offline: process.env.MISE_OFFLINE, classifier: process.env.KIRO_TRUST_CLASSIFIER_MODE }) + '\\n');
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { _meta: { kiro: { extensionMethods: ['_kiro/configuration/getState'] } } } }
    : JSON.parse(readFileSync(process.env.KIRO_TEST_STATE, 'utf8'))[request.params.roots[0]];
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
        );
        yield* fs.chmod(binaryPath, 0o700);
        const environment = Object.freeze({
          PATH: (yield* HostProcess.Environment).PATH,
          HOME: customHome,
          KIRO_HOME: customHome,
          KIRO_TEST_STATE: state,
          KIRO_TEST_LOG: log,
          MISE_OFFLINE: "0",
          KIRO_TRUST_CLASSIFIER_MODE: "enforce",
        });
        const discovery = yield* makeKiroDiscovery(
          yield* decodeSettings({ enabled: true, binaryPath }),
          environment,
        );
        const first = yield* discovery.get(a);
        assert.deepEqual(
          first?.skills.map((skill) => skill.name),
          ["agent-a"],
        );
        assert.deepEqual(first && kiroDiscoveredAgentDescriptor(first, undefined)?.type, "select");
        assert.strictEqual(yield* discovery.get(a), first);
        assert.deepEqual(
          (yield* discovery.get(b))?.skills.map((skill) => skill.name),
          ["agent-b"],
        );
        yield* fs.writeFileString(
          state,
          JSON.stringify({ [a]: { resources: [] }, [b]: resources("agent-b") }),
        );
        yield* discovery.invalidate;
        assert.deepEqual((yield* discovery.get(a))?.skills, []);
        const requests: Array<{
          method: string;
          home: string;
          cwd: string;
          offline: string;
          classifier: string;
        }> = (yield* fs.readFileString(log))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(
          requests.map((request) => request.method),
          [
            "initialize",
            "_kiro/configuration/getState",
            "initialize",
            "_kiro/configuration/getState",
            "initialize",
            "_kiro/configuration/getState",
          ],
        );
        assert.isTrue(requests.every((request) => request.home === customHome));
        assert.isTrue(requests.every((request) => request.classifier === "off"));
        assert.deepEqual(
          requests.map((request) => request.cwd),
          [a, a, b, b, a, a],
        );
        assert.isTrue(requests.every((request) => request.offline === "1"));
        assert.strictEqual(environment.MISE_OFFLINE, "0");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
