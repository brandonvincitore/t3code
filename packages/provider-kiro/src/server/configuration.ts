import type { ProviderOptionDescriptor, ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Effect from "effect/Effect";
import {
  kiroChatOptions,
  kiroConfigModels,
  mergeKiroConfigModels,
  type KiroConfigModel,
} from "./models.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Acp from "effect-acp/compat";
import {
  KIRO_AGENT_CONFIG_ID,
  KIRO_AUTOPILOT_CONFIG_ID,
  KIRO_APPROVE_FOR_ME_CONFIG_ID,
  KIRO_EFFORT_CONFIG_ID,
  KIRO_MODEL_CONFIG_ID,
} from "./acpSupport.ts";

interface KiroConfiguration {
  readonly reflectionKnown: boolean;
  readonly options: ReadonlyArray<ProviderOptionDescriptor>;
  readonly models: ReadonlyArray<KiroConfigModel>;
  readonly agent: string | undefined;
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
      (option) =>
        option.id !== KIRO_AUTOPILOT_CONFIG_ID &&
        option.id !== KIRO_MODEL_CONFIG_ID &&
        option.id !== KIRO_APPROVE_FOR_ME_CONFIG_ID,
    ),
    modeState,
  });
  const model = configOptions.find(
    (option) => option.id === KIRO_MODEL_CONFIG_ID || option.category === "model",
  );
  const currentModel = model?.type === "select" ? model.currentValue : modelState?.currentModelId;
  const hasModelCatalog = model?.type === "select" || modelState != null;
  const models = kiroConfigModels(
    model?.type === "select"
      ? configOptions
      : [
          {
            id: KIRO_MODEL_CONFIG_ID,
            type: "select",
            options: (modelState?.availableModels ?? [])
              .slice(0, 256)
              .map((entry) => ({ value: entry.modelId, name: entry.name, _meta: entry._meta })),
          },
        ],
  );
  const withdrewModels = hasModelCatalog && models.length === 0;
  const agentOption = configOptions.find((option) => option.id === KIRO_AGENT_CONFIG_ID);
  const agent =
    agentOption?.type === "select" ? agentOption.currentValue : modeState?.currentModeId;
  const effort = descriptors.find((option) => option.id === KIRO_EFFORT_CONFIG_ID);
  yield* SubscriptionRef.update(configurations, (current) => {
    const key = cwd;
    const previous = current.get(key);
    const sameAgent =
      agent === undefined || previous?.agent === undefined || agent === previous.agent;
    const effortByModel = new Map(
      sameAgent && !withdrewModels ? previous?.effortByModel : undefined,
    );
    for (const model of models) {
      if (model.effort !== undefined) effortByModel.set(model.value, model.effort);
    }
    if (currentModel !== undefined && !withdrewModels) {
      const advertised = models.find((model) => model.value === currentModel)?.effort;
      if (effort !== undefined && advertised !== null) {
        const choices =
          effort.type === "select"
            ? effort.options.filter((choice) => choice.id !== "default")
            : [];
        const { currentValue, ...descriptor } = effort;
        effortByModel.set(
          currentModel,
          effort.type === "select" && choices.length > 0
            ? {
                ...descriptor,
                type: "select",
                id: "reasoningEffort",
                role: "reasoning",
                options: choices,
                ...(typeof currentValue === "string" &&
                choices.some((choice) => choice.id === currentValue)
                  ? { currentValue }
                  : {}),
              }
            : null,
        );
      }
      // Kiro can advertise the model before its effort; absence is not a capability denial.
    }
    const reflectionKnown =
      previous?.reflectionKnown === true ||
      configOptions.some((option) => option.id === "memoryReflection");
    const incoming = {
      reflectionKnown,
      models: !hasModelCatalog && sameAgent ? (previous?.models ?? models) : models,
      agent: agent ?? previous?.agent,
      options: kiroChatOptions(
        descriptors.filter((option) => option.id !== KIRO_EFFORT_CONFIG_ID),
        reflectionKnown,
      ),
      effortByModel,
    };
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
  const models = mergeKiroConfigModels(snapshot.models, configuration.models).map((model) => {
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
        optionDescriptors: kiroChatOptions([
          ...(model.capabilities?.optionDescriptors ?? []).filter(
            (option) => !replaced.has(option.id),
          ),
          ...incoming,
        ]),
      }),
    };
  });
  return { ...snapshot, models, optionDescriptors: configuration.options };
});
