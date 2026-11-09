import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpSchema from "effect-acp/compat";

const MAX_SKILLS = 128;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1_024;
// Anchored and unambiguous (`\s*` then a literal `$`), so it scans the text once.
const LEADING_MENTION = /^\s*\$(\S+)/;

export type KiroSkills = SubscriptionRef.SubscriptionRef<
  ReadonlyMap<string, ReadonlyArray<ServerProviderSkill>>
>;

const workspaceKey = (cwd: string | undefined) => (cwd === undefined ? "" : cwd);

export const makeKiroSkills = (): Effect.Effect<KiroSkills> =>
  SubscriptionRef.make<ReadonlyMap<string, ReadonlyArray<ServerProviderSkill>>>(new Map());

export const getKiroSkills = (
  skills: KiroSkills,
  cwd?: string,
  fallback: ReadonlyArray<ServerProviderSkill> = [],
) =>
  SubscriptionRef.get(skills).pipe(
    Effect.map((current) => current.get(workspaceKey(cwd)) ?? fallback),
  );

const decodeKiroSkillMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    kiro: Schema.Struct({
      type: Schema.Literal("skill"),
      resource: Schema.optional(
        Schema.Struct({
          source: Schema.optional(
            Schema.Struct({
              origin: Schema.optional(Schema.Unknown),
              root: Schema.optional(Schema.Unknown),
            }),
          ),
        }),
      ),
    }),
  }),
);

// The store is shared by every project, so a skill Kiro scopes to one workspace stays out.
const isKiroGlobalSkill = (meta: unknown) =>
  Option.match(decodeKiroSkillMeta(meta), {
    onNone: () => false,
    onSome: ({ kiro }) => {
      const source = kiro.resource?.source;
      return source?.origin !== "workspace" && source?.root === undefined;
    },
  });

function kiroSkillsFromCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  cwd?: string,
): ReadonlyArray<ServerProviderSkill> {
  const seen = new Set<string>();
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    if (skills.length === MAX_SKILLS) break;
    const meta = Option.getOrUndefined(decodeKiroSkillMeta(command._meta));
    if (meta === undefined || (cwd === undefined && !isKiroGlobalSkill(command._meta))) continue;
    const root = meta.kiro.resource?.source?.root;
    if (
      meta.kiro.resource?.source?.origin === "workspace" &&
      typeof root === "string" &&
      cwd !== undefined &&
      workspaceKey(root) !== workspaceKey(cwd)
    )
      continue;
    const { name } = command;
    if (name.length === 0 || name.length > MAX_NAME_LENGTH || name !== name.trim()) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = command.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    skills.push({
      name,
      ...(description ? { description } : {}),
      path: `acp://skill/${encodeURIComponent(name)}`,
      scope: meta.kiro.resource?.source?.origin === "workspace" ? "project" : "agent",
      enabled: true,
    });
  }
  return skills;
}

/** Each workspace advertisement replaces its prior list, including removals. */
export const recordKiroSkills = (
  skills: KiroSkills,
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  cwd?: string,
): Effect.Effect<void> =>
  SubscriptionRef.update(skills, (current) => {
    const incoming = kiroSkillsFromCommands(commands, cwd);
    const key = workspaceKey(cwd);
    if (JSON.stringify(current.get(key)) === JSON.stringify(incoming)) return current;
    const next = new Map(current);
    next.delete(key);
    next.set(key, incoming);
    // Keep recent projects without retaining every workspace visited for the server's lifetime.
    if (next.size > 64) {
      const oldest = next.keys().next().value;
      if (oldest !== undefined) next.delete(oldest);
    }
    return next;
  });

/**
 * Kiro runs a command only from a leading `/name`, while T3's `$` picker
 * inserts `$name`. Only advertised skills are rewritten, so `$25` stays text.
 */
export const kiroSkillCommandText = (
  skills: KiroSkills,
  text: string,
  cwd?: string,
): Effect.Effect<string> => {
  const match = LEADING_MENTION.exec(text);
  const name = match?.[1];
  if (match === null || name === undefined) return Effect.succeed(text);
  return getKiroSkills(skills, cwd).pipe(
    Effect.map((current) =>
      current.some((skill) => skill.name === name)
        ? `/${name}${text.slice(match[0].length)}`
        : text,
    ),
  );
};
