import * as NodeUtil from "node:util";
import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";

type WorkflowContext = Pick<
  AcpAdapterV2ExtensionContext,
  "currentSessionId" | "handleSessionStarted" | "upsertWorkflow" | "forkBackground"
> & {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "request" | "handleExtNotification"
  >;
};

const prefix = "_kiro/workflow/";
const Status = Schema.Literals(["running", "paused", "completed", "failed", "aborted"]);
const NodeStatus = Schema.Literals([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
  "skipped",
]);
const NodeType = Schema.Literals(["step", "sequence", "repeat", "parallel", "watch"]);

interface PlanNode {
  readonly nodeId: string;
  readonly type: typeof NodeType.Type;
  readonly agentName?: string | undefined;
  readonly modelId?: string | undefined;
  readonly effortLevel?: string | undefined;
  readonly steps?: ReadonlyArray<PlanNode> | undefined;
  readonly branches?: ReadonlyArray<PlanNode> | undefined;
  readonly maxIterations?: number | undefined;
  readonly onMaxIterations?: string | undefined;
  readonly stopCondition?: unknown;
  readonly stopWhen?: string | undefined;
  readonly joinPolicy?: string | undefined;
}

const PlanNode: Schema.Codec<PlanNode> = Schema.Struct({
  nodeId: Schema.NonEmptyString,
  type: NodeType,
  agentName: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  effortLevel: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Array(Schema.suspend(() => PlanNode))),
  branches: Schema.optional(Schema.Array(Schema.suspend(() => PlanNode))),
  maxIterations: Schema.optional(Schema.Number),
  onMaxIterations: Schema.optional(Schema.String),
  stopCondition: Schema.optional(Schema.Unknown),
  stopWhen: Schema.optional(Schema.String),
  joinPolicy: Schema.optional(Schema.String),
});

interface StateNode {
  readonly nodeId: string;
  readonly type: typeof NodeType.Type;
  readonly status: typeof NodeStatus.Type;
  readonly agentName?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly iteration?: number | undefined;
  readonly branchId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly effortLevel?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly capturedOutput?: string | undefined;
  readonly failureReason?: string | undefined;
  readonly children?: ReadonlyArray<StateNode> | undefined;
}

const StateNode: Schema.Codec<StateNode> = Schema.Struct({
  nodeId: Schema.NonEmptyString,
  type: NodeType,
  status: NodeStatus,
  agentName: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.NonEmptyString),
  iteration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  branchId: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  effortLevel: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  capturedOutput: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.suspend(() => StateNode))),
});

const State = Schema.Struct({
  workflowId: Schema.NonEmptyString,
  workflowName: Schema.String,
  parentSessionId: Schema.optional(Schema.NonEmptyString),
  status: Status,
  root: StateNode,
  pauseReason: Schema.optional(Schema.String),
});
const Snapshot = Schema.Struct({
  workflowId: Schema.NonEmptyString,
  state: State,
  nodePlan: Schema.optional(Schema.Array(PlanNode)),
});
const Event = Schema.Struct({
  workflowId: Schema.NonEmptyString,
  parentSessionId: Schema.optional(Schema.NonEmptyString),
  workflowName: Schema.optional(Schema.String),
  nodeTree: Schema.optional(Schema.Array(PlanNode)),
  nodeId: Schema.optional(Schema.NonEmptyString),
  nodePath: Schema.optional(Schema.Array(Schema.String)),
  type: Schema.optional(NodeType),
  status: Schema.optional(NodeStatus),
  agentName: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.NonEmptyString),
  iteration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  branchId: Schema.optional(Schema.String),
  capturedOutput: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  pauseReason: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  finalState: Schema.optional(State),
});
const eventKinds = [
  "run_start",
  "node_start",
  "node_complete",
  "node_paused",
  "paused",
  "run_complete",
  "steps_queued",
] as const;
type EventKind = (typeof eventKinds)[number];
type WorkflowEvent = typeof Event.Type & { readonly kind: EventKind };
const decodeEvent = Schema.decodeUnknownOption(Event);
const decodeSnapshot = Schema.decodeUnknownOption(Snapshot);
const decodeCancel = Schema.decodeUnknownOption(Schema.Struct({ ok: Schema.Literal(true) }));
const decodeCapabilities = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }),
  }),
);

