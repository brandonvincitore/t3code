import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { KiroSettings } from "../settings.ts";
import {
  buildKiroAcpSpawnInput,
  kiroContentCollectionConfig,
  kiroSessionMeta,
  kiroWorkflowSessionMeta,
  validateKiroRuntimePolicy,
} from "./acpSupport.ts";
import { kiroAuthFromWhoami } from "./status.ts";

const decodeSettings = Schema.decodeUnknownSync(KiroSettings);

describe("KiroDriver", () => {
  it("launches the V3 ACP engine with CLI-owned auth from the configured binary", () => {
    assert.deepEqual(buildKiroAcpSpawnInput(decodeSettings({}), "/work"), {
      command: "kiro-cli",
      args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
      cwd: "/work",
      env: { KIRO_TRUST_CLASSIFIER_MODE: "off" },
    });
    const custom = buildKiroAcpSpawnInput(
      decodeSettings({ binaryPath: "/opt/kiro/bin/kiro-cli" }),
      "/work",
      { KIRO_API_KEY: "ksk_test" },
    );
    assert.equal(custom.command, "/opt/kiro/bin/kiro-cli");
    assert.deepEqual(custom.args, ["acp", "--agent-engine=v3", "--auth-method=cli"]);
    assert.deepEqual(custom.env, { KIRO_API_KEY: "ksk_test", KIRO_TRUST_CLASSIFIER_MODE: "off" });
    assert.equal(
      buildKiroAcpSpawnInput(undefined, "/work", {
        KIRO_TRUST_CLASSIFIER_MODE: "enforce",
        KIRO_HOME: "/isolated",
      }).env?.KIRO_TRUST_CLASSIFIER_MODE,
      "off",
    );
    assert.deepEqual(
      kiroWorkflowSessionMeta({
        kiro: { extensionMethods: ["_kiro/workflow/new", "_kiro/workflow/cancel"] },
      }),
      { kiro: { settings: { workflows: { enabled: true } } } },
    );
    const workflowCapabilities = {
      kiro: {
        extensionMethods: ["_kiro/workflow/new", "_kiro/workflow/cancel", "_kiro/memory/list"],
      },
    };
    for (const memoryMode of ["disabled", "read_only", "read_write"] as const) {
      assert.deepEqual(kiroSessionMeta(workflowCapabilities, decodeSettings({ memoryMode })), {
        kiro: { settings: { workflows: { enabled: true }, memory: { mode: memoryMode } } },
      });
      assert.isUndefined(kiroSessionMeta(undefined, decodeSettings({ memoryMode })));
    }
    assert.deepEqual(
      kiroSessionMeta(workflowCapabilities, decodeSettings({ memoryMode: "default" })),
      {
        kiro: { settings: { workflows: { enabled: true } } },
      },
    );
    const collection = {
      id: "contentCollection",
      name: "Content collection",
      type: "select" as const,
      currentValue: "disabled",
      options: [
        { value: "enabled", name: "Enabled" },
        { value: "disabled", name: "Disabled" },
      ],
    };
    assert.deepEqual(kiroContentCollectionConfig(decodeSettings({}), [collection]), []);
    for (const value of ["enabled", "disabled"] as const) {
      const settings = decodeSettings({ contentCollection: value });
      assert.deepEqual(kiroContentCollectionConfig(settings, [collection]), [
        { id: "contentCollection", value },
      ]);
      assert.deepEqual(kiroContentCollectionConfig(settings, []), []);
      assert.deepEqual(kiroContentCollectionConfig(settings, [{ ...collection, options: [] }]), []);
      assert.deepEqual(
        kiroContentCollectionConfig(settings, [
          { id: "contentCollection", name: "Changed type", type: "boolean", currentValue: false },
        ]),
        [],
      );
    }
    assert.isUndefined(kiroWorkflowSessionMeta(undefined));
    assert.isUndefined(
      kiroWorkflowSessionMeta({ kiro: { extensionMethods: ["_kiro/workflow/new"] } }),
    );
  });

  it.effect("rejects native Auto restrictions before process startup", () =>
    Effect.gen(function* () {
      for (const overrides of [
        { approvalPolicy: "on-request" },
        { approvalPolicy: "never" },
        { sandboxPolicy: { type: "readOnly" } },
        { sandboxPolicy: { type: "workspaceWrite" } },
        { maxRuntimeMode: "approval-required" as const },
        { maxRuntimeMode: "auto-accept-edits" as const },
        { interactionMode: "plan" },
      ]) {
        const error = yield* validateKiroRuntimePolicy({ runtimeMode: "auto", ...overrides }).pipe(
          Effect.flip,
        );
        assert.include(error.message, "cannot enforce");
      }
      for (const runtimeMode of ["approval-required", "full-access"] as const) {
        yield* validateKiroRuntimePolicy({ runtimeMode, sandboxPolicy: { type: "readOnly" } });
      }
      yield* validateKiroRuntimePolicy({ runtimeMode: "auto", maxRuntimeMode: "auto" });
      const env = { KIRO_TRUST_CLASSIFIER_MODE: "enforce", KIRO_HOME: "/isolated" };
      const spawned = buildKiroAcpSpawnInput(undefined, "/work", env, true);
      assert.equal(spawned.env?.KIRO_TRUST_CLASSIFIER_MODE, "enforce");
      assert.equal(spawned.env?.KIRO_HOME, "/isolated");
      assert.equal(
        buildKiroAcpSpawnInput(undefined, "/work", env).env?.KIRO_TRUST_CLASSIFIER_MODE,
        "off",
      );
      assert.deepEqual(env, { KIRO_TRUST_CLASSIFIER_MODE: "enforce", KIRO_HOME: "/isolated" });
    }),
  );

  // Outputs recorded from `kiro-cli whoami --format json` on Kiro CLI 2.27.0.
  it("reads the sign-in state from kiro-cli whoami", () => {
    assert.deepEqual(kiroAuthFromWhoami({ code: 1, stdout: '{"account":null}\n' }, {}), {
      status: "unauthenticated",
    });
    assert.deepEqual(
      kiroAuthFromWhoami({ code: 0, stdout: '{"accountType":"ApiKey","email":null}\n' }, {}),
      { status: "authenticated", type: "api_key", label: "Kiro API key" },
    );
    assert.deepEqual(
      kiroAuthFromWhoami(
        { code: 0, stdout: '{"accountType":"BuilderId","email":"dev@example.com"}\n' },
        {},
      ),
      { status: "authenticated", label: "Kiro account", email: "dev@example.com" },
    );
    assert.deepEqual(kiroAuthFromWhoami({ code: 2, stdout: "error: service error" }, {}), {
      status: "unknown",
    });
    assert.deepEqual(kiroAuthFromWhoami(undefined, {}), { status: "unknown" });
  });

  // Reported from Kiro CLI 2.27.1 with an IAM Identity Center login (exit 0;
  // values are placeholders, layout unchanged).
  it("keeps the account email when whoami appends an Identity Center profile", () => {
    const stdout = [
      '{"accountType":"IamIdentityCenter","email":"jane.doe@example.com","region":"us-east-1","startUrl":"https://d-0123456789.awsapps.com/start"}',
      "",
      "Profile:",
      "KiroProfile-us-east-1",
      "arn:aws:codewhisperer:us-east-1:111122223333:profile/EXAMPLE12345",
      "",
    ].join("\n");
    assert.deepEqual(kiroAuthFromWhoami({ code: 0, stdout }, {}), {
      status: "authenticated",
      label: "Kiro account",
      email: "jane.doe@example.com",
    });
  });
});
