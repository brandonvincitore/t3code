import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import { parseElicitationForm } from "@t3tools/provider-acp/server/elicitationForm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";

const KiroQuestion = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  question: Schema.String,
  options: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          title: Schema.String,
          description: Schema.optional(Schema.String),
          recommended: Schema.optional(Schema.Boolean),
          subOptionsLabel: Schema.optional(Schema.String),
          subOptions: Schema.optional(
            Schema.Array(
              Schema.Struct({
                title: Schema.String,
                description: Schema.optional(Schema.String),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
});

const KiroElicitation = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  elicitation: Schema.Unknown,
});
const decodeForm = Schema.decodeUnknownOption(
  Schema.Struct({
    mode: Schema.Literal("form"),
    message: Schema.String,
    requestedSchema: AcpSchema.ElicitationSchema,
  }),
);

function questionOptions(
  params: typeof KiroQuestion.Type,
): OrchestrationV2UserInputQuestion["options"] {
  return (params.options ?? []).flatMap((option) => {
    const title = option.title.trim();
    if (title.length === 0) return [];
    const description =
      [option.description?.trim(), option.subOptionsLabel?.trim()].filter(Boolean).join("\n") ||
      title;
    return [
      {
        label: option.recommended === true ? `${title} (Recommended)` : title,
        description,
        value: title,
      },
      ...(option.subOptions ?? []).flatMap((subOption) => {
        const subTitle = subOption.title.trim();
        if (subTitle.length === 0) return [];
        const value = `${title}: ${subTitle}`;
        return [{ label: value, description: subOption.description?.trim() || description, value }];
      }),
    ];
  });
}

export const registerKiroQuestionExtensions = Effect.fn("KiroQuestions.registerExtensions")(
  function* ({
    runtime,
    requestUserInput,
  }: Pick<AcpAdapterV2ExtensionContext, "runtime" | "requestUserInput">) {
    yield* runtime.handleExtRequest("_kiro/userInput", KiroQuestion, (params, requestContext) =>
      Effect.gen(function* () {
        if (params.question.trim().length === 0) return { action: "dismissed" };
        // Kiro drops option IDs and accepts one resolved text answer, including custom text.
        const identity = `${params.sessionId}:kiro-question:${params.toolCallId}:${requestContext.requestId}`;
        const input = yield* requestUserInput(
          {
            nativeItemId: identity,
            nativeRequestId: identity,
            activeSessionId: params.sessionId,
            questions: [
              {
                id: "answer",
                header: "Kiro",
                question: params.question.trim(),
                options: [...questionOptions(params)],
              },
            ],
          },
          requestContext,
        );
        const answer = input.answers?.answer;
        yield* input.acknowledgeNativeResponse;
        return typeof answer === "string" && answer.trim().length > 0
          ? { action: "answered", answer }
          : { action: "dismissed" };
      }),
    );
    yield* runtime.handleExtRequest(
      "_kiro/mcp/elicitation",
      KiroElicitation,
      (params, requestContext) =>
        Effect.gen(function* () {
          const decoded = decodeForm(params.elicitation);
          if (Option.isNone(decoded)) return { action: "cancel" };
          const form = parseElicitationForm(decoded.value.requestedSchema, decoded.value.message);
          if (form === undefined || form.questions.length === 0) return { action: "cancel" };
          const identity = `${params.sessionId}:kiro-elicitation:${params.toolCallId}:${requestContext.requestId}`;
          const input = yield* requestUserInput(
            {
              nativeItemId: identity,
              nativeRequestId: identity,
              activeSessionId: params.sessionId,
              questions: form.questions,
            },
            requestContext,
          );
          const content = input.answers === null ? undefined : form.content(input.answers);
          yield* input.acknowledgeNativeResponse;
          return content === undefined ? { action: "cancel" } : { action: "accept", content };
        }),
    );
  },
);
