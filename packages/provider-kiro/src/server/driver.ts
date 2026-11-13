import { makeKiroTextGeneration } from "./textGeneration.ts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { KiroSettings } from "../settings.ts";
import { makeKiroMcpSupport } from "./mcp.ts";
import { kiroUsageReader } from "./usage.ts";
import { makeKiroMemoryController } from "./memory.ts";
import { makeKiroPowers } from "./powers.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { type KiroAdapterV2DriverEnv, makeKiroAdapterV2Driver } from "./adapter.ts";
import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  kiroDefaultModelId,
} from "./status.ts";
import { getKiroSkills, makeKiroSkills } from "./skills.ts";
import { kiroChatOptions } from "./models.ts";
import { applyKiroConfiguration, makeKiroConfigurations } from "./configuration.ts";
import { kiroDiscoveredAgentDescriptor, makeKiroDiscovery } from "./discovery.ts";
import { deleteKiroSession, listKiroSessions } from "./nativeSessions.ts";

const DRIVER_KIND = ProviderDriverKind.make("kiro");
const decodeKiroSettings = Schema.decodeSync(KiroSettings);
// Kiro updates itself in the background (`kiro-cli update` reports only), so
// T3 offers no one-click update.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type KiroDriverEnv =
  | KiroAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | ProviderHost.ProviderHost;

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  usage: kiroUsageReader,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  create: Effect.fn("KiroDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* SecureRandom.SecureRandom;
    const path = yield* Path.Path;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies KiroSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    // Advertisements belong to their workspace, never the instance-wide snapshot.
    const skills = yield* makeKiroSkills();
    const textGeneration = yield* makeKiroTextGeneration(effectiveConfig, processEnv);
    const mcp = yield* makeKiroMcpSupport();
    const memory = yield* makeKiroMemoryController({
      settings: effectiveConfig,
      environment: processEnv,
    });
    const configurations = yield* makeKiroConfigurations();
    const discovery = yield* makeKiroDiscovery(effectiveConfig, processEnv);
    const powers = yield* makeKiroPowers(
      effectiveConfig,
      processEnv,
      Effect.all(
        [
          SubscriptionRef.set(skills, new Map()),
          SubscriptionRef.set(configurations, new Map()),
          discovery.invalidate,
        ],
        { discard: true },
      ),
    );
    const workspaceRevision = yield* Ref.make(0);
    const observedSkills = yield* Ref.make(yield* SubscriptionRef.get(skills));
    const observedConfigurations = yield* Ref.make(yield* SubscriptionRef.get(configurations));
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialKiroProviderSnapshot(settings.provider).pipe(
          Effect.map(stampIdentity),
          Effect.flatMap((provider) =>
            Ref.get(workspaceRevision).pipe(
              Effect.map((revision) => ({ ...provider, workspaceRevision: revision })),
            ),
          ),
        ),
      checkProvider: checkKiroProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.flatMap((provider) =>
          Ref.get(workspaceRevision).pipe(
            Effect.map((revision) => ({ ...provider, workspaceRevision: revision })),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
      ),
      enrichSnapshot: ({ getSnapshot, publishSnapshot }) =>
        Stream.merge(
          SubscriptionRef.changes(skills).pipe(
            Stream.mapEffect((current) =>
              Ref.getAndSet(observedSkills, current).pipe(
                Effect.map((previous) => previous !== current),
              ),
            ),
          ),
          SubscriptionRef.changes(configurations).pipe(
            Stream.mapEffect((current) =>
              Ref.getAndSet(observedConfigurations, current).pipe(
                Effect.map((previous) => previous !== current),
              ),
            ),
          ),
        ).pipe(
          Stream.runForEach((changed) =>
            (changed
              ? Ref.updateAndGet(workspaceRevision, (revision) => revision + 1)
              : Ref.get(workspaceRevision)
            ).pipe(
              Effect.flatMap((revision) =>
                getSnapshot.pipe(
                  Effect.flatMap((provider) =>
                    provider.workspaceRevision === revision
                      ? Effect.void
                      : publishSnapshot({ ...provider, workspaceRevision: revision }),
                  ),
                ),
              ),
            ),
          ),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            // The cause keeps the failure; the detail reaches the snapshot, so it stays fixed.
            detail: "Failed to build Kiro snapshot.",
            cause,
          }),
      ),
    );

    // "Kiro default" selects the default the snapshot read from Kiro's model list.
    const orchestrationAdapter = yield* makeKiroAdapterV2Driver(
      snapshot.getSnapshot.pipe(Effect.map((current) => kiroDefaultModelId(current.models))),
      skills,
      configurations,
      mcp,
    )
      .create({ instanceId, displayName, accentColor, environment, enabled, config })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Kiro orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      invalidateCaches: Effect.all(
        [
          SubscriptionRef.set(skills, new Map()),
          SubscriptionRef.set(configurations, new Map()),
          discovery.invalidate,
        ],
        { discard: true },
      ),
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.gen(function* () {
              const base = yield* applyKiroConfiguration(
                configurations,
                cwd,
                yield* snapshot.getSnapshot,
              );
              const resources = base.status === "ready" ? yield* discovery.get(cwd) : undefined;
              const previousAgent = base.models
                .flatMap((model) => model.capabilities?.optionDescriptors ?? [])
                .find((option) => option.id === "mode");
              const agent =
                resources === undefined
                  ? previousAgent
                  : kiroDiscoveredAgentDescriptor(resources, previousAgent);
              const workspace = {
                ...base,
                skills: yield* getKiroSkills(skills, cwd, resources?.skills),
                optionDescriptors: kiroChatOptions([
                  ...("optionDescriptors" in base ? base.optionDescriptors : []).filter(
                    (option) => option.id !== "mode",
                  ),
                  ...(agent === undefined ? [] : [agent]),
                ]),
                models:
                  resources === undefined && agent === undefined
                    ? base.models
                    : base.models.map((model) => ({
                        ...model,
                        capabilities: createModelCapabilities({
                          optionDescriptors: kiroChatOptions([
                            ...(model.capabilities?.optionDescriptors ?? []).filter(
                              (option) => option.id !== "mode",
                            ),
                            ...(agent === undefined ? [] : [agent]),
                          ]),
                        }),
                      })),
              };
              return { ...workspace, workspaceModels: workspace.models.slice(0, 256) };
            }),
      acpSessionManagement: {
        listSessions: ({ cwd, cursor }) =>
          listKiroSessions({
            settings: effectiveConfig,
            environment: processEnv,
            cwd,
            ...(cursor === undefined ? {} : { cursor }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.provideService(Path.Path, path),
          ),
        deleteSession: ({ cwd, sessionId }) =>
          deleteKiroSession({
            settings: effectiveConfig,
            environment: processEnv,
            cwd,
            sessionId,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.provideService(Path.Path, path),
          ),
      },
      orchestrationAdapter,
      textGeneration,
      kiroMcp: mcp,
      kiroMemory: memory,
      kiroPowers: powers,
    } satisfies ProviderInstance;
  }),
};
