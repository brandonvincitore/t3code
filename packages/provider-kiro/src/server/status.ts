import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { KiroSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  KIRO_AGENT_CONFIG_ID,
  KIRO_SUPPORTED_RUNTIME_MODES,
  makeKiroAcpRuntime,
  kiroWorkflowSessionMeta,
} from "./acpSupport.ts";
import {
  kiroConfigModels,
  kiroModelCapabilities,
  kiroModelName,
  mergeKiroConfigModels,
} from "./models.ts";
import { kiroSessionCapabilities } from "./nativeSessions.ts";
import { kiroWorkflowPreferenceDescriptor } from "./workflowPreferences.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");
const KIRO_PRESENTATION = {
  displayName: "Kiro",
  showInteractionModeToggle: false,
  supportedRuntimeModes: KIRO_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const KIRO_DEFAULT_MODEL_SLUG = "default";
const KIRO_FALLBACK_DEFAULT_MODEL = "auto";
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIRO_DEFAULT_MODEL_SLUG,
    name: "Kiro default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const KIRO_API_KEY_ENV = "KIRO_API_KEY";
const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * The agent picker is not a model trait, but the composer reads options per
 * model, so every model, custom ones included, carries it.
 */
const kiroModels = (
  settings: KiroSettings,
  listed: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
  options: ReadonlyArray<ProviderOptionDescriptor> = [],
) =>
  providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES).map((model) => {
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const additions = options.filter(
      (option) => !descriptors.some((descriptor) => descriptor.id === option.id),
    );
    return additions.length === 0
      ? model
      : {
          ...model,
          capabilities: createModelCapabilities({
            optionDescriptors: [...descriptors, ...additions],
          }),
        };
  });

const snapshot = (
  settings: KiroSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed?: ReadonlyArray<ServerProviderModel>,
  options: ReadonlyArray<ProviderOptionDescriptor> = [],
) => ({
  ...buildServerProvider({
    // Gives the snapshot its version advisory; Kiro runs no enrichment pass.
    driver: KIRO_DRIVER_KIND,
    presentation: KIRO_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: kiroModels(settings, listed, options),
    // `/compact` runs `_kiro/session/compact`; see compactKiroSession.
    slashCommands: [],
    probe,
  }),
  supportsTextGeneration: false,
  supportsThreadTitleGeneration: true,
});

export const buildInitialKiroProviderSnapshot = Effect.fn(
  "KiroProvider.buildInitialKiroProviderSnapshot",
)(function* (settings: KiroSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking Kiro CLI availability..."
      : "Kiro is disabled in T3 Code settings.",
  });
});

const runKiroCli = Effect.fn("KiroProvider.runKiroCli")(function* (
  settings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "kiro-cli";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

const KiroWhoami = Schema.fromJsonString(
  Schema.Struct({
    accountType: Schema.optional(Schema.NullOr(Schema.String)),
    email: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeKiroWhoami = Schema.decodeUnknownOption(KiroWhoami);

/**
 * Reads `kiro-cli whoami --format json`: `{"account":null}` with exit 1 means
 * signed out. Only the first line is decoded, since an Identity Center login
 * follows it with a plain-text `Profile:` block.
 */
export function kiroAuthFromWhoami(
  output: { readonly code: number; readonly stdout: string } | undefined,
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  if (output.code !== 0) {
    return output.stdout.includes('"account":null')
      ? { status: "unauthenticated" }
      : { status: "unknown" };
  }
  const firstLine = output.stdout.trimStart().split("\n", 1)[0] ?? "";
  const account = Option.getOrUndefined(decodeKiroWhoami(firstLine.trim()));
  if (account?.accountType === "ApiKey" || environment[KIRO_API_KEY_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Kiro API key" };
  }
  return {
    status: "authenticated",
    label: "Kiro account",
    ...(account?.email ? { email: account.email } : {}),
  };
}

const KiroModelList = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        model_id: Schema.String,
        model_name: Schema.optional(Schema.String),
      }),
    ),
    default_model: Schema.optional(Schema.String),
  }),
);
const decodeKiroModelList = Schema.decodeUnknownOption(KiroModelList);

