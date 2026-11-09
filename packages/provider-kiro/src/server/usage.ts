import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  EMPTY_TOTALS,
  parseTimestampMs,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { KiroSettings } from "../settings.ts";

const KiroScanState = Schema.Struct({
  sessionId: Schema.String,
  model: Schema.mutableKey(Schema.String),
});
type KiroScanState = typeof KiroScanState.Type;

const MODEL_NOTE = /The current model is ([^\n<]+?)\.?\s*(?:\n|<|$)/;
const UNKNOWN_MODEL = "kiro-unknown";

function modelSlug(display: string): string {
  return display.trim().toLowerCase().replace(/\s+/g, "-");
}

function readCredits(summaries: unknown): number | null {
  if (!Array.isArray(summaries)) return null;
  let credits = 0;
  let found = false;
  for (const summary of summaries) {
    if (typeof summary !== "object" || summary === null) continue;
    const entry = summary as { unit?: unknown; usage?: unknown };
    if (
      entry.unit !== "credit" ||
      typeof entry.usage !== "number" ||
      !Number.isFinite(entry.usage)
    ) {
      continue;
    }
    credits += Math.max(0, entry.usage);
    found = true;
  }
  return found && Number.isFinite(credits) ? credits : null;
}

function sessionIdOf(filePath: string): string {
  return filePath.split(/[\\/]/).at(-2) ?? "";
}

function parseRecord(parsed: unknown, state: KiroScanState): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const entry = parsed as {
    timestamp?: unknown;
    payload?: {
      type?: unknown;
      content?: unknown;
      promptTurnSummaries?: unknown;
      executionId?: unknown;
    };
  };
  const payload = entry.payload;
  if (typeof payload !== "object" || payload === null) return [];
  if (payload.type === "agent_note") {
    const match = typeof payload.content === "string" ? MODEL_NOTE.exec(payload.content) : null;
    if (match?.[1]) state.model = modelSlug(match[1]);
    return [];
  }
  if (payload.type !== "usage_summary") return [];
  const timestampMs = parseTimestampMs(entry.timestamp);
  const credits = readCredits(payload.promptTurnSummaries);
  if (timestampMs === null || credits === null) return [];
  return [
    {
      provider: "kiro",
      timestampMs,
      model: state.model || UNKNOWN_MODEL,
      sessionId: state.sessionId,
      totals: EMPTY_TOTALS,
      reportedCostUsd: null,
      credits,
      speed: "standard",
      dedupeKey:
        typeof payload.executionId === "string" && payload.executionId.length > 0
          ? `kiro:${payload.executionId}`
          : null,
    },
  ];
}

export const kiroUsageFormat: TranscriptUsageFormat<KiroScanState> = {
  selectFields: {
    timestamp: true,
    payload: { type: true, content: true, promptTurnSummaries: true, executionId: true },
  },
  usageMarkers: ['"usage_summary"', '"agent_note"'],
  parseLine: (line, state) => {
    try {
      return parseRecord(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: parseRecord,
  state: {
    initial: (filePath) => ({ sessionId: sessionIdOf(filePath), model: "" }),
    schema: KiroScanState,
  },
  sharedSessionsAcrossFiles: true,
};

export const kiroUsageReader: ProviderUsageReader<KiroSettings, Path.Path> = {
  kind: "transcripts",
  provider: "kiro",
  format: kiroUsageFormat,
  directories: Effect.fn("kiroUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const kiroHome = environment.KIRO_HOME?.trim();
    const userHome = expandHomePath(environment.HOME?.trim() || homeDirectory, homeDirectory);
    const home =
      kiroHome && path.isAbsolute(expandHomePath(kiroHome, userHome))
        ? expandHomePath(kiroHome, userHome)
        : path.join(userHome, ".kiro");
    return [
      {
        dir: path.resolve(home, "sessions"),
        fileName: "messages.jsonl",
      },
    ];
  }),
};
