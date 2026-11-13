import { makeNativeExportCapture, type NativeHistoryExportOptions } from "./nativeHistoryExport.ts";
// @effect-diagnostics nodeBuiltinImport:off - No-follow reads and descriptor identity checks protect native files from path substitution.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NativeHistoryReadError } from "@t3tools/contracts";
import type {
  NativeHistoryCapture,
  NativeHistoryReader,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Node exposes no portable openat; capture needs the Linux descriptor path boundary.
const MAX_BYTES = 8 * 1_024 * 1_024;
const MAX_ROWS = 4_096;
const MAX_TEXT = 256 * 1_024;
const hash = (text: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
const Metadata = Schema.Struct({
  schemaVersion: Schema.String,
  dataModelVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  id: Schema.String,
  workspacePaths: Schema.Array(Schema.String),
  rootPaths: Schema.optional(Schema.Array(Schema.String)),
  createdAt: Schema.String,
  lastModifiedAt: Schema.String,
  parentSessionId: Schema.optional(Schema.Unknown),
  parentExecutionId: Schema.optional(Schema.Unknown),
  forkedAtMessageId: Schema.optional(Schema.Unknown),
  executionTarget: Schema.optional(Schema.Unknown),
  workflowLaunch: Schema.optional(Schema.Unknown),
  _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const Row = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  ),
  timestamp: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const payloadSchemas = {
  user: Schema.Struct({
    type: Schema.Literal("user"),
    content: Schema.String,
    source: Schema.optional(Schema.Literals(["chat", "hook", "api", "steer"])),
  }),
  assistant: Schema.Struct({
    type: Schema.Literal("assistant"),
    content: Schema.String,
    operationType: Schema.optional(Schema.Literals(["Say", "Print", "Reasoning", "Summary"])),
  }),
  turn_start: Schema.Struct({ type: Schema.Literal("turn_start") }),
  turn_end: Schema.Struct({
    type: Schema.Literal("turn_end"),
    stopReason: Schema.String.check(Schema.isMinLength(1)),
  }),
  session_start: Schema.Struct({
    type: Schema.Literal("session_start"),
    content: Schema.String,
    messageId: Schema.String,
  }),
  system: Schema.Struct({ type: Schema.Literal("system"), content: Schema.String }),
  agent_note: Schema.Struct({ type: Schema.Literal("agent_note"), content: Schema.String }),
  tool_call: Schema.Struct({
    type: Schema.Literal("tool_call"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
    status: Schema.String,
  }),
  tool_result: Schema.Struct({
    type: Schema.Literal("tool_result"),
    toolCallId: Schema.String,
    content: Schema.String,
    success: Schema.Boolean,
  }),
  tool_revert: Schema.Struct({ type: Schema.Literal("tool_revert"), toolCallId: Schema.String }),
  error: Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  mode_change: Schema.Struct({
    type: Schema.Literal("mode_change"),
    fromMode: Schema.String,
    toMode: Schema.String,
  }),
  session_event: Schema.Struct({
    type: Schema.Literal("session_event"),
    category: Schema.Literals([
      "session_start",
      "session_restore",
      "session_pause",
      "session_resume",
    ]),
  }),
  steering_inclusion: Schema.Struct({
    type: Schema.Literal("steering_inclusion"),
    documents: Schema.Array(Schema.Unknown),
  }),
  sub_agent_start: Schema.Struct({
    type: Schema.Literal("sub_agent_start"),
    parentExecutionId: Schema.String,
    subSessionId: Schema.String,
    subAgentName: Schema.String,
    prompt: Schema.String,
    explanation: Schema.String,
  }),
  sub_agent_complete: Schema.Struct({
    type: Schema.Literal("sub_agent_complete"),
    parentExecutionId: Schema.String,
    subSessionId: Schema.String,
    response: Schema.String,
    status: Schema.Literals(["success", "error", "cancelled"]),
  }),
  sub_agent_progress: Schema.Struct({
    type: Schema.Literal("sub_agent_progress"),
    parentExecutionId: Schema.String,
    subSessionId: Schema.String,
    message: Schema.String,
  }),
  usage_summary: Schema.Struct({
    type: Schema.Literal("usage_summary"),
    promptTurnSummaries: Schema.Array(Schema.Unknown),
  }),
  pending_interaction: Schema.Struct({
    type: Schema.Literal("pending_interaction"),
    interactionType: Schema.Literals(["tool_approval", "user_input"]),
    toolCallId: Schema.String,
    question: Schema.String,
    options: Schema.Array(Schema.Unknown),
    executionId: Schema.String,
    consentRound: Schema.optional(Schema.Number),
    _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  interaction_resolved: Schema.Struct({
    type: Schema.Literal("interaction_resolved"),
    toolCallId: Schema.String,
    outcome: Schema.String,
    selectedOption: Schema.optional(Schema.Unknown),
    executionId: Schema.String,
    consentRound: Schema.optional(Schema.Number),
    rejectionReason: Schema.optional(Schema.String),
  }),
  session_metadata: Schema.Struct({
    type: Schema.Literal("session_metadata"),
    turnId: Schema.optional(Schema.String),
    key: Schema.String,
    value: Schema.Unknown,
    executionId: Schema.String,
  }),
  ContextualHookInvoked: Schema.Struct({
    type: Schema.Literal("ContextualHookInvoked"),
    hookId: Schema.String,
    operationId: Schema.String,
    name: Schema.String,
    hookActionType: Schema.Literals(["askAgent", "runCommand"]),
    status: Schema.String,
  }),
};
const validPayload = Schema.is(Schema.Union(Object.values(payloadSchemas)));
const parseMetadata = Schema.decodeUnknownSync(Schema.fromJsonString(Metadata));
const parseRow = Schema.decodeUnknownSync(Schema.fromJsonString(Row));
const LeaseIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9-]+$/),
);
const Lease = Schema.Struct({
  v: Schema.Literal(1),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  parentPid: Schema.Int.check(Schema.isGreaterThan(0)),
  instanceId: LeaseIdentifier,
  hostId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  acquiredAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  token: LeaseIdentifier,
  clientName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
const parseLease = Schema.decodeUnknownSync(Schema.fromJsonString(Lease));
const isHistoryReadError = Schema.is(NativeHistoryReadError);
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const fingerprint = (capture: {
  metadata: { text: string; stamp: string };
  transcript: { text: string; stamp: string };
  directory: string;
}) =>
  hash(
    encodeIdentity([
      hash(capture.metadata.text),
      capture.metadata.stamp,
      hash(capture.transcript.text),
      capture.transcript.stamp,
      capture.directory,
    ]),
  );
function fail(
  status: NativeHistoryReadError["status"],
  reason: NativeHistoryReadError["reason"],
): never {
  throw new NativeHistoryReadError({ status, reason });
}
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const normalize = (value: string, platform: NodeJS.Platform) => {
  const normalized = NodePath.posix
    .normalize(NodePath.resolve(value).replace(/\\/g, "/"))
    .replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};
const statKey = (stat: Awaited<ReturnType<typeof NodeFSP.stat>>) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`;

async function directory(value: string) {
  if (!(await NodeFSP.lstat(value)).isDirectory() || (await NodeFSP.realpath(value)) !== value)
    fail("unsafe", "invalid_source");
}
async function bounded(file: string, limit: number) {
  const before = await NodeFSP.lstat(file);
  if (!before.isFile() || before.size > limit) fail("unsafe", "invalid_source");
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (statKey(before) !== statKey(opened)) fail("busy", "source_changed");
    const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await NodeFSP.lstat(file);
    if (
      size !== before.size ||
      statKey(before) !== statKey(after) ||
      statKey(after) !== statKey(current) ||
      (await NodeFSP.realpath(file)) !== file
    )
      fail("busy", "source_changed");
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
      stamp: statKey(current),
    };
  } finally {
    await handle.close();
  }
}
async function nativeRoot(
  environment: NodeJS.ProcessEnv,
  fallbackHome: string,
  platform: NodeJS.Platform,
  allowMissing = false,
) {
  const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || fallbackHome;
  if (!NodePath.isAbsolute(home)) fail("unsafe", "invalid_source");
  const override = environment.KIRO_HOME?.trim();
  let root = NodePath.join(home, ".kiro");
  if (override && NodePath.isAbsolute(override)) {
    const actual = await NodeFSP.realpath(override).catch((error) => {
      if (missing(error)) return NodePath.resolve(override);
      throw error;
    });
    const actualHome = await NodeFSP.realpath(home).catch((error) => {
      if (missing(error)) return NodePath.resolve(home);
      throw error;
    });
    const relative = NodePath.relative(actual, actualHome);
    if (
      actual !== NodePath.parse(actual).root &&
      relative !== "" &&
      (relative.startsWith(`..${NodePath.sep}`) ||
        relative === ".." ||
        NodePath.isAbsolute(relative))
    )
      root = NodePath.resolve(override);
  }
  // Reject aliases rather than silently rebinding a receipt to another native home.
  try {
    await directory(root);
  } catch (error) {
    if (!allowMissing || !missing(error)) throw error;
  }
  return root;
}
async function leaseAt(root: string, id: string) {
  const dir = NodePath.join(root, "session-leases");
  try {
    await directory(dir);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const file = NodePath.join(dir, `${id}.lease`);
  for (const candidate of [`${file}.lock`, file]) {
    try {
      await NodeFSP.lstat(candidate);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (candidate.endsWith(".lock")) fail("busy", "lease_present");
    return await bounded(file, 8_192);
  }
}

type DirectoryHandle = Awaited<ReturnType<typeof NodeFSP.open>>;
const inode = (stat: Awaited<ReturnType<typeof NodeFSP.stat>>) => `${stat.dev}:${stat.ino}`;
async function anchoredRoot(root: string) {
  const frames: Array<{
    handle: DirectoryHandle;
    parent?: DirectoryHandle;
    name: string;
    identity: string;
  }> = [];
  const openedDirectories = new Map<string, DirectoryHandle>();
  const at = (parent: DirectoryHandle, name: string) => `/proc/self/fd/${parent.fd}/${name}`;
  const close = async () => {
    for (const frame of frames.toReversed()) await frame.handle.close();
  };
  const enter = async (parent: DirectoryHandle | undefined, name: string) => {
    const path = parent ? at(parent, name) : "/";
    const existing = openedDirectories.get(path);
    if (existing) return existing;
    const handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    frames.push({ handle, ...(parent ? { parent } : {}), name, identity: inode(stat) });
    if (!stat.isDirectory()) fail("unsafe", "invalid_source");
    openedDirectories.set(path, handle);
    return handle;
  };
  try {
    const parts = root.split("/").filter(Boolean);
    if (parts.length > 64 || root !== NodePath.resolve(root)) fail("unsafe", "invalid_source");
    let handle = await enter(undefined, "");
    for (const part of parts) handle = await enter(handle, part);
    const native = handle;
    const rootIdentity = inode(await native.stat());
    const read = async (parent: DirectoryHandle, name: string, limit: number) => {
      const file = at(parent, name);
      const handle = await NodeFSP.open(
        file,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > limit) fail("unsafe", "invalid_source");
        const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1));
        let size = 0;
        while (size < buffer.length) {
          const read = await handle.read(buffer, size, buffer.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        const after = await handle.stat();
        const current = await NodeFSP.lstat(file);
        if (
          size !== before.size ||
          statKey(before) !== statKey(after) ||
          statKey(after) !== statKey(current)
        )
          fail("busy", "source_changed");
        return {
          text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
          stamp: statKey(current),
        };
      } finally {
        await handle.close();
      }
    };
    const lease = async (id: string) => {
      let leases: DirectoryHandle;
      try {
        leases = await enter(native, "session-leases");
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      try {
        await NodeFSP.lstat(at(leases, `${id}.lease.lock`));
        fail("busy", "lease_present");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      try {
        return await read(leases, `${id}.lease`, 8192);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    };
    const verify = async () => {
      for (const frame of frames) {
        if (
          inode(await frame.handle.stat()) !== frame.identity ||
          (frame.parent &&
            inode(await NodeFSP.lstat(at(frame.parent, frame.name))) !== frame.identity)
        )
          fail("busy", "source_changed");
      }
      return frames.map((frame) => frame.identity).join("/");
    };
    return { native, rootIdentity, enter, read, lease, verify, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function admissionLease(root: string, id: string, platform: NodeJS.Platform) {
  if (platform !== "linux") return leaseAt(root, id);
  let anchored: Awaited<ReturnType<typeof anchoredRoot>>;
  try {
    anchored = await anchoredRoot(root);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  try {
    const lease = await anchored.lease(id);
    await anchored.verify();
    return lease;
  } finally {
    await anchored.close();
  }
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
function visibleMetadata(payload: Record<string, unknown>): boolean {
  if (payload._meta === undefined) return true;
  if (!isRecord(payload._meta) || Object.keys(payload._meta).some((key) => key !== "kiro"))
    fail("unsupported", "invalid_source");
  const kiro = payload._meta.kiro;
  if (kiro === undefined) return true;
  if (!isRecord(kiro)) fail("unsupported", "invalid_source");
  const hidden = [
    "syntheticUserMessageReason",
    "notification",
    "peerMessage",
    "peerReceiverPromptGeneration",
    "agentInitiated",
    "agentInitiatedReason",
    "agentInitiatedPromptFramed",
  ];
  if (hidden.some((key) => kiro[key] !== undefined)) return false;
  const benign = ["peerPromptGeneration", "userMessageTag", "classifierApproved", "classifierFlag"];
  if (Object.keys(kiro).some((key) => !benign.includes(key))) fail("unsupported", "invalid_source");
  if (
    (kiro.userMessageTag !== undefined && typeof kiro.userMessageTag !== "string") ||
    (kiro.classifierApproved !== undefined && typeof kiro.classifierApproved !== "boolean")
  )
    fail("unsafe", "invalid_source");
  return true;
}

function materialize(text: string): NativeHistoryCapture["rows"] {
  if (text.length > 0 && !text.endsWith("\n")) fail("busy", "incomplete");
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  if (lines.length > MAX_ROWS) fail("unsafe", "invalid_source");
  const rows: Array<NativeHistoryCapture["rows"][number]> = [];
  const seen = new Set<string>();
  let user: string | undefined;
  let closed = true;
  let displayTurn = false;
  let totalText = 0;
  for (const line of lines) {
    if (!line.trim()) fail("unsafe", "invalid_source");
    const row = parseRow(line);
    if (seen.has(row.id) || !Number.isFinite(Date.parse(row.timestamp)))
      fail("unsafe", "invalid_source");
    seen.add(row.id);
    const payload = row.payload;
    if (payload.type === "tombstone") fail("unsafe", "source_changed");
    if (!validPayload(payload))
      fail(
        typeof payload.type === "string" && !(payload.type in payloadSchemas)
          ? "unsupported"
          : "unsafe",
        "invalid_source",
      );
    let kind: NativeHistoryCapture["rows"][number]["kind"] = "control";
    let content: string | undefined;
    let boundary: "start" | "end" | undefined;
    if (payload.type === "user") {
      const internal = payload.source === "hook" || payload.source === "steer";
      if (!closed && !internal) fail("unsafe", "invalid_source");
      if (!internal) {
        if (payload.source !== undefined && payload.source !== "chat" && payload.source !== "api")
          fail("unsupported", "unsupported");
        user = row.id;
        closed = false;
        kind = "user";
        if (payload.kind !== undefined) fail("unsupported", "invalid_source");
        displayTurn =
          (payload.source === undefined || payload.source === "chat") &&
          payload.kind === undefined &&
          visibleMetadata(payload);
        if (displayTurn)
          content = typeof payload.content === "string" ? payload.content : undefined;
        else if (typeof payload.content !== "string") fail("unsafe", "invalid_source");
      }
    } else if (payload.type === "turn_start") {
      boundary = "start";
    } else if (payload.type === "turn_end") {
      if (!user || closed || typeof payload.stopReason !== "string")
        fail("unsafe", "invalid_source");
      closed = true;
      for (let index = rows.length - 1; index >= 0 && rows[index]?.userRowId === user; index--) {
        rows[index] = {
          ...rows[index]!,
          status:
            payload.stopReason === "end_turn" && payload.boundarySource !== "recovered"
              ? "completed"
              : "interrupted",
        };
      }
      boundary = "end";
    } else if (payload.type === "assistant") {
      if (!user || closed) fail("unsafe", "invalid_source");
      if (
        displayTurn &&
        payload.subExecutionId === undefined &&
        payload.operationType === undefined
      )
        fail("unsupported", "invalid_source");
      if (
        displayTurn &&
        payload.subExecutionId === undefined &&
        visibleMetadata(payload) &&
        payload.reasoningRedactedContent === undefined
      ) {
        if (payload.operationType === "Say" || payload.operationType === "Print")
          kind = "assistant";
        else if (payload.operationType === "Reasoning") kind = "reasoning";
        if (kind !== "control")
          content = typeof payload.content === "string" ? payload.content : undefined;
      }
    }
    if (kind !== "control" && (kind !== "user" || displayTurn)) {
      if (content === undefined || content.length > MAX_TEXT) fail("unsafe", "invalid_source");
      totalText += content.length;
      if (totalText > 2 * 1_024 * 1_024) fail("unsafe", "invalid_source");
    }
    rows.push({
      id: row.id,
      digest: hash(line),
      timestamp: row.timestamp,
      kind,
      ...(content === undefined ? {} : { text: content }),
      ...(user === undefined ? {} : { userRowId: user }),
      ...(boundary === undefined ? {} : { boundary }),
    });
  }
  if (!closed) fail("busy", "incomplete");
  return rows;
}

function validateRecord(text: string, cwd: string, nativeId: string, platform: NodeJS.Platform) {
  const record = parseMetadata(text);
  if (record.schemaVersion !== "1.0.0") fail("unsupported", "unsupported");
  if (
    record.id !== nativeId ||
    record.workspacePaths.length !== 1 ||
    record.workspacePaths.some(
      (p) => !NodePath.isAbsolute(p) || normalize(p, platform) !== normalize(cwd, platform),
    ) ||
    record.rootPaths?.some(
      (p) => !NodePath.isAbsolute(p) || normalize(p, platform) !== normalize(cwd, platform),
    ) ||
    record.parentSessionId !== undefined ||
    record.parentExecutionId !== undefined ||
    record.forkedAtMessageId !== undefined ||
    record.workflowLaunch !== undefined ||
    (record.executionTarget !== undefined && record.executionTarget !== "local") ||
    (record._meta !== undefined && Object.keys(record._meta).length > 0) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.lastModifiedAt)) ||
    Date.parse(record.lastModifiedAt) < Date.parse(record.createdAt)
  )
    fail("unsafe", "invalid_source");
  return record;
}
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) fail("unsafe", "invalid_source");
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item, depth + 1)]),
    );
  return value;
}

export const makeKiroNativeHistory = Effect.fn("KiroNativeHistory.make")(function* (
  environment: NodeJS.ProcessEnv,
  exportOptions?: NativeHistoryExportOptions,
) {
  const fallbackHome = yield* HostProcess.HomeDirectory;
  const host = yield* HostProcess.Hostname;
  const platform = yield* HostProcess.Platform;
  const capture: NativeHistoryReader["capture"] = Effect.fn("KiroNativeHistory.capture")(
    ({ cwd, nativeId }) =>
      Effect.tryPromise({
        try: async () => {
          if (
            !NodePath.isAbsolute(cwd) ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(nativeId) ||
            nativeId.toLowerCase() === "workflows"
          )
            fail("unsafe", "invalid_source");
          if (platform !== "linux") fail("unsupported", "unsupported");
          const root = await nativeRoot(environment, fallbackHome, platform);
          const workspace = normalize(cwd, platform);
          const bucket = hash(workspace).slice(0, 16);
          const anchored = await anchoredRoot(root);
          try {
            if (await anchored.lease(nativeId)) fail("busy", "lease_present");
            const sessions = await anchored.enter(anchored.native, "sessions");
            const workspaceDirectory = await anchored.enter(sessions, bucket);
            const session = await anchored.enter(workspaceDirectory, nativeId);
            const observe = async () => {
              if (await anchored.lease(nativeId)) fail("busy", "lease_present");
              const metadata = await anchored.read(session, "session.json", 65_536);
              const transcript = await anchored.read(session, "messages.jsonl", MAX_BYTES);
              if (await anchored.lease(nativeId)) fail("busy", "lease_present");
              return {
                metadata,
                transcript,
                directory: (await anchored.verify()) + statKey(await session.stat()),
              };
            };
            const first = await observe();
            const record = validateRecord(first.metadata.text, cwd, nativeId, platform);
            const rows = materialize(first.transcript.text);
            if (rows.some((row) => Date.parse(row.timestamp) > Date.parse(record.lastModifiedAt)))
              fail("busy", "incomplete");
            const second = await observe();
            if (fingerprint(first) !== fingerprint(second)) fail("busy", "source_changed");
            return {
              source: hash(
                encodeIdentity([
                  root,
                  anchored.rootIdentity,
                  inode(await sessions.stat()),
                  inode(await workspaceDirectory.stat()),
                  inode(await session.stat()),
                  workspace,
                  nativeId,
                  record.schemaVersion,
                  record.createdAt,
                ]),
              ),
              identity: fingerprint(second),
              rows,
            };
          } finally {
            await anchored.close();
          }
        },
        catch: (error) =>
          isHistoryReadError(error)
            ? error
            : new NativeHistoryReadError({
                status: missing(error) ? "unavailable" : "unsafe",
                reason: missing(error) ? "unavailable" : "invalid_source",
              }),
      }),
  );
  const admit = Effect.fn("KiroNativeHistory.admit")(
    (input: {
      cwd: string;
      nativeId: string;
      ownsProcess?: (pid: number, parentPid: number, acquiredAt: string) => Effect.Effect<boolean>;
    }) =>
      Effect.gen(function* () {
        const lease = yield* Effect.tryPromise({
          try: async () => {
            if (!NodePath.isAbsolute(input.cwd) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.nativeId))
              fail("unsafe", "invalid_source");
            return admissionLease(
              await nativeRoot(environment, fallbackHome, platform, true),
              input.nativeId,
              platform,
            );
          },
          catch: () => new NativeHistoryReadError({ status: "busy", reason: "lease_present" }),
        });
        if (lease === undefined) return;
        const stamp = yield* Effect.try({
          try: () => parseLease(lease.text),
          catch: () => new NativeHistoryReadError({ status: "busy", reason: "lease_present" }),
        });
        if (
          Number.isFinite(Date.parse(stamp.acquiredAt)) &&
          stamp.hostId === host &&
          input.ownsProcess &&
          (yield* input.ownsProcess(stamp.pid, stamp.parentPid, stamp.acquiredAt))
        ) {
          const current = yield* Effect.tryPromise({
            try: async () =>
              admissionLease(
                await nativeRoot(environment, fallbackHome, platform),
                input.nativeId,
                platform,
              ),
            catch: () => new NativeHistoryReadError({ status: "busy", reason: "lease_present" }),
          });
          if (current?.text === lease.text) return;
        }
        return yield* new NativeHistoryReadError({ status: "busy", reason: "lease_present" });
      }),
  );
  const exported =
    exportOptions === undefined
      ? undefined
      : yield* makeNativeExportCapture({
          environment,
          options: exportOptions,
          observeLease: (cwd, nativeId) => admit({ cwd, nativeId }),
          normalize: (path) => normalize(path, platform),
          parse: (metadata, transcript, cwd, nativeId) =>
            Effect.tryPromise({
              try: async () => {
                if (
                  Buffer.byteLength(metadata) > 65536 ||
                  Buffer.byteLength(transcript) > MAX_BYTES ||
                  !transcript.endsWith("\n")
                )
                  fail("unsafe", "invalid_source");
                const record = validateRecord(metadata, cwd, nativeId, platform);
                const lines = transcript.slice(0, -1).split("\n");
                if (lines.length > MAX_ROWS) fail("unsafe", "invalid_source");
                const normalized =
                  lines.map((line) => encodeJson(canonical(decodeJson(line)))).join("\n") + "\n";
                const rows = materialize(normalized);
                if (
                  rows.some((row) => Date.parse(row.timestamp) > Date.parse(record.lastModifiedAt))
                )
                  fail("busy", "incomplete");
                const root = await nativeRoot(environment, fallbackHome, platform, true);
                const source =
                  "kiro-export-v1:" +
                  hash(
                    encodeIdentity([
                      "kiro-native-export-v1",
                      normalize(root, platform),
                      exportOptions.instanceId,
                      normalize(cwd, platform),
                      nativeId,
                      record.schemaVersion,
                      record.createdAt,
                    ]),
                  );
                return {
                  source,
                  identity: hash(encodeJson(canonical([source, record, rows]))),
                  rows,
                };
              },
              catch: (cause) =>
                isHistoryReadError(cause)
                  ? cause
                  : new NativeHistoryReadError({ status: "unsafe", reason: "invalid_source" }),
            }),
        });
  return { capture: exported ?? capture, admit };
});
