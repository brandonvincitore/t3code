import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities, formatModelSlugName } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const reflection: ProviderOptionDescriptor = {
  id: "memoryReflection",
  label: "Memory reflection",
  type: "select",
  description:
    "Allow this conversation to reflect on new memory. Applied when its next session starts or reopens.",
  options: [
    { id: "off", label: "Off" },
    { id: "on", label: "On" },
  ],
};

export function kiroChatOptions(options: ReadonlyArray<ProviderOptionDescriptor>) {
  const filtered = options
    .filter((option) => option.id !== "contentCollection")
    .map((option) => {
      if (option.id !== "memoryReflection") return option;
      const { currentValue: _currentValue, ...descriptor } = option;
      return {
        ...descriptor,
        ...(descriptor.type === "select"
          ? { options: descriptor.options.map(({ isDefault: _isDefault, ...choice }) => choice) }
          : {}),
      };
    });
  if (!filtered.some((option) => option.id === "memoryReflection")) filtered.push(reflection);
  const rank = (id: string) =>
    ["reasoningEffort", "effortLevel", "mode", "memoryReflection", "workflowLaunch"].indexOf(id);
  return filtered.toSorted(
    (a, b) => (rank(a.id) < 0 ? 99 : rank(a.id)) - (rank(b.id) < 0 ? 99 : rank(b.id)),
  );
}

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: kiroChatOptions([]) });

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_4_6_EFFORT_LEVELS = ["low", "medium", "high", "max"];
const GPT_5_6_EFFORT_LEVELS = ["none", ...CLAUDE_EFFORT_LEVELS];
const KIMI_K3_EFFORT_LEVELS = ["low", "high", "max"];

/**
 * Reasoning levels per Kiro model id and its default level, copied from what
 * Kiro 2.32.0 (Haiku 5.5: 2.37.1) advertises, since `--list-models` names none.
 * Missing template metadata uses these verified fallbacks; live options remain authoritative.
 */
const KIRO_MODEL_EFFORT: Readonly<
  Record<string, { readonly levels: ReadonlyArray<string>; readonly defaultLevel: string }>
> = {
  "claude-fable-5.1": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-opus-5.5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "medium" },
  "claude-opus-5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-opus-4.8": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-opus-4.7": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "xhigh" },
  "claude-opus-4.6": { levels: CLAUDE_4_6_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-sonnet-5.5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-sonnet-5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-sonnet-4.6": { levels: CLAUDE_4_6_EFFORT_LEVELS, defaultLevel: "high" },
  "claude-haiku-5.5": { levels: CLAUDE_EFFORT_LEVELS, defaultLevel: "medium" },
  "gpt-5.6-sol": { levels: GPT_5_6_EFFORT_LEVELS, defaultLevel: "high" },
  "gpt-5.6-terra": { levels: GPT_5_6_EFFORT_LEVELS, defaultLevel: "high" },
  "gpt-5.6-luna": { levels: GPT_5_6_EFFORT_LEVELS, defaultLevel: "high" },
  "kimi-k3": { levels: KIMI_K3_EFFORT_LEVELS, defaultLevel: "max" },
};
const KIRO_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function kiroModelCapabilities(modelId: string): ModelCapabilities {
  const effort = KIRO_MODEL_EFFORT[modelId];
  if (effort === undefined) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: kiroChatOptions([
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: effort.levels.map((level) => ({
          value: level,
          label: KIRO_EFFORT_LABELS[level] ?? level,
          isDefault: level === effort.defaultLevel,
        })),
      }),
    ]),
  });
}

const decodeModelOption = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("select"),
    category: Schema.optional(Schema.String),
    options: Schema.Array(Schema.Unknown),
  }),
);
const decodeChoice = Schema.decodeUnknownOption(
  Schema.Struct({
    value: Schema.String,
    name: Schema.String,
    _meta: Schema.optional(Schema.Unknown),
  }),
);
const decodeGroup = Schema.decodeUnknownOption(
  Schema.Struct({ options: Schema.Array(Schema.Unknown) }),
);
const decodeEffort = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({
      hasEffort: Schema.Boolean,
      effortLevels: Schema.optional(Schema.Array(Schema.String)),
      defaultEffortLevel: Schema.optional(Schema.String),
    }),
  }),
);