/**
 * Reads `kiro-cli chat --list-models --format json`, the account's models. The
 * default entry keeps its name but takes the "default" slug, with Kiro's id as its
 * alias. The config template enriches this list; anything unparsable keeps
 * the built-in list.
 */
function kiroModelsFromList(
  output: { readonly code: number; readonly stdout: string } | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  if (output === undefined || output.code !== 0) return undefined;
  const list = Option.getOrUndefined(decodeKiroModelList(output.stdout.trim()));
  if (list === undefined || list.models.length === 0) return undefined;
  const defaultId = list.default_model ?? KIRO_FALLBACK_DEFAULT_MODEL;
  const listedDefault = list.models.find((model) => model.model_id === defaultId);
  const defaultModel: ServerProviderModel = {
    slug: KIRO_DEFAULT_MODEL_SLUG,
    // Named after the model it runs, so a named default isn't hidden behind "Kiro default".
    name: listedDefault
      ? kiroModelName(listedDefault.model_name?.trim() || listedDefault.model_id)
      : "Kiro default",
    aliases: [defaultId],
    isCustom: false,
    isDefault: true,
    capabilities: kiroModelCapabilities(defaultId),
  };
  const models = list.models
    .filter((model) => model.model_id !== KIRO_DEFAULT_MODEL_SLUG)
    .slice(0, 256)
    .map((model) =>
      model === listedDefault
        ? defaultModel
        : {
            slug: model.model_id,
            name: kiroModelName(model.model_name?.trim() || model.model_id),
            isCustom: false,
            capabilities: kiroModelCapabilities(model.model_id),
          },
    );
  // New threads select "default", so it is listed even when Kiro's list leaves its default out.
  return models.includes(defaultModel) ? models : [defaultModel, ...models];
}

/**
 * Kiro's own id for "Kiro default": the alias the model list gave it, else
 * `auto`, Kiro's documented default.
 */
export function kiroDefaultModelId(models: ReadonlyArray<ServerProviderModel>): string {
  return (
    models.find((model) => model.slug === KIRO_DEFAULT_MODEL_SLUG)?.aliases?.[0] ??
    KIRO_FALLBACK_DEFAULT_MODEL
  );
}