export function decodeKiroWorkflowEvent(
  method: string,
  payload: unknown,
): WorkflowEvent | undefined {
  const kind = eventKinds.find((candidate) => `${prefix}${candidate}` === method);
  const event = Option.getOrUndefined(decodeEvent(payload));
  if (kind === undefined || event === undefined) return;
  if (kind === "run_start" && (event.nodeTree === undefined || event.workflowName === undefined))
    return;
  if (kind.startsWith("node_") && (event.nodeId === undefined || !event.nodePath?.length)) return;
  if (kind === "node_start" && event.type === undefined) return;
  if (kind === "node_complete" && event.status === undefined) return;
  if (
    kind === "run_complete" &&
    (event.finalState === undefined ||
      event.finalState.workflowId !== event.workflowId ||
      event.finalState.status !== event.status ||
      (event.parentSessionId !== undefined &&
        event.finalState.parentSessionId !== undefined &&
        event.parentSessionId !== event.finalState.parentSessionId))
  )
    return;
  return { ...event, kind };
}

interface Execution extends StateNode {
  readonly key: string;
  readonly path: ReadonlyArray<string>;
  readonly index: number;
  readonly attempt?: number | undefined;
}
interface KiroWorkflowRun {
  readonly workflowId: string;
  readonly parentSessionId: string;
  readonly name: string;
  readonly status: typeof Status.Type;
  readonly plan: ReadonlyArray<PlanNode>;
  readonly nodes: ReadonlyArray<Execution>;
  readonly progress?: string | undefined;
}

function executionKey(path: ReadonlyArray<string>, iteration?: number, branchId?: string) {
  return JSON.stringify([path, iteration ?? null, branchId ?? null]);
}

function findExecution(
  nodes: ReadonlyArray<Execution>,
  path: ReadonlyArray<string>,
  iteration?: number,
  branchId?: string,
) {
  const compatible = nodes.filter(
    (node) =>
      NodeUtil.isDeepStrictEqual(node.path, path) &&
      (node.iteration === undefined || iteration === undefined || node.iteration === iteration) &&
      (node.branchId === undefined || branchId === undefined || node.branchId === branchId),
  );
  const exact = compatible.filter(
    (node) => node.iteration === iteration && node.branchId === branchId,
  );
  return exact.length === 1 ? exact[0] : compatible.length === 1 ? compatible[0] : undefined;
}

function changedExecutionSession(
  previous: ReadonlyArray<Execution>,
  next: ReadonlyArray<Execution>,
) {
  return previous.some((old) => {
    if (!isTerminal(old.status) || !old.sessionId) return false;
    const current = findExecution(next, old.path, old.iteration, old.branchId);
    return current?.sessionId !== undefined && current.sessionId !== old.sessionId;
  });
}

function nodeExecutions(root: StateNode, workflowId: string): ReadonlyArray<Execution> {
  const result: Execution[] = [];
  const visit = (node: StateNode, path: ReadonlyArray<string>, parentType?: StateNode["type"]) => {
    // KAS persists repeat bodies as `<loop>#N` but emits their paths as `iter-N`.
    const segment =
      parentType === "repeat" && node.iteration !== undefined
        ? `iter-${node.iteration}`
        : node.nodeId;
    const nodePath = [...path, segment];
    result.push({
      ...node,
      path: nodePath,
      key: executionKey(nodePath, node.iteration, node.branchId),
      index: result.length,
    });
    for (const child of node.children ?? []) visit(child, nodePath, node.type);
  };
  for (const node of root.children ?? []) visit(node, [workflowId]);
  return result;
}

function planExecutions(plan: ReadonlyArray<PlanNode>, workflowId: string) {
  const root: StateNode = {
    nodeId: workflowId,
    type: "sequence",
    status: "pending",
    children: plan.map(function convert(node): StateNode {
      return { ...node, status: "pending", children: (node.steps ?? node.branches)?.map(convert) };
    }),
  };
  return nodeExecutions(root, workflowId);
}

