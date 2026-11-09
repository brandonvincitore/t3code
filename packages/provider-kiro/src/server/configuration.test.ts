import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import { KiroSettings } from "../settings.ts";

const decodeSettings = Schema.decodeEffect(KiroSettings);
import { buildInitialKiroProviderSnapshot } from "./status.ts";
import {
  applyKiroConfiguration,
  makeKiroConfigurations,
  recordKiroConfiguration,
} from "./configuration.ts";

const model = (value: string) => ({
  id: "model",
  name: "Model",
  type: "select" as const,
  category: "model" as const,
  currentValue: value,
  options: [
    { value: "future-model", name: "Future model" },
    { value: "other-model", name: "Other model" },
  ],
});
const effort = {
  id: "effortLevel",
  name: "Effort",
  type: "select" as const,
  category: "thought_level" as const,
  currentValue: "medium",
  options: [
    { value: "medium", name: "Medium" },
    { value: "extreme", name: "Extreme" },
  ],
};

describe("Kiro workspace configuration", () => {
  it.effect("uses live model choices and effort only in their workspace and model", () =>
    Effect.gen(function* () {
      const configurations = yield* makeKiroConfigurations();
      const draft = yield* buildInitialKiroProviderSnapshot(
        yield* decodeSettings({ enabled: true }),
      );
      const base = ServerProvider.make({
        ...draft,
        models: [
          ...draft.models,
          {
            slug: "future-model",
            name: "Previously listed model",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "low",
                  options: [{ id: "low", label: "Low", isDefault: true }],
                },
              ],
            }),
          },
        ],
        driver: ProviderDriverKind.make("kiro"),
        continuation: { groupKey: "kiro:instance:kiro-test" },
        instanceId: ProviderInstanceId.make("kiro-test"),
      });
      yield* recordKiroConfiguration(configurations, "/work/a", [model("future-model"), effort]);
      const a = yield* applyKiroConfiguration(configurations, "/work/a", base);
      const future = a.models.find((entry) => entry.slug === "future-model");
      const reasoning = future?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "reasoningEffort",
      );
      assert.equal(reasoning?.currentValue, "medium");
      assert.equal(
        reasoning?.type === "select" ? reasoning.options.some((option) => option.isDefault) : true,
        false,
      );
      assert.equal(
        a.models.find((entry) => entry.slug === "other-model")?.capabilities?.optionDescriptors
          ?.length,
        0,
      );
      assert.strictEqual(yield* applyKiroConfiguration(configurations, "/work/b", base), base);
      yield* recordKiroConfiguration(configurations, "/work/a", [model("future-model")]);
      const removed = yield* applyKiroConfiguration(configurations, "/work/a", base);
      assert.equal(
        removed.models.find((entry) => entry.slug === "future-model")?.capabilities
          ?.optionDescriptors?.length,
        0,
      );
    }),
  );
});
