import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderOptionDescriptor, ServerProviderSkill } from "@t3tools/contracts";
import type { KiroSettings } from "../settings.ts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeKiroAcpRuntime } from "./acpSupport.ts";

const decodeMethods = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({ extensionMethods: Schema.Array(Schema.String) }),
  }),
);
const decodeState = Schema.decodeUnknownOption(
  Schema.Struct({
    resources: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        items: Schema.Array(
          Schema.Struct({
            layer: Schema.String,
            standing: Schema.Struct({ kind: Schema.String }),
            value: Schema.Struct({
              id: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
              description: Schema.optional(Schema.String),
              uri: Schema.optional(Schema.String),
            }),
          }),
        ),
      }),
    ),
  }),
);

interface WorkspaceResources {
  readonly agentChoices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const boundedName = (name: string | undefined) =>
  name && name === name.trim() && !/\s/u.test(name) && name.length <= 128 ? name : undefined;

function resourcesFromState(state: unknown): WorkspaceResources | undefined {
  const decoded = Option.getOrUndefined(decodeState(state));
  if (decoded === undefined) return undefined;
  const agents = new Map<string, WorkspaceResources["agentChoices"][number]>();
  const skills = new Map<string, ServerProviderSkill>();
  for (const resource of decoded.resources.slice(0, 32)) {
    if (resource.type !== "agent" && resource.type !== "skill") continue;
    for (const item of resource.items.slice(0, 256)) {
      if (item.standing.kind !== "active") continue;
      const { value } = item;
      const name = boundedName(resource.type === "agent" ? value.id : value.name);
      if (name === undefined) continue;
      const description = value.description?.trim().slice(0, 1_024);
      if (resource.type === "agent") {
        agents.set(name, {
          id: name,
          label: value.name?.trim().slice(0, 256) || name,
          ...(description ? { description } : {}),
        });
      } else {
        skills.set(name, {
          name,
          ...(description ? { description } : {}),
          path: value.uri?.trim().slice(0, 4_096) || `acp://skill/${encodeURIComponent(name)}`,
          scope: item.layer === "workspace" ? "project" : "agent",
          enabled: true,
        });
      }
    }
  }
  return {
    agentChoices: [...agents.values()].slice(0, 128),
    skills: [...skills.values()].slice(0, 128),
  };
}

/** Kiro resolves policy, disabled resources, custom homes, and project precedence itself. */
export const makeKiroDiscovery = Effect.fn("KiroDiscovery.make")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const probeEnvironment = providerProbeEnvironment(environment);
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* SecureRandom.SecureRandom;
  const cache = yield* Ref.make(
    new Map<
      string,
      { readonly resources: WorkspaceResources | undefined; readonly expiresAt: number }
    >(),
  );
  const semaphore = yield* Semaphore.make(1);
  const invalidate = semaphore.withPermit(Ref.set(cache, new Map()));
  const probe = Effect.fn("KiroDiscovery.probe")(
    function* (cwd: string) {
      const runtime = yield* makeKiroAcpRuntime({
        settings,
        environment: probeEnvironment,
        cwd,
        authenticateOnAuthRequired: false,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-code-workspace-discovery", version: "0.0.0" },
      });
      const initialized = yield* runtime.initialize();
      const methods = Option.getOrUndefined(decodeMethods(initialized.agentCapabilities?._meta))
        ?.kiro.extensionMethods;
      if (!methods?.includes("_kiro/configuration/getState")) return undefined;
      return resourcesFromState(
        yield* runtime.request("_kiro/configuration/getState", {
          observer: "workspace",
          roots: [cwd],
        }),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOption("5 seconds"),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, crypto),
      ),
  );
  const get = Effect.fn("KiroDiscovery.get")(
    function* (cwd: string) {
      if (!settings.enabled) return undefined;
      const key = path.resolve(cwd);
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(key);
      if (cached !== undefined && cached.expiresAt > now) return cached.resources;
      const resources = yield* probe(key);
      yield* Ref.update(cache, (current) => {
        const next = new Map(current);
        next.delete(key);
        next.set(key, { resources, expiresAt: now + 5_000 });
        if (next.size > 32) {
          const oldest = next.keys().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        return next;
      });
      return resources;
    },
    (effect) => semaphore.withPermit(effect),
  );
  return { get, invalidate };
});

export function kiroDiscoveredAgentDescriptor(
  resources: WorkspaceResources,
  descriptor: ProviderOptionDescriptor | undefined,
): ProviderOptionDescriptor | undefined {
  if (resources.agentChoices.length === 0) return undefined;
  const currentValue =
    descriptor?.type === "select" &&
    resources.agentChoices.some((choice) => choice.id === descriptor.currentValue)
      ? descriptor.currentValue
      : undefined;
  return {
    id: "mode",
    label: "Agent",
    type: "select",
    options: resources.agentChoices,
    ...(currentValue === undefined ? {} : { currentValue }),
  };
}
