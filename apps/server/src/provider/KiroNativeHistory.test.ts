// @effect-diagnostics nodeBuiltinImport:off - Fixture bucket hashes must match the native on-disk workspace format.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeKiroNativeHistory } from "@t3tools/provider-kiro/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";

const timestamp = "2026-11-13T00:00:00.000Z";
const row = (id: string, payload: Record<string, unknown>) => ({ id, timestamp, payload });
const complete = [
  row("row-user", { type: "user", content: "CLI request" }),
  row("start", { type: "turn_start", turnId: "not-a-row-id", executionId: "execution-1" }),
  row("thought", { type: "assistant", operationType: "Reasoning", content: "A thought" }),
  row("reply", { type: "assistant", operationType: "Say", content: "CLI response" }),
  row("end", { type: "turn_end", stopReason: "end_turn" }),
];
const fixture = Effect.fn("test.KiroHistory.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-history-" });
  const cwd = `${root}/workspace`;
  const home = `${root}/home`;
  const native = `${home}/.kiro`;
  const nativeId = "sess_synthetic";
  const bucket = NodeCrypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const directory = `${native}/sessions/${bucket}/${nativeId}`;
  const leases = `${native}/session-leases`;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.makeDirectory(leases);
  yield* fs.makeDirectory(cwd);
  const metadata = {
    schemaVersion: "1.0.0",
    id: nativeId,
    title: "Do not import this title",
    workspacePaths: [cwd],
    createdAt: timestamp,
    lastModifiedAt: timestamp,
  };
  const write = (rows = complete) =>
    fs.writeFileString(
      `${directory}/messages.jsonl`,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  yield* fs.writeFileString(`${directory}/session.json`, JSON.stringify(metadata));
  yield* write();
  const reader = yield* makeKiroNativeHistory({ HOME: home, KIRO_HOME: native });
  return {
    fs,
    root,
    cwd,
    home,
    native,
    nativeId,
    directory,
    leases,
    metadata,
    write,
    reader,
    capture: reader.capture({ cwd, nativeId }),
  };
});

