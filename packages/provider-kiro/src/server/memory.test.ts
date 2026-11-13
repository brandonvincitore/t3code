import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { KiroMemoryCreate } from "@t3tools/contracts";
import { makeKiroMemoryController } from "./memory.ts";

const entry = {
  id: "memory-1",
  memoryType: "SEMANTIC",
  scopes: ["Global"],
  title: "project-conventions",
  summary: "Use the existing conventions.",
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
} as const;
const detail = { ...entry, content: "Private project convention text." };
const methods = ["list", "get", "create", "update", "delete", "getSyncStatus", "sync"].map(
  (name) => `_kiro/memory/${name}`,
);

const setup = Effect.fn("test.memory.setup")(function* (advertised = methods) {
  const requests: Array<{ cwd: string; method: string; params: unknown }> = [];
  const responses = new Map<string, unknown>([
    [
      "list",
      { memories: [entry], total: 1, counts: { byType: { SEMANTIC: 1 }, byScope: { Global: 1 } } },
    ],
    ["get", { memory: detail }],
    ["create", { id: entry.id, memory: detail }],
    ["update", { memory: detail }],
    ["delete", { id: entry.id, title: entry.title }],
    ["getSyncStatus", { state: "synced", lastSyncAt: "2026-11-08T00:00:00.000Z", pending: 0 }],
    ["sync", { state: "off" }],
  ]);
  let initializes = 0;
  let closes = 0;
  const controller = yield* makeKiroMemoryController({
    settings: {
      binaryPath: "kiro-cli",
      enabled: true,
      customModels: [],
      memoryMode: "default",
      contentCollection: "default",
    },
    environment: {},
    makeRuntime: (cwd) =>
      Effect.acquireRelease(
        Effect.succeed({
          initialize: () =>
            Effect.sync(() => {
              initializes += 1;
              return {
                protocolVersion: 1,
                agentCapabilities: { _meta: { kiro: { extensionMethods: advertised } } },
              };
            }),
          request: (method, params) =>
            Effect.sync(() => {
              requests.push({ cwd, method, params });
              return responses.get(method.slice("_kiro/memory/".length));
            }),
        }),
        () =>
          Effect.sync(() => {
            closes += 1;
          }),
      ),
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size)),
    ),
  );
  return { controller, requests, responses, initializes: () => initializes, closes: () => closes };
});

describe("Kiro native memory", () => {
  it.effect("uses bounded native pagination and inspects content only through get", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.responses.set("list", {
        memories: [{ ...entry, content: detail.content }],
        total: 1,
        nextCursor: "native-page",
        counts: { byType: { SEMANTIC: 1 }, byScope: { Global: 1 } },
      });
      const result = yield* h.controller.list({
        cwd: "/workspace/project",
        limit: 25,
        query: "conventions",
        scopes: ["Global"],
      });
      assert.deepEqual(h.requests, [
        {
          cwd: "/workspace/project",
          method: "_kiro/memory/list",
          params: { limit: 25, query: "conventions", scopes: ["Global"] },
        },
      ]);
      assert.ok(!("content" in result.memories[0]!));
      assert.equal(result.nextCursor, "native-page");
      assert.ok(result.nextCursor);
      assert.deepEqual(yield* h.controller.get({ cwd: "/workspace/project", id: entry.id }), {
        memory: detail,
      });
      yield* h.controller.list({ cwd: "/workspace/other", cursor: result.nextCursor });
      assert.deepEqual(h.requests.at(-1), {
        cwd: "/workspace/other",
        method: "_kiro/memory/list",
        params: { cursor: "native-page", limit: 50 },
      });
      assert.equal(h.initializes(), 3);
      assert.equal(h.closes(), 3);
    }),
  );

  it.effect(
    "gates every optional method before sending and rejects unsupported output without content in errors",
    () =>
      Effect.gen(function* () {
        const h = yield* setup(["_kiro/memory/list"]);
        assert.equal(
          (yield* h.controller.get({ cwd: "/project", id: entry.id }).pipe(Effect.flip)).code,
          "unsupported",
        );
        assert.equal(h.requests.length, 0);
        h.responses.set("list", {
          memories: [{ ...entry, title: detail.content.repeat(100) }],
          total: 1,
          counts: { byType: {}, byScope: {} },
        });
        const invalid = yield* h.controller.list({ cwd: "/project" }).pipe(Effect.flip);
        assert.equal(invalid.code, "invalid_response");
        assert.ok(!JSON.stringify(invalid).includes(detail.content));
      }),
  );

  it.effect(
    "translates native create, update, delete and sync without inventing a scope mutation",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const input = {
          memoryType: "SEMANTIC" as const,
          scopes: ["workspace:project"],
          title: entry.title,
          summary: entry.summary,
          content: detail.content,
        };
        assert.deepEqual(yield* h.controller.create({ cwd: "/project", ...input }), {
          id: entry.id,
          memory: detail,
        });
        yield* h.controller.update({
          cwd: "/project",
          id: entry.id,
          newTitle: "updated-conventions",
          content: "Updated text.",
        });
        assert.deepEqual(h.requests[0]?.params, input);
        assert.deepEqual(h.requests[1]?.params, {
          id: entry.id,
          newTitle: "updated-conventions",
          content: "Updated text.",
        });
        assert.deepEqual(yield* h.controller.delete({ cwd: "/project", id: entry.id }), {
          id: entry.id,
          title: entry.title,
        });
        assert.equal((yield* h.controller.getSyncStatus({ cwd: "/project" })).state, "synced");
        assert.equal((yield* h.controller.sync({ cwd: "/project" })).state, "off");
        assert.deepEqual(h.requests.at(-1)?.params, {});
      }),
  );

  it.effect("validates native write bounds and empty updates before invoking Kiro", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      assert.equal(
        (yield* h.controller.update({ cwd: "/project", id: entry.id }).pipe(Effect.flip)).code,
        "invalid_input",
      );
      const valid = {
        memoryType: "SEMANTIC" as const,
        scopes: ["Global"],
        title: "valid-title",
        summary: "Summary",
        content: "Content",
      };
      const isValid = Schema.is(KiroMemoryCreate);
      for (const invalid of [
        { ...valid, title: "spaces disallowed" },
        { ...valid, summary: "s".repeat(251) },
        { ...valid, content: "c".repeat(20_001) },
        { ...valid, scopes: [] },
      ]) {
        assert.isFalse(isValid(invalid));
        assert.equal(
          (yield* h.controller.create({ cwd: "/project", ...invalid }).pipe(Effect.flip)).code,
          "invalid_input",
        );
      }
      assert.equal(h.requests.length, 0);
    }),
  );
});
