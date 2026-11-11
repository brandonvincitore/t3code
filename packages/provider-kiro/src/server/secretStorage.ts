import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const SecretKey = Schema.Struct({ key: Schema.String });
const SecretEntry = Schema.Struct({ key: Schema.String, value: Schema.String });
const secretStorageError = (category: "read" | "decode" | "write" | "remove") =>
  EffectAcpErrors.AcpRequestError.internalError(`Kiro secret storage ${category} failed`);

export const makeKiroSecretStorage = Effect.fn("makeKiroSecretStorage")(function* (
  environment: NodeJS.ProcessEnv,
  instanceId: string,
) {
  const host = yield* ProviderHost.ProviderHost;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const kiroHome = environment.KIRO_HOME?.trim();
  const nativeHome = path.normalize(
    kiroHome && path.isAbsolute(kiroHome)
      ? kiroHome
      : path.join(environment.HOME?.trim() || homeDirectory, ".kiro"),
  );
  const credentials = (key: string) =>
    host.credentials("kiro-mcp-oauth-v1", JSON.stringify([instanceId, nativeHome, key]));

  const get = Effect.fn("KiroSecretStorage.get")(function* (key: string) {
    const record = yield* credentials(key);
    const stored = yield* record.get.pipe(Effect.mapError(() => secretStorageError("read")));
    if (Option.isNone(stored)) return { value: null };
    const value = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(stored.value),
      catch: () => secretStorageError("decode"),
    });
    return { value };
  });
  const store = Effect.fn("KiroSecretStorage.store")(function* (key: string, value: string) {
    const record = yield* credentials(key);
    yield* record
      .set(new TextEncoder().encode(value))
      .pipe(Effect.mapError(() => secretStorageError("write")));
    return { success: true } as const;
  });
  const remove = Effect.fn("KiroSecretStorage.remove")(function* (key: string) {
    const record = yield* credentials(key);
    yield* record.remove.pipe(Effect.mapError(() => secretStorageError("remove")));
    return { success: true } as const;
  });

  // Installed before the runtime starts: Kiro reads secrets while `session/new` connects MCP servers.
  const installHandlers = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) =>
    Effect.all(
      [
        runtime.handleExtRequest("_kiro/secret/get", SecretKey, ({ key }) => get(key)),
        runtime.handleExtRequest("_kiro/secret/store", SecretEntry, ({ key, value }) =>
          store(key, value),
        ),
        runtime.handleExtRequest("_kiro/secret/delete", SecretKey, ({ key }) => remove(key)),
      ],
      { discard: true },
    );

  return { get, store, remove, installHandlers };
});
