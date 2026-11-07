import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import type {
  AcpAdapterV2ExtensionContext,
  AcpAdapterV2WorkflowUpdate,
} from "@t3tools/provider-acp/server/adapter";
import {
  decodeKiroWorkflowEvent,
  kiroWorkflowProjection,
  makeKiroWorkflowSupport,
  reduceKiroWorkflowEvent,
} from "./workflows.ts";

const plan = [
  {
    nodeId: "review",
    type: "repeat",
    maxIterations: 3,
    steps: [{ nodeId: "check", type: "step", agentName: "wf-planner" }],
  },
];
const start = { workflowId: "wf", parentSessionId: "root", workflowName: "Review", nodeTree: plan };

function event(kind: string, params: unknown) {
  const result = decodeKiroWorkflowEvent(`_kiro/workflow/${kind}`, params);
  assert.ok(result);
  return result;
}

function setup(
  methods: ReadonlyArray<string> = ["_kiro/workflow/cancel"],
  support = makeKiroWorkflowSupport(),
) {
  const updates: AcpAdapterV2WorkflowUpdate[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<string, (params: unknown) => Effect.Effect<void, AcpErrors.AcpError>>();
  const background: Array<Effect.Effect<void, AcpErrors.AcpError>> = [];
  let started: Parameters<AcpAdapterV2ExtensionContext["handleSessionStarted"]>[0] | undefined;
  let response: unknown = { ok: true };
  let accepted = true;
  const responses = new Map<string, unknown>();
  const responseEffects = new Map<string, Effect.Effect<unknown, AcpErrors.AcpError>>();
  const context: Parameters<typeof support.registerExtensions>[0] = {
    currentSessionId: Effect.succeed("root"),
    forkBackground: (effect) =>
      Effect.sync(() => {
        background.push(effect);
      }),
    handleSessionStarted: (handler) =>
      Effect.sync(() => {
        started = handler;
      }),
    upsertWorkflow: (update) =>
      Effect.sync(() => {
        updates.push(update);
        return accepted;
      }),
    runtime: {
      handleExtNotification: (method, _schema, handler) =>
        Effect.sync(() => {
          handlers.set(method, (payload) => handler(payload as never));
        }),
      request: (method, params) =>
        Effect.sync(() => {
          requests.push({ method, params });
          return responses.get(method) ?? response;
        }).pipe(Effect.flatMap((value) => responseEffects.get(method) ?? Effect.succeed(value))),
    },
  };
  const begin = Effect.gen(function* () {
    yield* support.registerExtensions(context);
    assert.ok(started);
    yield* started({
      sessionId: "root",
      initializeResult: {
        protocolVersion: 2,
        agentCapabilities: { _meta: { kiro: { extensionMethods: methods } } },
      },
      sessionSetupResult: { sessionId: "root" },
      modelConfigId: undefined,
    });
  });
  const emit = (kind: string, payload: unknown) => {
    const handler = handlers.get(`_kiro/workflow/${kind}`);
    assert.ok(handler);
    return handler(payload);
  };
  return {
    support,
    context,
    begin,
    emit,
    updates,
    requests,
    respond: (value: unknown) => {
      response = value;
    },
    respondTo: (method: string, value: unknown) => {
      responses.set(method, value);
    },
    respondEffect: (method: string, effect: Effect.Effect<unknown, AcpErrors.AcpError>) => {
      responseEffects.set(method, effect);
    },
    accept: (value: boolean) => {
      accepted = value;
    },
    drain: Effect.suspend(() =>
      Effect.forEach(background.splice(0), (effect) => effect, { discard: true }),
    ),
  };
}

describe("Kiro native workflows", () => {
  it("keeps repeat executions distinct and assigns a session to a duplicate node start", () => {
    const first = reduceKiroWorkflowEvent(undefined, event("run_start", start));
    const node = {
      workflowId: "wf",
      nodeId: "check",
      nodePath: ["wf", "review", "iter-0", "check"],
      type: "step",
      iteration: 0,
      branchId: "a",
    };
    const running = reduceKiroWorkflowEvent(first, event("node_start", node));
    const assigned = reduceKiroWorkflowEvent(
      running,
      event("node_start", { ...node, sessionId: "step-1" }),
    );
    assert.ok(assigned);
    assert.equal(assigned.nodes.filter((entry) => entry.type === "step").length, 1);
    const next = reduceKiroWorkflowEvent(
      assigned,
      event("node_start", {
        ...node,
        nodePath: ["wf", "review", "iter-1", "check"],
        iteration: 1,
        sessionId: "step-2",
      }),
    );
    assert.ok(next);
    const projection = kiroWorkflowProjection(next);
    assert.deepEqual(
      projection.members.map((member) => member.childSessionId),
      ["step-1", "step-2"],
    );
    assert.notEqual(projection.members[0]?.nativeTaskId, projection.members[1]?.nativeTaskId);
    assert.match(projection.workflow.agents[1]?.label ?? "", /iteration 2/);
    assert.deepEqual(projection.workflow.phases, [{ index: 0, title: "repeat: review" }]);
    assert.equal(projection.workflow.memberKind, "step");
    const snapshot = reduceKiroWorkflowEvent(
      assigned,
      event("run_complete", {
        workflowId: "wf",
        status: "paused",
        finalState: {
          workflowId: "wf",
          workflowName: "Review",
          parentSessionId: "root",
          status: "paused",
          root: {
            nodeId: "wf",
            type: "sequence",
            status: "paused",
            children: [
              {
                nodeId: "review",
                type: "repeat",
                status: "paused",
                children: [
                  {
                    nodeId: "review#0",
                    type: "sequence",
                    status: "paused",
                    iteration: 0,
                    children: [
                      {
                        nodeId: "check",
                        type: "step",
                        status: "paused",
                        iteration: 0,
                        branchId: "a",
                        sessionId: "step-1",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    assert.ok(snapshot);
    assert.equal(
      kiroWorkflowProjection(snapshot).members[0]?.nativeTaskId,
      kiroWorkflowProjection(assigned).members[0]?.nativeTaskId,
    );
    assert.equal(
      kiroWorkflowProjection(snapshot).members[0]?.index,
      kiroWorkflowProjection(assigned).members[0]?.index,
    );
    for (const metadata of [
      { branchId: "review" },
      { iteration: 0 },
      { branchId: "review", iteration: 0 },
    ]) {
      const planned = reduceKiroWorkflowEvent(
        undefined,
        event("run_start", {
          ...start,
          nodeTree: [
            { nodeId: "checks", type: "parallel", branches: [{ nodeId: "review", type: "step" }] },
          ],
        }),
      );
      const live = reduceKiroWorkflowEvent(
        planned,
        event("node_start", {
          workflowId: "wf",
          nodeId: "review",
          nodePath: ["wf", "checks", "review"],
          type: "step",
          sessionId: "live-review",
        }),
      );
      const enriched = reduceKiroWorkflowEvent(
        live,
        event("run_complete", {
          workflowId: "wf",
          status: "completed",
          finalState: {
            workflowId: "wf",
            workflowName: "Review",
            parentSessionId: "root",
            status: "completed",
            root: {
              nodeId: "wf",
              type: "sequence",
              status: "completed",
              children: [
                {
                  nodeId: "checks",
                  type: "parallel",
                  status: "completed",
                  children: [
                    {
                      nodeId: "review",
                      type: "step",
                      status: "completed",
                      sessionId: "live-review",
                      ...metadata,
                    },
                  ],
                },
              ],
            },
          },
        }),
      );
      assert.ok(live);
      assert.ok(enriched);
      assert.equal(
        kiroWorkflowProjection(enriched).members[0]?.nativeTaskId,
        kiroWorkflowProjection(live).members[0]?.nativeTaskId,
      );
      assert.equal(
        kiroWorkflowProjection(enriched).members[0]?.index,
        kiroWorkflowProjection(live).members[0]?.index,
      );
      const firstBranch = reduceKiroWorkflowEvent(
        live,
        event("node_start", {
          workflowId: "wf",
          nodeId: "review",
          nodePath: ["wf", "checks", "review"],
          type: "step",
          branchId: "left",
        }),
      );
      const otherBranch = reduceKiroWorkflowEvent(
        firstBranch,
        event("node_start", {
          workflowId: "wf",
          nodeId: "review",
          nodePath: ["wf", "checks", "review"],
          type: "step",
          branchId: "right",
        }),
      );
      assert.ok(otherBranch);
      assert.equal(kiroWorkflowProjection(otherBranch).members.length, 2);
    }
  });

  it("treats a paused run_complete as waiting and ignores late activity after terminal completion", () => {
    const first = reduceKiroWorkflowEvent(undefined, event("run_start", start));
    const state = {
      workflowId: "wf",
      workflowName: "Review",
      parentSessionId: "root",
      status: "paused",
      pauseReason: "Needs input",
      root: {
        nodeId: "wf",
        type: "sequence",
        status: "paused",
        children: [{ nodeId: "check", type: "step", status: "paused", sessionId: "step" }],
      },
    };
    const paused = reduceKiroWorkflowEvent(
      first,
      event("run_complete", { workflowId: "wf", status: "paused", finalState: state }),
    );
    assert.ok(paused);
    const observed = reduceKiroWorkflowEvent(
      undefined,
      event("run_complete", {
        workflowId: "wf",
        status: "paused",
        finalState: state,
      }),
    );
    assert.ok(observed);
    assert.deepEqual(kiroWorkflowProjection(observed).workflow.phases, [
      { index: 0, title: "step: check" },
    ]);
    assert.equal(kiroWorkflowProjection(paused).status, "waiting");
    assert.equal(kiroWorkflowProjection(paused).members[0]?.status, "waiting");
    const done = reduceKiroWorkflowEvent(
      paused,
      event("run_complete", {
        workflowId: "wf",
        status: "aborted",
        finalState: { ...state, status: "aborted" },
      }),
    );
    assert.ok(done);
    assert.equal(kiroWorkflowProjection(done).status, "cancelled");
    assert.equal(
      reduceKiroWorkflowEvent(
        done,
        event("node_start", {
          workflowId: "wf",
          nodeId: "check",
          nodePath: ["wf", "check"],
          type: "step",
        }),
      ),
      done,
    );
    assert.equal(reduceKiroWorkflowEvent(done, event("run_start", start)), done);
    assert.equal(
      reduceKiroWorkflowEvent(
        done,
        event("run_complete", { workflowId: "wf", status: "paused", finalState: state }),
      ),
      done,
    );
    assert.equal(
      decodeKiroWorkflowEvent("_kiro/workflow/run_complete", {
        workflowId: "other",
        status: "paused",
        finalState: state,
      }),
      undefined,
    );
    const completedLeaf = reduceKiroWorkflowEvent(
      first,
      event("node_complete", {
        workflowId: "wf",
        nodeId: "check",
        nodePath: ["wf", "review", "check"],
        status: "completed",
      }),
    );
    assert.equal(
      reduceKiroWorkflowEvent(
        completedLeaf,
        event("node_start", {
          workflowId: "wf",
          nodeId: "check",
          nodePath: ["wf", "review", "check"],
          type: "step",
        }),
      ),
      completedLeaf,
    );
  });

  it.effect(
    "filters foreign ownership, coalesces duplicates, and cancels only advertised owned runs",
    () =>
      Effect.gen(function* () {
        const harness = setup();
        yield* harness.begin;
        yield* harness.emit("run_start", { ...start, parentSessionId: "other" });
        assert.equal(harness.updates.length, 0);
        yield* harness.emit("run_start", start);
        yield* harness.emit("run_start", start);
        assert.equal(harness.updates.length, 1);
        const node = {
          workflowId: "wf",
          nodeId: "check",
          nodePath: ["wf", "review", "check"],
          type: "step",
          sessionId: "child",
        };
        yield* harness.emit("node_start", node);
        yield* harness.emit("node_start", node);
        assert.equal(harness.updates.length, 2);
        assert.equal(harness.updates[1]?.members.length, 1);
        yield* harness.support.stopTask(harness.context.runtime, "root", "wf");
        assert.deepEqual(harness.requests, [
          { method: "_kiro/workflow/cancel", params: { workflowId: "wf", initiator: "user" } },
        ]);
        harness.respond({ ok: false });
        const rejected = yield* Effect.result(
          harness.support.stopTask(harness.context.runtime, "root", "wf"),
        );
        assert.equal(rejected._tag, "Failure");
        const foreign = yield* Effect.result(
          harness.support.stopTask(harness.context.runtime, "other", "wf"),
        );
        assert.equal(foreign._tag, "Failure");
        const unavailable = setup([]);
        yield* unavailable.begin;
        yield* unavailable.emit("run_start", start);
        assert.equal(
          (yield* Effect.result(
            unavailable.support.stopTask(unavailable.context.runtime, "root", "wf"),
          ))._tag,
          "Failure",
        );
        assert.equal(unavailable.requests.length, 0);
      }),
  );

  it.effect(
    "consumes valid and malformed replay progress without accepting a conflicting owner",
    () =>
      Effect.gen(function* () {
        const harness = setup();
        yield* harness.begin;
        const notification = (text: string): AcpSchema.SessionNotification => ({
          sessionId: "root",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
            _meta: {
              kiro: {
                notification: {
                  kind: "workflow-progress",
                  workflowId: "wf",
                  eventType: "run_start",
                },
              },
            },
          },
        });
        assert.equal(
          yield* harness.support.consumeSessionUpdate(
            harness.context.runtime,
            notification(JSON.stringify({ method: "_kiro/workflow/run_start", ...start })),
          ),
          true,
        );
        assert.equal(harness.updates.length, 1);
        assert.equal(
          yield* harness.support.consumeSessionUpdate(
            harness.context.runtime,
            notification("invalid json"),
          ),
          true,
        );
        assert.equal(
          yield* harness.support.consumeSessionUpdate(
            harness.context.runtime,
            notification(
              JSON.stringify({
                method: "_kiro/workflow/run_start",
                ...start,
                parentSessionId: "other",
              }),
            ),
          ),
          true,
        );
        assert.equal(harness.updates.length, 1);
        assert.equal(
          yield* harness.support.consumeSessionUpdate(harness.context.runtime, {
            sessionId: "root",
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "Please run a workflow" },
            },
          }),
          false,
        );
      }),
  );

  it.effect("avoids startup discovery and inspects only progress from an owned run", () =>
    Effect.gen(function* () {
      const harness = setup(["_kiro/workflow/list", "_kiro/workflow/inspect"]);
      harness.respondTo("_kiro/workflow/inspect", {
        workflowId: "wf",
        state: {
          workflowId: "wf",
          workflowName: "Review",
          parentSessionId: "root",
          status: "failed",
          root: {
            nodeId: "wf",
            type: "sequence",
            status: "failed",
            children: [
              {
                nodeId: "check",
                type: "step",
                status: "failed",
                sessionId: "step",
                failureReason: "Check failed",
                startedAt: "2026-11-06T20:00:00Z",
                endedAt: "2026-11-06T20:00:03Z",
              },
            ],
          },
        },
        nodePlan: [{ nodeId: "check", type: "step" }],
      });
      yield* harness.begin;
      assert.deepEqual(harness.requests, []);
      yield* harness.emit("run_start", start);
      yield* harness.emit("steps_queued", { workflowId: "wf", parentSessionId: "other" });
      assert.deepEqual(harness.requests, []);
      yield* harness.emit("steps_queued", { workflowId: "wf", parentSessionId: "root" });
      assert.deepEqual(harness.requests, []);
      yield* harness.drain;
      assert.deepEqual(harness.requests, [
        { method: "_kiro/workflow/inspect", params: { workflowId: "wf" } },
      ]);
      assert.equal(harness.updates.at(-1)?.status, "failed");
      assert.equal(harness.updates.at(-1)?.workflow.agents[0]?.durationMs, 3000);
      assert.equal(harness.updates.at(-1)?.workflow.agents[0]?.result, "Check failed");
      const racing = setup(["_kiro/workflow/inspect"]);
      yield* racing.begin;
      const nodeTree = [{ nodeId: "check", type: "step" }];
      yield* racing.emit("run_start", { ...start, nodeTree });
      yield* racing.emit("node_start", {
        workflowId: "wf",
        nodeId: "check",
        type: "step",
        nodePath: ["wf", "check"],
        sessionId: "step",
      });
      const requested = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<unknown>();
      racing.respondEffect(
        "_kiro/workflow/inspect",
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      );
      yield* racing.emit("steps_queued", { workflowId: "wf", parentSessionId: "root" });
      const inspection = yield* racing.drain.pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* racing.emit("node_complete", {
        workflowId: "wf",
        nodeId: "check",
        nodePath: ["wf", "check"],
        status: "completed",
      });
      yield* Deferred.succeed(reply, {
        workflowId: "wf",
        nodePlan: nodeTree,
        state: {
          workflowId: "wf",
          workflowName: "Review",
          parentSessionId: "root",
          status: "running",
          root: {
            nodeId: "wf",
            type: "sequence",
            status: "running",
            children: [{ nodeId: "check", type: "step", status: "running", sessionId: "step" }],
          },
        },
      });
      yield* Fiber.join(inspection);
      assert.equal(racing.updates.at(-1)?.workflow.agents[0]?.state, "completed");
    }),
  );

  it.effect("isolates parallel runtimes even when their native workflow ids match", () =>
    Effect.gen(function* () {
      const support = makeKiroWorkflowSupport();
      const first = setup(["_kiro/workflow/cancel"], support);
      const second = setup([], support);
      yield* first.begin;
      yield* second.begin;
      yield* first.emit("run_start", start);
      yield* second.emit("run_start", { ...start, workflowName: "Other runtime" });
      assert.equal(first.updates[0]?.title, "Review");
      assert.equal(second.updates[0]?.title, "Other runtime");
      yield* support.stopTask(first.context.runtime, "root", "wf");
      assert.equal(first.requests.length, 1);
      assert.equal(
        (yield* Effect.result(support.stopTask(second.context.runtime, "root", "wf")))._tag,
        "Failure",
      );
      assert.equal(second.requests.length, 0);
    }),
  );

  it.effect("publishes again when a launch anchor becomes available after a declined restore", () =>
    Effect.gen(function* () {
      const harness = setup();
      yield* harness.begin;
      harness.accept(false);
      yield* harness.emit("run_start", start);
      harness.accept(true);
      yield* harness.emit("run_start", start);
      yield* harness.emit("run_start", start);
      assert.equal(harness.updates.length, 2);
    }),
  );

  it.effect("marks a restart only after inspection proves new activity or a new step session", () =>
    Effect.gen(function* () {
      const harness = setup(["_kiro/workflow/inspect"]);
      yield* harness.begin;
      const nodePlan = [
        { nodeId: "check", type: "step" },
        { nodeId: "done", type: "step" },
      ];
      yield* harness.emit("run_start", { ...start, nodeTree: nodePlan });
      const finalState = {
        workflowId: "wf",
        workflowName: "Review",
        parentSessionId: "root",
        status: "failed",
        root: {
          nodeId: "wf",
          type: "sequence",
          status: "failed",
          children: [
            { nodeId: "check", type: "step", status: "failed", sessionId: "failed-step" },
            { nodeId: "done", type: "step", status: "completed", sessionId: "completed-step" },
          ],
        },
      };
      yield* harness.emit("run_complete", { workflowId: "wf", status: "failed", finalState });
      harness.respondTo("_kiro/workflow/inspect", {
        workflowId: "wf",
        state: {
          ...finalState,
          status: "running",
          root: {
            ...finalState.root,
            status: "running",
            children: [
              { nodeId: "check", type: "step", status: "pending" },
              finalState.root.children[1],
            ],
          },
        },
        nodePlan,
      });
      yield* harness.emit("run_start", { ...start, nodeTree: nodePlan });
      assert.deepEqual(harness.requests, []);
      yield* harness.drain;
      const restarted = harness.updates.at(-1);
      assert.equal(restarted?.status, "running");
      assert.equal(restarted?.verifiedRestart, true);
      assert.equal(restarted?.workflow.agents.find((agent) => agent.label === "check")?.attempt, 1);
      assert.equal(
        restarted?.workflow.agents.find((agent) => agent.label === "done")?.agentId,
        "completed-step",
      );
      assert.equal(
        restarted?.members.find((member) => member.title === "check")?.childSessionId,
        null,
      );
      assert.equal(
        restarted?.members.some((member) => member.childSessionId === "completed-step"),
        false,
      );
      const failedAgain = {
        ...finalState,
        root: {
          ...finalState.root,
          children: [
            { nodeId: "check", type: "step", status: "failed", sessionId: "retry-step" },
            finalState.root.children[1],
          ],
        },
      };
      yield* harness.emit("run_complete", {
        workflowId: "wf",
        status: "failed",
        finalState: failedAgain,
      });
      harness.respondTo("_kiro/workflow/inspect", {
        workflowId: "wf",
        nodePlan,
        state: {
          ...failedAgain,
          root: {
            ...failedAgain.root,
            children: [
              { nodeId: "check", type: "step", status: "failed", sessionId: "fast-retry-step" },
              finalState.root.children[1],
            ],
          },
        },
      });
      yield* harness.emit("run_start", { ...start, nodeTree: nodePlan });
      yield* harness.drain;
      const fastRetry = harness.updates.at(-1);
      assert.equal(fastRetry?.verifiedRestart, true);
      assert.equal(fastRetry?.status, "failed");
      assert.equal(fastRetry?.workflow.agents.find((agent) => agent.label === "check")?.attempt, 2);
      assert.equal(
        fastRetry?.members.find((member) => member.title === "check")?.childSessionId,
        "fast-retry-step",
      );
      assert.equal(
        fastRetry?.members.some((member) => member.childSessionId === "completed-step"),
        false,
      );
      const requested = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<unknown>();
      harness.respondEffect(
        "_kiro/workflow/inspect",
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      );
      yield* harness.emit("run_start", { ...start, nodeTree: nodePlan });
      const inspection = yield* harness.drain.pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      const beforeCompletion = harness.updates.length;
      const completed = {
        ...finalState,
        status: "completed",
        root: {
          ...finalState.root,
          status: "completed",
          children: [
            { nodeId: "check", type: "step", status: "completed", sessionId: "raced-step" },
            finalState.root.children[1],
          ],
        },
      };
      yield* harness.emit("run_complete", {
        workflowId: "wf",
        status: "completed",
        finalState: completed,
      });
      assert.equal(harness.updates.length, beforeCompletion);
      yield* Deferred.succeed(reply, {
        workflowId: "wf",
        nodePlan,
        state: {
          ...completed,
          status: "running",
          root: {
            ...completed.root,
            status: "running",
            children: [
              { nodeId: "check", type: "step", status: "running", sessionId: "raced-step" },
              finalState.root.children[1],
            ],
          },
        },
      });
      yield* Fiber.join(inspection);
      const racedRetry = harness.updates.at(-1);
      assert.equal(racedRetry?.status, "completed");
      assert.equal(racedRetry?.verifiedRestart, true);
      assert.equal(
        racedRetry?.workflow.agents.find((agent) => agent.label === "check")?.attempt,
        3,
      );
      assert.equal(
        racedRetry?.workflow.agents.find((agent) => agent.label === "check")?.state,
        "completed",
      );
    }),
  );
});