const KiroConfigTemplate = Schema.Struct({
  configOptions: Schema.Array(Schema.Unknown),
});
const decodeKiroAgentOption = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Literal(KIRO_AGENT_CONFIG_ID),
    type: Schema.Literal("select"),
    currentValue: Schema.optional(Schema.String),
    options: Schema.Array(
      Schema.Struct({
        value: Schema.String,
        name: Schema.String,
        description: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeKiroConfigTemplate = Schema.decodeUnknownOption(KiroConfigTemplate);
const decodeKiroExtensionMethods = Schema.decodeUnknownOption(
  Schema.Struct({ kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }) }),
);

/**
 * The thread's agent picker, from Kiro's `_kiro/config/template` result, without
 * opening a session. The template reads no workspace, so a project's
 * `.kiro/agents` are not offered.
 */
export function kiroAgentDescriptor(template: unknown): ProviderOptionDescriptor | undefined {
  const decoded = Option.getOrUndefined(decodeKiroConfigTemplate(template));
  const mode = decoded?.configOptions.slice(0, 16).flatMap((raw) => {
    const option = Option.getOrUndefined(decodeKiroAgentOption(raw));
    return option === undefined ? [] : [option];
  })[0];
  const defaultAgent = typeof mode?.currentValue === "string" ? mode.currentValue : undefined;
  const choices = (mode?.options ?? []).flatMap((choice) => {
    const id = choice.value.trim();
    const label = choice.name.trim() || id;
    const description = choice.description?.trim();
    return id.length === 0
      ? []
      : [
          {
            id,
            label,
            ...(description ? { description } : {}),
          },
        ];
  });
  // One agent is nothing to choose between.
  if (choices.length < 2) return undefined;
  return {
    id: KIRO_AGENT_CONFIG_ID,
    label: "Agent",
    type: "select",
    options: choices,
    ...(defaultAgent !== undefined && choices.some((choice) => choice.id === defaultAgent)
      ? { currentValue: defaultAgent }
      : {}),
  };
}

/**
 * Reads Kiro's model, agent and workflow options without sending session/new
 * or session/load. Discovery needs no throwaway session or session MCP tools.
 */
const probeKiroOptions = Effect.fn("KiroProvider.probeKiroOptions")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runtime = yield* makeKiroAcpRuntime({
    settings,
    environment,
    cwd: yield* HostProcess.WorkingDirectory,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  });
  const initialized = yield* runtime.initialize();
  const methods = Option.getOrUndefined(
    decodeKiroExtensionMethods(initialized.agentCapabilities?._meta),
  )?.kiro.extensionMethods;
  if (!methods?.includes("_kiro/config/template"))
    return {
      options: [],
      models: [],
      nativeSessions: kiroSessionCapabilities(initialized),
      canCompact: methods?.includes("_kiro/session/compact") === true,
    };
  const workflowMeta = kiroWorkflowSessionMeta(initialized.agentCapabilities?._meta);
  const template = yield* runtime
    .request("_kiro/config/template", workflowMeta === undefined ? {} : { _meta: workflowMeta })
    .pipe(Effect.option);
  const decoded = Option.getOrUndefined(decodeKiroConfigTemplate(Option.getOrUndefined(template)));
  return {
    models: kiroConfigModels(decoded?.configOptions ?? []),
    options: [
      kiroAgentDescriptor(Option.getOrUndefined(template)),
      kiroWorkflowPreferenceDescriptor(Option.getOrUndefined(template)),
    ].filter((descriptor): descriptor is ProviderOptionDescriptor => descriptor !== undefined),
    nativeSessions: kiroSessionCapabilities(initialized),
    canCompact: methods?.includes("_kiro/session/compact") === true,
  };
}, Effect.scoped);

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runKiroCli(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("kiro", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
        : "Failed to run `kiro-cli --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI is installed but failed to run.",
    });
  }

  const whoamiResult = yield* runKiroCli(
    settings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(
    Effect.timeoutOption(resolveProviderProbeTimeoutMs("kiro", AUTH_PROBE_TIMEOUT_MS, environment)),
    Effect.result,
  );
  const auth = kiroAuthFromWhoami(
    Result.isSuccess(whoamiResult) ? Option.getOrUndefined(whoamiResult.success) : undefined,
    environment,
  );
  if (auth.status === "unauthenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth,
      message: "Kiro CLI is installed but not signed in. Run `kiro-cli login`.",
    });
  }
  // Signed out, `--list-models` starts a browser login instead, and the agent
  // probe fails to start, so both run only once `whoami` has confirmed the
  // account. Without an agent list the composer shows no agent picker.
  const [listed, options] =
    auth.status === "authenticated"
      ? yield* Effect.all(
          [
            runKiroCli(settings, ["chat", "--list-models", "--format", "json"], environment).pipe(
              Effect.timeoutOption(
                resolveProviderProbeTimeoutMs("kiro", AUTH_PROBE_TIMEOUT_MS, environment),
              ),
              Effect.map((output) => kiroModelsFromList(Option.getOrUndefined(output))),
              Effect.orElseSucceed(() => undefined),
            ),
            probeKiroOptions(settings, environment).pipe(
              Effect.timeoutOption(
                resolveProviderProbeTimeoutMs("kiro", AUTH_PROBE_TIMEOUT_MS, environment),
              ),
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            ),
          ],
          { concurrency: "unbounded" },
        )
      : [undefined, undefined];
  const checked = snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: auth.status === "authenticated" ? "ready" : "warning",
      auth,
      ...(auth.status === "authenticated"
        ? {}
        : { message: "Could not confirm the Kiro sign-in. Run `kiro-cli whoami` to check." }),
    },
    mergeKiroConfigModels(listed ?? KIRO_BUILT_IN_MODELS, options?.models ?? []),
    options?.options,
  );
  return {
    ...checked,
    ...(options === undefined ? {} : { nativeSessions: options.nativeSessions }),
    slashCommands: options?.canCompact === true ? [COMPACT_SLASH_COMMAND] : [],
  };
});