function snapshotRun(
  snapshot: typeof Snapshot.Type,
  previous?: KiroWorkflowRun,
  verifiedRestart = false,
): KiroWorkflowRun | undefined {
  const { state } = snapshot;
  if (snapshot.workflowId !== state.workflowId || !state.parentSessionId) return;
  const nodes = nodeExecutions(state.root, state.workflowId);
  let nextIndex = Math.max(-1, ...(previous?.nodes.map((node) => node.index) ?? [])) + 1;
  const matched = new Set<string>();
  return {
    workflowId: state.workflowId,
    parentSessionId: state.parentSessionId,
    name: state.workflowName.trim() || "Kiro workflow",
    status: state.status,
    plan: snapshot.nodePlan ?? previous?.plan ?? observedPlan(state.root.children ?? []),
    nodes: nodes.map((node) => {
      const old = findExecution(
        previous?.nodes.filter((entry) => !matched.has(entry.key)) ?? [],
        node.path,
        node.iteration,
        node.branchId,
      );
      if (old) matched.add(old.key);
      const attempt =
        verifiedRestart &&
        old &&
        isTerminal(old.status) &&
        (!isTerminal(node.status) ||
          (old.sessionId !== undefined &&
            node.sessionId !== undefined &&
            old.sessionId !== node.sessionId))
          ? (old.attempt ?? 0) + 1
          : old?.attempt;
      return {
        ...node,
        key: old?.key ?? node.key,
        index: old?.index ?? nextIndex++,
        ...(attempt === undefined ? {} : { attempt }),
      };
    }),
    ...(state.pauseReason === undefined ? {} : { progress: state.pauseReason }),
  };
}

function observedPlan(nodes: ReadonlyArray<StateNode>): ReadonlyArray<PlanNode> {
  return nodes.map((node) => ({
    nodeId: node.nodeId,
    type: node.type,
    ...(node.agentName === undefined ? {} : { agentName: node.agentName }),
    ...(node.modelId === undefined ? {} : { modelId: node.modelId }),
    ...(node.effortLevel === undefined ? {} : { effortLevel: node.effortLevel }),
    ...(node.type === "parallel" ? { branches: observedPlan(node.children ?? []) } : {}),
    ...(node.type === "sequence" ? { steps: observedPlan(node.children ?? []) } : {}),
    ...(node.type === "repeat"
      ? { steps: observedPlan(node.children?.at(-1)?.children ?? []) }
      : {}),
  }));
}

function isTerminal(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "aborted";
}

export function reduceKiroWorkflowEvent(
  previous: KiroWorkflowRun | undefined,
  event: WorkflowEvent,
): KiroWorkflowRun | undefined {
  const parent =
    event.parentSessionId ?? event.finalState?.parentSessionId ?? previous?.parentSessionId;
  if (
    !parent ||
    (previous !== undefined &&
      (previous.workflowId !== event.workflowId || previous.parentSessionId !== parent))
  )
    return previous;
  if (event.kind === "run_complete" && event.finalState !== undefined) {
    if (isTerminal(previous?.status) && !isTerminal(event.finalState.status)) return previous;
    return snapshotRun(
      { workflowId: event.workflowId, state: { ...event.finalState, parentSessionId: parent } },
      previous,
    );
  }
  if (event.kind === "run_start" && !isTerminal(previous?.status)) {
    const plan = event.nodeTree ?? [];
    return {
      workflowId: event.workflowId,
      parentSessionId: parent,
      name: event.workflowName?.trim() || previous?.name || "Kiro workflow",
      status: "running",
      plan,
      nodes: previous?.nodes ?? planExecutions(plan, event.workflowId),
    };
  }
  if (previous === undefined || ["completed", "failed", "aborted"].includes(previous.status))
    return previous;
  if (event.kind === "paused")
    return { ...previous, status: "paused", progress: event.pauseReason };
  if (!event.nodePath || !event.nodeId) return previous;
  const key = executionKey(event.nodePath, event.iteration, event.branchId);
  const existing = findExecution(previous.nodes, event.nodePath, event.iteration, event.branchId);
  if (event.kind !== "node_start" && existing === undefined) return previous;
  if (
    event.kind === "node_start" &&
    existing &&
    (isTerminal(existing.status) || existing.status === "skipped")
  )
    return previous;
  const node: Execution = {
    ...existing,
    nodeId: event.nodeId,
    path: event.nodePath,
    type: event.type ?? existing?.type ?? "step",
    status:
      event.kind === "node_start"
        ? "running"
        : event.kind === "node_paused"
          ? "paused"
          : (event.status ?? "pending"),
    key: existing?.key ?? key,
    index: existing?.index ?? Math.max(-1, ...previous.nodes.map((entry) => entry.index)) + 1,
    ...(event.agentName === undefined ? {} : { agentName: event.agentName }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.iteration === undefined ? {} : { iteration: event.iteration }),
    ...(event.branchId === undefined ? {} : { branchId: event.branchId }),
    ...(event.capturedOutput === undefined ? {} : { capturedOutput: event.capturedOutput }),
    ...(event.failureReason === undefined ? {} : { failureReason: event.failureReason }),
  };
  // A repeat's declaration is replaced by its execution instances, each with its own path.
  const nodes = previous.nodes.filter(
    (entry) =>
      entry.key !== node.key &&
      !(
        entry.nodeId === node.nodeId &&
        entry.status === "pending" &&
        !entry.sessionId &&
        entry.path.length < node.path.length
      ),
  );
  return {
    ...previous,
    nodes: [...nodes, node],
    ...(event.kind === "node_paused" ? { progress: event.reason } : {}),
  };
}

