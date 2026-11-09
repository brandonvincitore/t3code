import { describe, expect, it } from "@effect/vitest";

import { kiroUsageFormat } from "./usage.ts";

const usage = (executionId: string, summaries: unknown[]) =>
  JSON.stringify({
    timestamp: "2026-11-08T12:00:00.000Z",
    payload: { type: "usage_summary", executionId, promptTurnSummaries: summaries },
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
        { unit: "credit", usage: 1.25 },
        { unit: "token", usage: 800 },
        { unit: "credit", usage: 0.75 },
      ]),
      state,
    );
    expect(record).toMatchObject({
      provider: "kiro",
      model: "claude-sonnet-4.5",
      sessionId: "session-a",
      credits: 2,
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
    ).toMatchObject({ model: "kiro-unknown", credits: 0, dedupeKey: "kiro:execution-c" });
  });
});
