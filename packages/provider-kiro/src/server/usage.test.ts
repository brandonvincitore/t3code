import { describe, expect, it } from "@effect/vitest";

import { kiroUsageFormat } from "./usage.ts";

const usage = (
  executionId: string | undefined,
  summaries: unknown,
  identity: { id?: string; turnId?: string; status?: string } = {},
) =>
  JSON.stringify({
    id: identity.id,
    timestamp: "2026-11-08T12:00:00.000Z",
    payload: {
      type: "usage_summary",
      executionId,
      turnId: identity.turnId,
      status: identity.status,
      promptTurnSummaries: summaries,
    },
  });

describe("Kiro usage history", () => {
  it("records credits and the model active for that turn without inventing token or dollar usage", () => {
    const state = kiroUsageFormat.state!.initial(
      "/home/test/.kiro/sessions/work/session-a/messages.jsonl",
    );
    kiroUsageFormat.parseLine(
      JSON.stringify({
        payload: { type: "agent_note", content: "The current model is Claude Sonnet 4.5." },
      }),
      state,
    );
    const [record] = kiroUsageFormat.parseLine(
      usage("execution-a", [
        { unit: "credit", usage: 0.125 },
        { unit: "token", usage: 800 },
        { unit: "credit", usage: 0.75 },
      ]),
      state,
    );
    expect(record).toMatchObject({
      provider: "kiro",
      model: "claude-sonnet-4.5",
      sessionId: "session-a",
      credits: 0.875,
      totals: { uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      reportedCostUsd: null,
      dedupeKey: "kiro:execution-a",
    });
  });

  it("uses an explicit unknown model until a model note appears and ignores invalid credit rows", () => {
    const state = kiroUsageFormat.state!.initial("/x/sessions/w/session-b/messages.jsonl");
    expect(
      kiroUsageFormat.parseLine(usage("execution-b", [{ unit: "token", usage: 42 }]), state),
    ).toEqual([]);
    expect(
      kiroUsageFormat.parseLine(usage("execution-c", [{ unit: "credit", usage: -3 }]), state)[0],
    ).toBeUndefined();
    expect(
      kiroUsageFormat.parseLine(usage("execution-c", [{ unit: "credit", usage: 0 }]), state)[0],
    ).toMatchObject({ model: "kiro-unknown", credits: 0, dedupeKey: "kiro:execution-c" });
    for (const summaries of [
      undefined,
      null,
      {},
      [],
      [null, 3, "credit"],
      [{ unit: "credits", usage: 1 }],
      [{ unit: "credit" }],
      [{ unit: "credit", usage: "0.5" }],
      [{ unit: "credit", usage: Number.NaN }],
      [{ unit: "credit", usage: Number.POSITIVE_INFINITY }],
      [
        { unit: "credit", usage: Number.MAX_VALUE },
        { unit: "credit", usage: Number.MAX_VALUE },
      ],
    ]) {
      expect(
        kiroUsageFormat.parseProjected(
          {
            timestamp: "2026-11-08T12:00:00.000Z",
            payload: {
              type: "usage_summary",
              executionId: "execution-invalid",
              promptTurnSummaries: summaries,
            },
          },
          state,
        ),
      ).toEqual([]);
    }
    expect(
      kiroUsageFormat.parseLine(
        usage("execution-mixed", [
          { unit: "credit", usage: -1 },
          { unit: "unknown", usage: 9 },
          { unit: "credit", usage: 0.25 },
        ]),
        state,
      )[0],
    ).toMatchObject({ credits: 0.25 });
  });

  it("preserves distinct native turns and stable copied history identities", () => {
    const source = kiroUsageFormat.state!.initial("/x/sessions/w/session-source/messages.jsonl");
    const fork = kiroUsageFormat.state!.initial("/x/sessions/w/session-fork/messages.jsonl");
    const summaries = [{ unit: "credit", usage: 0.125 }];
    const first = usage("execution-shared", summaries, { id: "turn-a-usage", turnId: "turn-a" });
    const second = usage("execution-shared", summaries, { id: "turn-b-usage", turnId: "turn-b" });
    const [sourceRecord] = kiroUsageFormat.parseLine(first, source);
    const [forkRecord] = kiroUsageFormat.parseLine(first, fork);
    const [secondRecord] = kiroUsageFormat.parseLine(second, source);
    expect(sourceRecord?.dedupeKey).toBe('kiro:turn:["execution-shared","turn-a"]');
    expect(forkRecord?.dedupeKey).toBe(sourceRecord?.dedupeKey);
    expect(secondRecord?.dedupeKey).not.toBe(sourceRecord?.dedupeKey);
    expect(kiroUsageFormat.parseProjected(JSON.parse(first), source)[0]?.dedupeKey).toBe(
      sourceRecord?.dedupeKey,
    );
    expect(kiroUsageFormat.selectFields).toMatchObject({
      id: true,
      payload: { executionId: true, turnId: true },
    });

    const fallbacks = [
      {
        line: usage(undefined, summaries, { id: "turn-c-usage", turnId: "turn-c" }),
        key: 'kiro:turn:[null,"turn-c"]',
      },
      {
        line: usage("execution-shared", summaries, { id: "row-only-a" }),
        key: "kiro:row:row-only-a",
      },
      {
        line: usage("execution-shared", summaries, { id: "row-only-b" }),
        key: "kiro:row:row-only-b",
      },
      {
        line: usage(undefined, summaries, { id: "row-without-execution" }),
        key: "kiro:row:row-without-execution",
      },
      { line: usage("legacy-execution", summaries), key: "kiro:legacy-execution" },
      { line: usage(undefined, summaries), key: null },
      { line: usage("", summaries, { id: "", turnId: "" }), key: null },
    ];
    for (const { line, key } of fallbacks) {
      expect(kiroUsageFormat.parseLine(line, source)[0]?.dedupeKey).toBe(key);
      expect(kiroUsageFormat.parseLine(line, fork)[0]?.dedupeKey).toBe(key);
    }
  });

  it("retains metered failed and aborted turns and follows model changes", () => {
    const state = kiroUsageFormat.state!.initial("/x/sessions/w/session-status/messages.jsonl");
    for (const [status, model] of [
      ["failed", "Auto"],
      ["aborted", "Claude Haiku 4.5"],
    ] as const) {
      kiroUsageFormat.parseLine(
        JSON.stringify({
          payload: { type: "agent_note", content: `The current model is ${model}.` },
        }),
        state,
      );
      expect(
        kiroUsageFormat.parseLine(
          usage("execution-status", [{ unit: "credit", usage: 0.375 }], { status, turnId: status }),
          state,
        )[0],
      ).toMatchObject({
        model: model.toLowerCase().replaceAll(" ", "-"),
        credits: 0.375,
        reportedCostUsd: null,
        totals: { uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      });
    }
  });
});