export interface KiroConfigModel {
  readonly value: string;
  readonly name: string;
  readonly effort: ProviderOptionDescriptor | null | undefined;
}

function modelEffort(meta: unknown): ProviderOptionDescriptor | null | undefined {
  const metadata = Option.getOrUndefined(decodeEffort(meta))?.kiro;
  if (metadata === undefined) return undefined;
  if (!metadata.hasEffort) return null;
  const levels = metadata.effortLevels;
  if (
    !levels?.length ||
    levels.length > 64 ||
    levels.some((level) => !level.trim() || level !== level.trim() || level.length > 256)
  )
    return undefined;
  const choices = [...new Set(levels)].filter((level) => level !== "default");
  if (!choices.length) return null;
  return buildSelectOptionDescriptor({
    id: "reasoningEffort",
    label: "Reasoning",
    options: choices.map((level) => ({
      value: level,
      label: KIRO_EFFORT_LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1),
      isDefault: level === metadata.defaultEffortLevel,
    })),
  });
}

export function kiroConfigModels(
  configOptions: ReadonlyArray<unknown>,
): ReadonlyArray<KiroConfigModel> {
  const model = configOptions.slice(0, 16).flatMap((raw) => {
    const option = Option.getOrUndefined(decodeModelOption(raw));
    return option !== undefined && (option.id === "model" || option.category === "model")
      ? [option]
      : [];
  })[0];
  const choices = (model?.options ?? []).slice(0, 256).flatMap((raw) => {
    const group = Option.getOrUndefined(decodeGroup(raw));
    return group?.options.slice(0, 256) ?? [raw];
  });
  const seen = new Set<string>();
  return choices.slice(0, 256).flatMap((raw) => {
    const choice = Option.getOrUndefined(decodeChoice(raw));
    if (
      choice === undefined ||
      !choice.value.trim() ||
      choice.value !== choice.value.trim() ||
      choice.value.length > 256 ||
      choice.value === "default" ||
      seen.has(choice.value)
    )
      return [];
    seen.add(choice.value);
    return [
      {
        value: choice.value,
        name: kiroModelName(choice.name.trim().slice(0, 256) || choice.value),
        effort: modelEffort(choice._meta),
      },
    ];
  });
}

const KIRO_MODEL_NAMES: Readonly<Record<string, string>> = {
  "kimi-k3": "Kimi K3",
  "deepseek-3.2": "DeepSeek 3.2",
  "minimax-m2.5": "MiniMax M2.5",
  "minimax-m2.1": "MiniMax M2.1",
  "glm-5": "GLM 5",
  "qwen3-coder-next": "Qwen3 Coder Next",
};

export function kiroModelName(name: string): string {
  return KIRO_MODEL_NAMES[name] ?? formatModelSlugName(name);
}

export function mergeKiroConfigModels(
  models: ReadonlyArray<ServerProviderModel>,
  configuration: ReadonlyArray<KiroConfigModel>,
): ReadonlyArray<ServerProviderModel> {
  const byId = new Map(configuration.map((model) => [model.value, model]));
  const known = new Set(models.flatMap((model) => [model.slug, ...(model.aliases ?? [])]));
  return [
    ...models,
    ...configuration
      .filter((model) => !known.has(model.value))
      .map((model) => ({
        slug: model.value,
        name: model.name,
        isCustom: false,
        capabilities: kiroModelCapabilities(model.value),
        aliases: undefined,
      })),
  ]
    .slice(0, 256)
    .map((model) => {
      const modelId = model.slug === "default" ? model.aliases?.[0] : model.slug;
      const choice = modelId === undefined ? undefined : byId.get(modelId);
      const effort = choice?.effort;
      const name =
        modelId !== undefined && (model.name === modelId || model.name === kiroModelName(modelId))
          ? (choice?.name ?? model.name)
          : model.name;
      return {
        ...model,
        name: model.isCustom ? model.name : kiroModelName(name),
        ...(effort === undefined
          ? {}
          : {
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  ...(model.capabilities?.optionDescriptors ?? []).filter(
                    (option) => option.id !== "reasoningEffort",
                  ),
                  ...(effort === null ? [] : [effort]),
                ],
              }),
            }),
      };
    });
}