function memberStatus(
  status: StateNode["status"],
): "pending" | "running" | "completed" | "failed" | "waiting" | "cancelled" | "interrupted" {
  return status === "paused"
    ? "waiting"
    : status === "aborted"
      ? "cancelled"
      : status === "skipped"
        ? "interrupted"
        : status;
}

function epoch(value: string | undefined) {
  if (value === undefined) return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

export function kiroWorkflowProjection(run: KiroWorkflowRun) {
  const phases = run.plan.map((node, index) => ({ index, title: `${node.type}: ${node.nodeId}` }));
  const leaves = run.nodes.filter((node) => node.type === "step" || node.type === "watch");
  const agents = leaves.map((node) => {
    const phaseIndex = run.plan.findIndex((phase) => phase.nodeId === node.path[1]);
    const status = memberStatus(node.status);
    const label = `${node.path.slice(1).join(" / ")}${node.iteration === undefined ? "" : ` · iteration ${node.iteration + 1}`}${node.type === "watch" ? " · watch" : ""}`;
    return {
      index: node.index,
      label,
      state: status === "pending" ? ("queued" as const) : status,
      ...(node.sessionId === undefined ? {} : { agentId: node.sessionId }),
      ...(phaseIndex < 0 ? {} : { phaseIndex, phaseTitle: phases[phaseIndex]?.title }),
      ...(node.modelId ? { model: node.modelId } : {}),
      ...(node.effortLevel ? { effort: node.effortLevel } : {}),
      ...(node.attempt === undefined ? {} : { attempt: node.attempt }),
      ...(node.capturedOutput || node.failureReason
        ? { result: node.capturedOutput ?? node.failureReason }
        : {}),
      ...(epoch(node.startedAt) === undefined ? {} : { startedAt: epoch(node.startedAt) }),
      ...(epoch(node.endedAt) === undefined ? {} : { completedAt: epoch(node.endedAt) }),
      ...(epoch(node.startedAt) === undefined || epoch(node.endedAt) === undefined
        ? {}
        : { durationMs: Math.max(0, (epoch(node.endedAt) ?? 0) - (epoch(node.startedAt) ?? 0)) }),
    };
  });
  const workflow: OrchestrationV2SubagentWorkflow = {
    name: run.name,
    runHandles: { runId: run.workflowId },
    phases,
    agents,
    memberKind: "step",
    scriptLanguage: "json",
  };
  return {
    sessionId: run.parentSessionId,
    workflowId: run.workflowId,
    title: run.name,
    prompt: JSON.stringify({ name: run.name, nodePlan: run.plan }, null, 2),
    status: memberStatus(run.status),
    workflow,
    ...(run.progress === undefined ? {} : { progress: run.progress }),
    members: leaves.map((node) => ({
      index: node.index,
      nativeTaskId: `${run.workflowId}:${node.key}`,
      childSessionId: node.sessionId ?? null,
      prompt: node.path.slice(1).join(" / "),
      title: node.agentName ?? node.nodeId,
      model: node.modelId ?? null,
      status: memberStatus(node.status),
      result: node.capturedOutput ?? node.failureReason ?? null,
    })),
  };
}

const ReplayMeta = Schema.Struct({
  kiro: Schema.Struct({
    kind: Schema.optional(Schema.String),
    messageId: Schema.optional(Schema.String),
    notification: Schema.optional(
      Schema.Struct({
        kind: Schema.optional(Schema.String),
        workflowId: Schema.optional(Schema.String),
        eventType: Schema.optional(Schema.String),
      }),
    ),
  }),
});
const decodeReplayMeta = Schema.decodeUnknownOption(ReplayMeta);
const decodeReplayEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    method: Schema.optional(Schema.String),
    workflowId: Schema.optional(Schema.String),
  }),
);

