import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const WorkflowConfigTemplate = Schema.Struct({
  configOptions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.optional(Schema.NullOr(Schema.String)),
      type: Schema.String,
      currentValue: Schema.optional(Schema.Unknown),
      options: Schema.optional(
        Schema.Array(
          Schema.Struct({
            value: Schema.String,
            name: Schema.String,
            description: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});
const decodeWorkflowConfigTemplate = Schema.decodeUnknownOption(WorkflowConfigTemplate);

export function kiroWorkflowPreferenceDescriptor(
  template: unknown,
): ProviderOptionDescriptor | undefined {
  const decoded = Option.getOrUndefined(decodeWorkflowConfigTemplate(template));
  const preference = decoded?.configOptions.find(
    (option) => option.id === "workflowLaunch" && option.type === "select",
  );
  if (preference === undefined) return undefined;

  const choices = (preference.options ?? []).flatMap((choice) => {
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
            ...(preference.currentValue === id ? { isDefault: true } : {}),
          },
        ];
  });
  if (choices.length < 2) return undefined;

  const currentValue =
    typeof preference.currentValue === "string" &&
    choices.some((choice) => choice.id === preference.currentValue)
      ? preference.currentValue
      : undefined;
  return {
    id: "workflowLaunch",
    label: preference.name.trim() || "Workflow use",
    type: "select",
    options: choices,
    ...(preference.description?.trim() ? { description: preference.description.trim() } : {}),
    ...(currentValue === undefined ? {} : { currentValue }),
  };
}