it.effect(
  "captures only completed root display rows with separate row identity and reasoning",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const controls = [
        row("summary", { type: "assistant", operationType: "Summary", content: "private summary" }),
        row("system", { type: "system", content: "private system" }),
        row("session-start", {
          type: "session_start",
          content: "unproven prompt",
          messageId: "different",
        }),
        row("tool-call", {
          type: "tool_call",
          toolCallId: "tool-1",
          toolName: "synthetic",
          status: "completed",
          args: { secret: "private tool" },
        }),
        row("tool-result", {
          type: "tool_result",
          toolCallId: "tool-1",
          content: "private result",
          success: true,
        }),
      ];
      yield* h.write([
        row("api-user", { type: "user", source: "api", content: "private runtime instructions" }),
        row("api-reply", {
          type: "assistant",
          operationType: "Say",
          content: "private API response",
        }),
        row("api-end", { type: "turn_end", stopReason: "end_turn" }),
        ...complete.slice(0, -1),
        ...controls,
        complete.at(-1)!,
      ]);
      const capture = yield* h.capture;
      assert.deepEqual(
        capture.rows.filter((r) => r.text !== undefined).map((r) => [r.id, r.kind, r.text]),
        [
          ["row-user", "user", "CLI request"],
          ["thought", "reasoning", "A thought"],
          ["reply", "assistant", "CLI response"],
        ],
      );
      assert.isFalse(JSON.stringify(capture).includes("private"));
      assert.isFalse(JSON.stringify(capture).includes("Do not import"));
      assert.isFalse(JSON.stringify(capture).includes(h.native));
      assert.equal(capture.rows.find((row) => row.id === "start")?.userRowId, "row-user");
      assert.equal(capture.rows.find((row) => row.id === "api-user")?.userRowId, "api-user");
      assert.deepEqual(yield* h.capture, capture);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "ordinary",
  "synthetic",
  "unknown user",
  "unknown assistant",
  "unknown operation",
  "unknown framing",
  "controls",
] as const)("classifies native metadata without silent receipt coverage: %s", (kind) =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const rows = complete.map((row) => ({ ...row, payload: { ...row.payload } }));
    rows[0]!.payload._meta = {
      kiro:
        kind === "synthetic"
          ? { syntheticUserMessageReason: "agent-initiated-prompt" }
          : { peerPromptGeneration: false, userMessageTag: "tag" },
    };
    rows[2]!.payload._meta = { kiro: {} };
    rows[3]!.payload._meta = { kiro: {} };
    if (kind === "unknown user") rows[0]!.payload._meta = { kiro: { unknownFraming: "private" } };
    if (kind === "unknown assistant")
      rows[3]!.payload._meta = { kiro: { unknownFraming: "private" } };
    if (kind === "unknown operation") delete rows[3]!.payload.operationType;
    if (kind === "unknown framing")
      rows[0]!.payload._meta = { kiro: { steeringConsumedIds: ["private"] } };
    if (kind === "controls")
      rows.splice(
        4,
        0,
        row("pending", {
          type: "pending_interaction",
          interactionType: "tool_approval",
          toolCallId: "tool",
          question: "private approval",
          options: [],
          executionId: "execution",
        }),
        row("resolved", {
          type: "interaction_resolved",
          toolCallId: "tool",
          outcome: "approved",
          executionId: "execution",
        }),
        row("memory", {
          type: "session_metadata",
          key: "memoryExposureMessage",
          value: "private memory",
          executionId: "execution",
        }),
      );
    yield* h.write(rows);
    if (kind.startsWith("unknown")) {
      assert.equal((yield* h.capture.pipe(Effect.flip)).status, "unsupported");
    } else {
      const captured = yield* h.capture;
      assert.deepEqual(
        captured.rows.filter((row) => row.text !== undefined).map((row) => row.text),
        kind === "synthetic" ? [] : ["CLI request", "A thought", "CLI response"],
      );
      assert.isFalse(JSON.stringify(captured).includes("private"));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects ancestor ABA substitution during an awaited leaf resolution", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const bucket = NodePath.dirname(h.directory);
    const parked = bucket + "-parked";
    const outside = `${h.root}/OUTSIDE`;
    const outsideSession = `${outside}/${h.nativeId}`;
    yield* h.fs.makeDirectory(outsideSession, { recursive: true });
    yield* h.fs.writeFileString(`${outsideSession}/session.json`, JSON.stringify(h.metadata));
    yield* h.fs.writeFileString(
      `${outsideSession}/messages.jsonl`,
      complete
        .map((r) =>
          JSON.stringify({
            ...r,
            payload: {
              ...r.payload,
              ...(r.payload.type === "user" ? { content: "OUTSIDE MARKER" } : {}),
            },
          }),
        )
        .join("\n") + "\n",
    );
    const lstat = NodeFS.promises.lstat;
    const realpath = NodeFS.promises.realpath;
    const open = NodeFS.promises.open;
    let swapped = false;
    let substitutions = 0;
    const swap = async () => {
      if (swapped) return;
      await NodeFS.promises.rename(bucket, parked);
      await NodeFS.promises.symlink(outside, bucket);
      swapped = true;
      substitutions++;
    };
    const restore = async () => {
      if (!swapped) return;
      await NodeFS.promises.unlink(bucket);
      await NodeFS.promises.rename(parked, bucket);
      swapped = false;
    };
    using _lstat = vi.spyOn(NodeFS.promises, "lstat").mockImplementation(async (...args) => {
      if (
        String(args[0]) === `${h.directory}/session.json` ||
        String(args[0]) === `${h.directory}/messages.jsonl`
      )
        await swap();
      if (
        String(args[0]).startsWith("/proc/self/fd/") &&
        String(args[0]).endsWith("/" + NodePath.basename(bucket))
      )
        await restore();
      return lstat(...args);
    });
    using _realpath = vi.spyOn(NodeFS.promises, "realpath").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(h.directory)) await restore();
      return realpath(...args);
    });
    using _open = vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
      if (
        String(args[0]).startsWith("/proc/self/fd/") &&
        (String(args[0]).endsWith("/session.json") || String(args[0]).endsWith("/messages.jsonl"))
      )
        await swap();
      return open(...args);
    });
    NodeModule.syncBuiltinESMExports();
    const result = yield* h.capture.pipe(
      Effect.result,
      Effect.ensuring(Effect.promise(restore)),
      Effect.ensuring(
        Effect.sync(() => {
          _open.mockRestore();
          _realpath.mockRestore();
          _lstat.mockRestore();
          NodeModule.syncBuiltinESMExports();
        }),
      ),
    );
    assert.isAbove(substitutions, 0);
    assert.isFalse(JSON.stringify(result).includes("OUTSIDE MARKER"));
    if (result._tag === "Success")
      assert.deepEqual(
        result.success.rows.filter((row) => row.text !== undefined).map((row) => row.text),
        ["CLI request", "A thought", "CLI response"],
      );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "binds captures to native ancestor identity even when retained rows are byte-identical",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const before = yield* h.capture;
      yield* h.fs.rename(h.directory, h.directory + "-retired");
      yield* h.fs.makeDirectory(h.directory);
      yield* h.fs.writeFileString(`${h.directory}/session.json`, JSON.stringify(h.metadata));
      yield* h.write();
      const after = yield* h.capture;
      assert.notEqual(after.source, before.source);
      assert.deepEqual(after.rows, before.rows);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["darwin", "win32"] as const)(
  "refuses capture without a descriptor-beneath primitive on %s",
  (platform) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const reader = yield* makeKiroNativeHistory({ HOME: h.home, KIRO_HOME: h.native }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
      );
      assert.equal(
        (yield* reader.capture({ cwd: h.cwd, nativeId: h.nativeId }).pipe(Effect.flip)).status,
        "unsupported",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["live", "stale", "unknown", "lock", "symlink"] as const)(
  "refuses a %s lease without any mutation",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const lease = `${h.leases}/${h.nativeId}.lease${kind === "lock" ? ".lock" : ""}`;
      if (kind === "symlink") {
        yield* h.fs.writeFileString(`${h.root}/foreign`, "foreign");
        yield* h.fs.symlink(`${h.root}/foreign`, lease);
      } else
        yield* h.fs.writeFileString(
          lease,
          kind === "unknown"
            ? "{"
            : JSON.stringify({
                v: 1,
                pid: 999999,
                parentPid: 2,
                instanceId: "foreign",
                hostId: "other-host",
                acquiredAt: timestamp,
                token: "synthetic",
              }),
        );
      if (kind === "stale")
        yield* h.fs.utimes(lease, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000);
      const before = yield* h.fs.stat(lease);
      const contents = yield* h.fs.readFileString(lease);
      const failure = yield* h.capture.pipe(Effect.flip);
      assert.equal(failure.status, kind === "symlink" ? "unsafe" : "busy");
      assert.equal(yield* h.fs.readFileString(lease), contents);
      assert.deepEqual(yield* h.fs.stat(lease), before);
      assert.equal(
        (yield* h.reader.admit({ cwd: h.cwd, nativeId: h.nativeId }).pipe(Effect.flip)).reason,
        "lease_present",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "admits only the exact current runtime's own process and never bypasses a coordination lock",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const lease = `${h.leases}/${h.nativeId}.lease`;
      const stamp = {
        v: 1,
        pid: 123,
        parentPid: 100,
        instanceId: "native-instance",
        hostId: yield* HostProcess.Hostname,
        acquiredAt: timestamp,
        token: "synthetic",
      };
      yield* h.fs.writeFileString(lease, JSON.stringify(stamp));
      yield* h.reader.admit({
        cwd: h.cwd,
        nativeId: h.nativeId,
        ownsProcess: (pid, parentPid) => Effect.succeed(pid === 123 && parentPid === 100),
      });
      assert.equal(
        (yield* h.reader
          .admit({ cwd: h.cwd, nativeId: h.nativeId, ownsProcess: () => Effect.succeed(false) })
          .pipe(Effect.flip)).status,
        "busy",
      );
      yield* h.fs.writeFileString(lease, JSON.stringify({ ...stamp, token: "" }));
      assert.equal(
        (yield* h.reader
          .admit({ cwd: h.cwd, nativeId: h.nativeId, ownsProcess: () => Effect.succeed(true) })
          .pipe(Effect.flip)).status,
        "busy",
      );
      yield* h.fs.writeFileString(lease, JSON.stringify(stamp));
      yield* h.fs.writeFileString(`${lease}.lock`, "coordination");
      assert.equal(
        (yield* h.reader
          .admit({ cwd: h.cwd, nativeId: h.nativeId, ownsProcess: () => Effect.succeed(true) })
          .pipe(Effect.flip)).status,
        "busy",
      );
      assert.equal((yield* h.capture.pipe(Effect.flip)).status, "busy");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "partial",
  "open turn",
  "invalid line",
  "duplicate",
  "tombstone",
  "oversized",
  "cwd",
  "parent",
  "version",
  "metadata",
  "metadata lag",
  "invalid record",
  "file symlink",
  "directory symlink",
  "traversal",
] as const)("defers or refuses %s history", (kind) =>
  Effect.gen(function* () {
    const h = yield* fixture();
    switch (kind) {
      case "partial":
        yield* h.fs.writeFileString(`${h.directory}/messages.jsonl`, JSON.stringify(complete[0]));
        break;
      case "open turn":
        yield* h.write(complete.slice(0, -1));
        break;
      case "invalid line":
        yield* h.fs.writeFileString(`${h.directory}/messages.jsonl`, "{bad}\n");
        break;
      case "duplicate":
        yield* h.write([...complete, complete[0]!]);
        break;
      case "tombstone":
        yield* h.write([
          ...complete,
          row("tombstone", {
            type: "tombstone",
            kind: "summarization",
            effectiveFromMessageId: "row-user",
          }),
        ]);
        break;
      case "oversized":
        yield* h.write([
          row("user", { type: "user", content: "a".repeat(262145) }),
          complete.at(-1)!,
        ]);
        break;
      case "cwd":
        yield* h.fs.writeFileString(
          `${h.directory}/session.json`,
          JSON.stringify({ ...h.metadata, workspacePaths: [h.root] }),
        );
        break;
      case "parent":
        yield* h.fs.writeFileString(
          `${h.directory}/session.json`,
          JSON.stringify({ ...h.metadata, parentExecutionId: "parent" }),
        );
        break;
      case "version":
        yield* h.fs.writeFileString(
          `${h.directory}/session.json`,
          JSON.stringify({ ...h.metadata, schemaVersion: "unknown" }),
        );
        break;
      case "metadata lag":
        yield* h.fs.writeFileString(
          `${h.directory}/session.json`,
          JSON.stringify({
            ...h.metadata,
            createdAt: "2026-11-12T00:00:00.000Z",
            lastModifiedAt: "2026-11-12T00:00:00.000Z",
          }),
        );
        break;
      case "invalid record":
        yield* h.write([...complete, row("invalid", { type: "user", content: 42 })]);
        break;
      case "metadata":
        yield* h.fs.writeFileString(`${h.directory}/session.json`, "{");
        break;
      case "file symlink":
        yield* h.fs.rename(`${h.directory}/messages.jsonl`, `${h.root}/outside`);
        yield* h.fs.symlink(`${h.root}/outside`, `${h.directory}/messages.jsonl`);
        break;
      case "directory symlink":
        yield* h.fs.rename(h.directory, `${h.root}/outside`);
        yield* h.fs.symlink(`${h.root}/outside`, h.directory);
        break;
      case "traversal":
        break;
    }
    const failure = yield* h.reader
      .capture({ cwd: h.cwd, nativeId: kind === "traversal" ? "../escape" : h.nativeId })
      .pipe(Effect.flip);
    assert.equal(
      failure.status,
      kind === "partial" || kind === "open turn" || kind === "metadata lag"
        ? "busy"
        : kind === "version"
          ? "unsupported"
          : "unsafe",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