function replayProgress(notification: AcpSchema.SessionNotification) {
  const { update } = notification;
  if (update.sessionUpdate !== "user_message_chunk") return;
  const meta = Option.getOrUndefined(decodeReplayMeta(update._meta))?.kiro;
  if (
    meta?.notification?.kind !== "workflow-progress" &&
    meta?.kind !== "workflow-progress" &&
    !meta?.messageId?.startsWith("wf-progress-")
  )
    return;
  if (update.content.type !== "text") return { event: undefined };
  try {
    const payload: unknown = JSON.parse(update.content.text);
    const envelope = decodeReplayEnvelope(payload);
    if (Option.isNone(envelope)) return { event: undefined };
    const method =
      envelope.value.method ??
      (meta.notification?.eventType ? `${prefix}${meta.notification.eventType}` : "");
    if (meta.notification?.eventType && method !== `${prefix}${meta.notification.eventType}`)
      return { event: undefined };
    const event = decodeKiroWorkflowEvent(method, payload);
    if (event && meta.notification?.workflowId && meta.notification.workflowId !== event.workflowId)
      return { event: undefined };
    return { event };
  } catch {
    return { event: undefined };
  }
}

function requestError(method: string, message: string) {
  return new AcpErrors.AcpRequestError({ method, code: -32603, errorMessage: message });
}

