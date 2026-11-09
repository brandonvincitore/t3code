import type { ProviderOptionDescriptor, ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  acpProviderOptionDescriptors,
  flattenSelectChoices,
} from "@t3tools/provider-acp/server/sessionConfig";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Acp from "effect-acp/compat";
import {
  KIRO_AUTOPILOT_CONFIG_ID,
  KIRO_EFFORT_CONFIG_ID,
  KIRO_MODEL_CONFIG_ID,
} from "./acpSupport.ts";

interface KiroConfiguration {
  readonly options: ReadonlyArray<ProviderOptionDescriptor>;
  readonly models: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly effortByModel: ReadonlyMap<string, ProviderOptionDescriptor | null>;
}

export type KiroConfigurations = SubscriptionRef.SubscriptionRef<
  ReadonlyMap<string, KiroConfiguration>
>;

export const makeKiroConfigurations = () =>
  SubscriptionRef.make<ReadonlyMap<string, KiroConfiguration>>(new Map());

export const recordKiroConfiguration = Effect.fn("KiroConfiguration.record")(function* (
  configurations: KiroConfigurations,
  cwd: string,
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
  modeState?: AcpSessionModeState,
  modelState?: Acp.SessionModelState | null,
) {
  const descriptors = acpProviderOptionDescriptors({
    configOptions: configOptions.filter(
      (option) => option.id !== KIRO_AUTOPILOT_CONFIG_ID && option.id !== KIRO_MODEL_CONFIG_ID,
    ),
    modeState,
  });
  const model = configOptions.find(
    (option) => option.id === KIRO_MODEL_CONFIG_ID || option.category === "model",
  );
  const currentModel = model?.type === "select" ? model.currentValue : modelState?.currentModelId;
  const models =
    model?.type === "select"
      ? flattenSelectChoices(model.options).slice(0, 256)
      : (modelState?.availableModels ?? [])
          .slice(0, 256)
          .map((entry) => ({ value: entry.modelId, name: entry.name }));
  const effort = descriptors.find((option) => option.id === KIRO_EFFORT_CONFIG_ID);
  yield* SubscriptionRef.update(configurations, (current) => {
    const key = cwd;
    const effortByModel = new Map(current.get(key)?.effortByModel);
    if (currentModel !== undefined) {
      if (effort === undefined) effortByModel.set(currentModel, null);
      else
        effortByModel.set(
          currentModel,
          effort.type === "select" ? { ...effort, id: "reasoningEffort", role: "reasoning" } : null,
        );
    }
    const incoming = {
      models,
      options: descriptors.filter((option) => option.id !== KIRO_EFFORT_CONFIG_ID),
      effortByModel,
    };
    const previous = current.get(key);
    const comparable = (configuration: KiroConfiguration) => ({
      ...configuration,
      effortByModel: [...configuration.effortByModel],
    });
    if (
      previous !== undefined &&
      JSON.stringify(comparable(previous)) === JSON.stringify(comparable(incoming))
    )
      return current;
    const next = new Map(current);
    next.delete(key);
    next.set(key, incoming);
    if (next.size > 64) {
      const oldest = next.keys().next().value;
      if (oldest !== undefined) next.delete(oldest);
    }
    return next;
  });
});

export const applyKiroConfiguration = Effect.fn("KiroConfiguration.apply")(function* (
  configurations: KiroConfigurations,
  cwd: string,
  snapshot: ServerProvider,
) {
  const configuration = (yield* SubscriptionRef.get(configurations)).get(cwd);
  if (configuration === undefined) return snapshot;
  const known = new Set(snapshot.models.flatMap((model) => [model.slug, ...(model.aliases ?? [])]));
  const models = [
    ...snapshot.models,
    ...configuration.models.flatMap((model) =>
      !model.value.trim() || model.value.length > 256 || known.has(model.value)
        ? []
        : [
            {
              slug: model.value,
              name: model.name.trim().slice(0, 256) || model.value,
              isCustom: false,
              capabilities: null,
              aliases: undefined,
            },
          ],
    ),
  ].map((model) => {
    const modelId = model.slug === "default" ? model.aliases?.[0] : model.slug;
    const effort = modelId === undefined ? undefined : configuration.effortByModel.get(modelId);
    const incoming = [...configuration.options, ...(effort == null ? [] : [effort])];
    const replaced = new Set([
      ...incoming.map((option) => option.id),
      ...(effort === undefined ? [] : ["reasoningEffort", KIRO_EFFORT_CONFIG_ID]),
    ]);
    return {
      ...model,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          ...(model.capabilities?.optionDescriptors ?? []).filter(
            (option) => !replaced.has(option.id),
          ),
          ...incoming,
        ],
      }),
    };
  });
  return { ...snapshot, models, optionDescriptors: configuration.options };
});
