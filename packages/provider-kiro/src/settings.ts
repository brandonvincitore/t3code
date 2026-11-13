import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const KiroSettings = makeProviderSettingsSchema(
  {
    // Off by default like Grok: users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("kiro-cli").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Kiro CLI binary.",
        providerSettingsForm: { placeholder: "kiro-cli", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    memoryMode: Schema.Literals(["default", "disabled", "read_only", "read_write"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("default")),
      Schema.annotateKey({
        title: "Memory access",
        description:
          "Use Kiro's default, disable memory, allow recall only, or allow learning. Applies to new or reopened sessions.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "default", label: "Kiro default" },
            { value: "disabled", label: "Off" },
            { value: "read_only", label: "Recall only" },
            { value: "read_write", label: "Learn and recall" },
          ],
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "memoryMode"],
  },
);
export type KiroSettings = typeof KiroSettings.Type;