export function makeKiroWorkflowSupport() {
  interface RuntimeState {
    readonly context: WorkflowContext;
    readonly runs: Map<string, KiroWorkflowRun>;
    readonly methods: Set<string>;
    readonly published: Map<string, ReturnType<typeof kiroWorkflowProjection>>;
  }
  const states = new WeakMap<object, RuntimeState>();

  const publish = Effect.fn("KiroWorkflows.publish")(function* (
    state: RuntimeState,
    run: KiroWorkflowRun,
    verifiedRestart = false,
  ) {
    const projection = kiroWorkflowProjection(run);
    const previous = state.published.get(run.workflowId);
    if (NodeUtil.isDeepStrictEqual(previous, projection)) return;
    const members = projection.members.filter(
      (member) =>
        !NodeUtil.isDeepStrictEqual(
          previous?.members.find((entry) => entry.nativeTaskId === member.nativeTaskId),
          member,
        ),
    );
    const accepted = yield* state.context.upsertWorkflow({
      ...projection,
      members,
      ...(verifiedRestart ? { verifiedRestart: true } : {}),
    });
    if (accepted) state.published.set(run.workflowId, projection);
  });

  const apply = Effect.fn("KiroWorkflows.apply")(function* (
    state: RuntimeState,
    event: WorkflowEvent,
  ) {
    const sessionId = yield* state.context.currentSessionId;
    const previous = state.runs.get(event.workflowId);
    const run = reduceKiroWorkflowEvent(previous, event);
    if (!run || run.parentSessionId !== sessionId) return;
    state.runs.set(run.workflowId, run);
    if (
      previous &&
      isTerminal(previous.status) &&
      event.kind === "run_complete" &&
      changedExecutionSession(previous.nodes, run.nodes)
    )
      return;
    yield* publish(state, run);
  });

  const inspect = Effect.fn("KiroWorkflows.inspect")(function* (
    state: RuntimeState,
    workflowId: string,
    allowRestart = false,
  ) {
    if (!state.methods.has(`${prefix}inspect`)) return;
    const previous = state.runs.get(workflowId);
    const result = yield* state.context.runtime.request(`${prefix}inspect`, { workflowId });
    const snapshot = Option.getOrUndefined(decodeSnapshot(result));
    if (!snapshot || snapshot.workflowId !== workflowId) return;
    const inspectedNodes = nodeExecutions(snapshot.state.root, workflowId);
    const changedSession = previous && changedExecutionSession(previous.nodes, inspectedNodes);
    const verifiedRestart =
      allowRestart &&
      isTerminal(previous?.status) &&
      (!isTerminal(snapshot.state.status) || changedSession === true);
    let run = snapshotRun(snapshot, previous, verifiedRestart);
    if (!run || run.parentSessionId !== (yield* state.context.currentSessionId)) return;
    const latest = state.runs.get(workflowId);
    if (latest !== previous) {
      if (!verifiedRestart || !latest) return;
      const inspected = run;
      run = {
        ...latest,
        nodes: latest.nodes.map((node) => {
          const attempt = findExecution(
            inspected.nodes,
            node.path,
            node.iteration,
            node.branchId,
          )?.attempt;
          return attempt === undefined
            ? node
            : { ...node, attempt: Math.max(node.attempt ?? 0, attempt) };
        }),
      };
    }
    if (!allowRestart && previous && isTerminal(previous.status) && !isTerminal(run.status)) return;
    state.runs.set(workflowId, run);
    yield* publish(state, run, verifiedRestart);
  });

  const registerExtensions = Effect.fn("KiroWorkflows.registerExtensions")(function* (
    context: WorkflowContext,
  ) {
    const state: RuntimeState = {
      context,
      runs: new Map(),
      methods: new Set(),
      published: new Map(),
    };
    states.set(context.runtime, state);
    for (const kind of eventKinds) {
      const method = `${prefix}${kind}`;
      yield* context.runtime.handleExtNotification(method, Schema.Unknown, (payload) => {
        const event = decodeKiroWorkflowEvent(method, payload);
        if (!event) return Effect.void;
        if (
          event.kind === "steps_queued" &&
          state.runs.get(event.workflowId)?.parentSessionId === event.parentSessionId
        ) {
          return context.forkBackground(inspect(state, event.workflowId));
        }
        if (
          event.kind === "run_start" &&
          isTerminal(state.runs.get(event.workflowId)?.status) &&
          state.runs.get(event.workflowId)?.parentSessionId === event.parentSessionId
        ) {
          return context.forkBackground(inspect(state, event.workflowId, true));
        }
        return apply(state, event);
      });
    }
    yield* context.handleSessionStarted(
      Effect.fn("KiroWorkflows.configure")(function (started) {
        return Effect.sync(() => {
          state.methods.clear();
          const capabilities = Option.getOrUndefined(
            decodeCapabilities(started.initializeResult.agentCapabilities?._meta),
          );
          for (const method of capabilities?.kiro.extensionMethods ?? []) state.methods.add(method);
        });
      }),
    );
  });

  const consumeSessionUpdate = Effect.fn("KiroWorkflows.consumeSessionUpdate")(function* (
    runtime: WorkflowContext["runtime"],
    notification: AcpSchema.SessionNotification,
  ) {
    const replay = replayProgress(notification);
    if (!replay) return false;
    const state = states.get(runtime);
    if (
      state &&
      replay.event &&
      notification.sessionId === (yield* state.context.currentSessionId) &&
      (replay.event.parentSessionId === undefined ||
        replay.event.parentSessionId === notification.sessionId)
    ) {
      yield* apply(state, { ...replay.event, parentSessionId: notification.sessionId });
    }
    return true;
  });

  const stopTask = Effect.fn("KiroWorkflows.stopTask")(function* (
    runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
    sessionId: string,
    taskId: string,
  ) {
    const method = `${prefix}cancel`;
    const state = states.get(runtime);
    if (!state?.methods.has(method) || state.runs.get(taskId)?.parentSessionId !== sessionId) {
      return yield* requestError(method, "This Kiro workflow cannot be stopped from this session.");
    }
    const result = yield* runtime.request(method, { workflowId: taskId, initiator: "user" });
    if (Option.isNone(decodeCancel(result))) {
      return yield* requestError(method, "Kiro did not acknowledge stopping the workflow.");
    }
  });

  return { registerExtensions, consumeSessionUpdate, stopTask };
}
